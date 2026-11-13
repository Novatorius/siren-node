import { ownOption, resolveTimeout } from '../client';
import { SirenError } from '../errors';
import type { HttpTransport } from '../http';
import { parseJsonBody } from '../http';
import { EventSlug } from '../taxonomy';
import type { EventResult, IngestOptions, RefundParams, SaleParams, SiteVisitedParams } from '../types';
import { ForwardedEventSlug as ForwardedSlugs } from '../connect/forwarded-events';
import type { ForwardOptions, ForwardedEventEnvelope, ForwardedEventSlug } from '../connect/forwarded-events';

/** The 28 slugs `forward` sends. Any other slug would become a custom event. */
const FORWARDED_SLUGS: ReadonlySet<string> = new Set(Object.values(ForwardedSlugs));

/** A UUID as `EventWireFormat` reads one, any version, either case. */
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An HTTP header name, an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A character a header value never holds: a C0 or C1 control, DEL, or anything above U+00FF. */
const HEADER_VALUE_REFUSED = /[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/;

/** ISO 8601 to the second, up to microseconds, with `Z` or a `+hh:mm` offset. */
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

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
 */
export class EventsResource {
  constructor(private readonly http: HttpTransport) {}

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
    return this.send(EventSlug.Sale, payload, params.externalId != null);
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
   *
   * `options.headers` go out on the send, and on the one resend after a 401,
   * beneath the SDK's own: a name that matches `Authorization`, `Accept`,
   * `User-Agent` or `Content-Type` in any case is dropped. A connected site
   * sends a referral visit with the tracking value the shopper already holds,
   * a signed token as `X-Siren-Token` or a bare opportunity id as
   * `X-Siren-Oid`, so Siren adds the visit to that opportunity.
   *
   * `options.timeout` is the milliseconds each send of this call may take,
   * from 1 to 2147483647, in place of the client's `timeout`.
   *
   * Throws `SirenError`, and sends nothing, when `options` is not an object,
   * `headers` is not an object, a header name is not an HTTP token, a header
   * value is not a string or holds a control character or a character above
   * U+00FF, or `timeout` is out of range. No message quotes a header. Only
   * the object's own `headers` and `timeout` are read.
   */
  async ingest(slug: string, payload: Record<string, unknown>, options?: IngestOptions): Promise<EventResult> {
    if (options === undefined) return this.send(slug, payload, false);
    const given: unknown = options;
    if (!isPlainObject(given)) {
      throw new SirenError('Siren: events.ingest takes its options as an object.');
    }
    const headers = ingestHeaders(ownOption(given, 'headers'));
    const timeout = ownOption(given, 'timeout');
    return this.send(slug, payload, false, headers, timeout === undefined ? undefined : resolveTimeout(timeout));
  }

  /**
   * Forward an event a connected site recorded, in Siren's versioned
   * envelope, to `POST /event/{slug}`. The token needs `connect:ingest`, or
   * an API key the exact `event:{slug}` scope.
   *
   * The body is the envelope as given, and the answer is read as every
   * event's is, so a 2xx whose body has no readable `status` resolves
   * without one. Cloud counts any 2xx as delivered.
   *
   * Sent once, whatever the answer and whatever the client's `maxRetries`.
   * After a 401 with an `AccessTokenSource` it sends again with a refreshed
   * token, carrying the same headers, `X-Siren-Final-Attempt` included, and
   * only then, as the transport does for every call.
   *
   * A forwarded event is queue work, and the site's outbox owns redelivery.
   * The site mints `eventId` once, when it records the event, and keeps it
   * with the event, because a slug with no natural key is claimed on
   * `eventId` alone and a fresh id on each try records the event twice. The
   * outbox resends with that same `eventId`, which Cloud claims once, on
   * the event's natural key or on `eventId`, and answers as `duplicate`,
   * which the outbox counts as delivered. The claim is scoped to the credential's Property, so every try of one event
   * must use the same credential. A 500 whose `error.context.reason` is
   * `waiting_for_record` raises `ApiError`, and a 404 `reference_not_found`
   * raises `NotFoundError`, each with that reason in `data`, and the outbox
   * tries the event again later. `finalAttempt: true` adds the header
   * `X-Siren-Final-Attempt: 1` to that one send, and no other call sends it.
   *
   * Throws `SirenError`, and sends nothing, when `slug` is not a
   * `ForwardedEventSlug` value, so a typo never becomes a custom event, or
   * when the envelope breaks a rule Cloud checks before it reads `data`:
   * `version` other than 1, `eventId` not a UUID, `origin` other than
   * `site`, `occurredAt` neither `null` nor ISO 8601 with a `Z` or
   * `+hh:mm` offset, or `data` not a plain object. No message quotes a value
   * from `data`.
   */
  async forward<S extends ForwardedEventSlug>(
    slug: S,
    envelope: ForwardedEventEnvelope<S>,
    options: ForwardOptions = {},
  ): Promise<EventResult> {
    if (typeof slug !== 'string' || !FORWARDED_SLUGS.has(slug)) {
      throw new SirenError('Siren: events.forward takes a ForwardedEventSlug value. Send a custom event with events.ingest.');
    }
    const given: unknown = envelope;
    if (!isPlainObject(given)) {
      throw new SirenError('Siren: events.forward takes the envelope as an object.');
    }
    if (given.version !== 1) {
      throw new SirenError('Siren: a forwarded event envelope has version 1.');
    }
    if (typeof given.eventId !== 'string' || !EVENT_ID.test(given.eventId)) {
      throw new SirenError('Siren: a forwarded event envelope needs an eventId that is a UUID.');
    }
    if (given.origin !== 'site') {
      throw new SirenError("Siren: a forwarded event envelope has origin 'site'.");
    }
    if (given.occurredAt !== null && (typeof given.occurredAt !== 'string' || !OCCURRED_AT.test(given.occurredAt))) {
      throw new SirenError('Siren: a forwarded event envelope needs occurredAt as null or ISO 8601 with a Z or +hh:mm offset.');
    }
    if (!isPlainObject(given.data)) {
      throw new SirenError('Siren: a forwarded event envelope needs data as a plain object.');
    }
    const headers = options?.finalAttempt === true ? { 'X-Siren-Final-Attempt': '1' } : undefined;
    return this.send(slug, envelope, false, headers);
  }

  /**
   * POST `payload` to `/event/{slug}`. `retriable` says whether the transport
   * may resend it on a network error, 429 or 5xx. `headers` go out beneath
   * the SDK's own on every send of this call, and `timeout`, when given,
   * replaces the client's for every send of this call.
   */
  private async send(
    slug: string,
    payload: unknown,
    retriable: boolean,
    headers?: Record<string, string>,
    timeout?: number,
  ): Promise<EventResult> {
    const response = await this.http.request({
      method: 'POST',
      path: `/event/${encodeURIComponent(slug)}`,
      body: payload,
      retriable,
      ...(headers !== undefined ? { headers } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
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

/**
 * The headers `ingest` sends, copied from the caller's own entries, or
 * `undefined` when none were given. Throws `SirenError`, quoting no header,
 * when `given` is not an object or holds a name or value a request cannot
 * carry.
 */
function ingestHeaders(given: unknown): Record<string, string> | undefined {
  if (given === undefined) return undefined;
  if (!isPlainObject(given)) {
    throw new SirenError('Siren: events.ingest takes headers as an object of header names to text values.');
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(given)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || HEADER_VALUE_REFUSED.test(value)) {
      throw new SirenError(
        'Siren: events.ingest takes each header name as an HTTP token and each value as text with no control character and no character above U+00FF.',
      );
    }
    headers[name] = value;
  }
  return headers;
}

/** Whether `value` is an object that is not an array, as a JSON object decodes. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
