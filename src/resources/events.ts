import type { HttpClient } from '../http';
import { parseJsonBody } from '../http';
import type { EventResult, RefundParams, SaleParams, SiteVisitedParams } from '../types';

/**
 * Event ingestion — the primary integration point. Wraps `POST /event/{slug}`.
 *
 * Every method resolves to an `EventResult`. `opportunityId` comes from the
 * `X-Siren-OID` response header, or from the body when the header is absent.
 * Sales and site visits also return a body that says what Siren did, exposed
 * as `status` and `body`. While the organization's engine is paused, Siren
 * queues the event and answers 202, which sets `queued: true`.
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
    const result: EventResult = {};

    const oid = response.headers.get('x-siren-oid');
    if (oid != null && oid !== '') {
      const opportunityId = Number(oid);
      if (Number.isFinite(opportunityId)) result.opportunityId = opportunityId;
    }

    const body = await parseJsonBody(response);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const outcome = body as Record<string, unknown>;
      result.body = outcome;
      if (typeof outcome.status === 'string') result.status = outcome.status;
      if (outcome.queued === true || response.status === 202) result.queued = true;
      if (
        result.opportunityId === undefined &&
        typeof outcome.opportunityId === 'number' &&
        Number.isFinite(outcome.opportunityId)
      ) {
        result.opportunityId = outcome.opportunityId;
      }
    } else if (response.status === 202) {
      result.queued = true;
    }

    return result;
  }
}
