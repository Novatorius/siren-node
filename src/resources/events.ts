import type { HttpClient } from '../http';
import { parseJsonBody } from '../http';
import { EventSlug } from '../taxonomy';
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
 * Sales and refunds retry on network errors and 429/5xx up to the client's
 * `maxRetries`. Siren answers a resent sale with the first result and
 * records each `refundId` once per order, so a retry records nothing new.
 * Three sends go out once, because Siren has no key to match a resent copy,
 * and a retry after a lost reply would record the event twice: a site visit,
 * which Siren records every time it arrives, a custom event sent through
 * `ingest`, whatever its slug, and a sale with no `externalId`, which Siren
 * gives a random id when it is a test and refuses when it is not.
 *
 * Stub: slice 1 packet P10 makes `ingest` and a sale with no `externalId`
 * go out once. Until then both are marked retriable.
 */
export class EventsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Record a completed sale so conversions and payouts compute.
   *
   * `total` is in major currency units (9.99 = $9.99). When `items` are
   * supplied, reward pools compute `amount x quantity` per line; a missing
   * `quantity` defaults to 1.
   *
   * A sale whose `externalId` is missing or `null` is sent once, whatever
   * `test` holds. Siren gives a test sale with no id a random one, so a
   * resent copy would record a second test, and it refuses a real sale with
   * no id. Every sale that carries an `externalId`, an empty one included,
   * retries, since Siren matches it by `source` and `externalId`.
   */
  sale(params: SaleParams): Promise<EventResult> {
    const { items, ...rest } = params;
    const payload: Record<string, unknown> = { ...rest };
    if (items !== undefined) {
      payload.items = items.map((item) => ({ ...item, quantity: item.quantity ?? 1 }));
    }
    return this.send(EventSlug.Sale, payload, true);
  }

  /**
   * Record a refund of a previously recorded sale, matched by
   * `(externalId, source)`, and named by `refundId`, the store's own id for
   * this refund. Siren records each refund id once per order. Rejects with
   * `NotFoundError` when no matching sale exists.
   */
  refund(params: RefundParams): Promise<EventResult> {
    return this.send(EventSlug.Refund, params, true);
  }

  /**
   * Record a referred visit, opening an opportunity for the collaborator.
   * Sent once, never retried, because Siren records every visit it receives.
   */
  siteVisited(params: SiteVisitedParams): Promise<EventResult> {
    return this.send(EventSlug.SiteVisited, params, false);
  }

  /**
   * Ingest a custom event type registered on your organization. `payload`
   * is passed through unchanged as the JSON body.
   *
   * Sent once, never retried, whatever the slug. Siren has no key to match a
   * resent custom event, so a retry after a lost reply would record it twice.
   * This also keeps `ingest('site-visited', ...)` to the same rule as
   * `siteVisited`.
   */
  ingest(slug: string, payload: Record<string, unknown>): Promise<EventResult> {
    return this.send(slug, payload, true);
  }

  /**
   * POST `payload` to `/event/{slug}`. `retriable` says whether the transport
   * may resend it on a network error, 429 or 5xx.
   */
  private async send(slug: string, payload: unknown, retriable: boolean): Promise<EventResult> {
    const response = await this.http.request({
      method: 'POST',
      path: `/event/${encodeURIComponent(slug)}`,
      body: payload,
      retriable,
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
