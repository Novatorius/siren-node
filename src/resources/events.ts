import type { HttpClient } from '../http';
import type { EventResult, RefundParams, SaleParams, SiteVisitedParams } from '../types';

/**
 * Event ingestion — the primary integration point. Wraps `POST /event/{slug}`.
 *
 * Every method resolves to an `EventResult` whose `opportunityId` is read
 * from the `X-Siren-OID` response header (the body is empty on success).
 *
 * Event ingestion is safe to auto-retry, so these calls retry on network
 * errors and 429/5xx up to the client's `maxRetries`.
 */
export class EventsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Record a completed sale so conversions and payouts compute.
   *
   * `total` is in major currency units (9.99 = $9.99). When `items` are
   * supplied, reward pools compute `amount x quantity` per line; a missing
   * `quantity` defaults to 1.
   */
  sale(params: SaleParams): Promise<EventResult> {
    const { items, ...rest } = params;
    const payload: Record<string, unknown> = { ...rest };
    if (items !== undefined) {
      payload.items = items.map((item) => ({ ...item, quantity: item.quantity ?? 1 }));
    }
    return this.send('sale', payload);
  }

  /**
   * Reverse a previously recorded sale, matched by `(externalId, source)`.
   * Rejects with `NotFoundError` when no matching sale exists.
   */
  refund(params: RefundParams): Promise<EventResult> {
    return this.send('refund', params);
  }

  /** Record a referred visit, opening an opportunity for the collaborator. */
  siteVisited(params: SiteVisitedParams): Promise<EventResult> {
    return this.send('site-visited', params);
  }

  /**
   * Ingest a custom event type registered on your organization. `payload`
   * is passed through unchanged as the JSON body.
   */
  ingest(slug: string, payload: Record<string, unknown>): Promise<EventResult> {
    return this.send(slug, payload);
  }

  private async send(slug: string, payload: unknown): Promise<EventResult> {
    const response = await this.http.request({
      method: 'POST',
      path: `/event/${encodeURIComponent(slug)}`,
      body: payload,
      retriable: true,
    });
    const oid = response.headers.get('x-siren-oid');
    if (oid == null || oid === '') return {};
    const opportunityId = Number(oid);
    return Number.isFinite(opportunityId) ? { opportunityId } : {};
  }
}
