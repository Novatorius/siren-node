import { ownOption, resolveTimeout } from '../client';
import { SirenError } from '../errors';
import type { HttpTransport } from '../http';
import { parseJsonBody } from '../http';
import { EventSlug } from '../taxonomy';
import type {
  BrowserToken,
  BrowserTokenHandlerOptions,
  EventResult,
  IngestOptions,
  RefundParams,
  SaleParams,
  SiteVisitedParams,
} from '../types';
import type { AccessTokenSource } from '../auth/access-token-source';
import { ForwardedEventSlug as ForwardedSlugs } from '../connect/forwarded-events';
import type { ForwardOptions, ForwardedEventEnvelope, ForwardedEventSlug } from '../connect/forwarded-events';

/** The 28 slugs `forward` sends. Any other slug would become a custom event. */
const FORWARDED_SLUGS: ReadonlySet<string> = new Set(Object.values(ForwardedSlugs));

/** Siren's built-in event slugs, which keep sending with the client's own credential. */
const BUILT_IN_SLUGS: ReadonlySet<string> = new Set(Object.values(EventSlug));

/** A custom event's key, as Siren's event route reads one. */
const EVENT_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/** The most bytes `browserTokenHandler` reads of a request body. */
const HANDLER_BODY_LIMIT = 4096;

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
   * A client built with `apiKey` sends a custom event, any slug other than
   * `sale`, `refund`, `site-visited` and the forwarded slugs, with a
   * short-lived app token, since Siren takes only the owning app's token
   * there. The SDK trades the key for one at `POST /oauth/token` the first
   * time, keeps it, gets a new one when fewer than two minutes are left, and
   * after a 401 gets a new one and sends once more. A key that belongs to no
   * app sends with the key as before. The caller never sees a token.
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
    const tokens = this.tokensFor(slug);
    if (options === undefined) return this.send(slug, payload, false, undefined, undefined, tokens);
    const given: unknown = options;
    if (!isPlainObject(given)) {
      throw new SirenError('Siren: events.ingest takes its options as an object.');
    }
    const headers = ingestHeaders(ownOption(given, 'headers'));
    const timeout = ownOption(given, 'timeout');
    return this.send(slug, payload, false, headers, timeout === undefined ? undefined : resolveTimeout(timeout), tokens);
  }

  /**
   * A browser token for one of the app's custom events, for the app's
   * server to hand a web page: `{token, expiresIn, url}`. The page sends the
   * event to `url` with `?access_token=` and the token, from a website on
   * the event's allowed domains. The storefront module's `track` does that
   * for the page, with {@link browserTokenHandler} on the server.
   *
   * One token is kept per event and reused until fewer than 60 seconds of
   * its 10 minutes are left, so a busy page costs about one grant every nine
   * minutes.
   *
   * Throws `SirenError` when the client was built with `accessToken` rather
   * than the app's `apiKey`, or `eventKey` is not an event key. Throws
   * `BadRequestError` with code `invalid_scope` when Siren refuses the
   * event: it is not one of the app's active custom events, or it allows no
   * domain. Throws `AuthenticationError` with code `invalid_client` when
   * Siren doesn't know the key or it was revoked, and `BadRequestError`
   * with code `unauthorized_client` when the key belongs to no app.
   */
  async browserToken(eventKey: string): Promise<BrowserToken> {
    const tokens = this.http.appTokens;
    if (tokens === null) {
      throw new SirenError("Siren: events.browserToken needs a client built with the app's apiKey.");
    }
    if (typeof eventKey !== 'string' || !EVENT_KEY.test(eventKey)) {
      throw new SirenError('Siren: events.browserToken takes an event key of letters, digits, dashes and underscores.');
    }
    const { token, expiresIn } = await tokens.browserToken(eventKey);
    return { token, expiresIn, url: this.http.urlFor(`/event/${encodeURIComponent(eventKey)}`) };
  }

  /**
   * A request handler for the app's server that answers a page's request
   * for a browser token, the server half of the storefront module's
   * `track`. Mount it at `/siren/token`, where `track` asks by default:
   *
   * ```ts
   * app.post('/siren/token', siren.events.browserTokenHandler());           // Express
   * export const POST = siren.events.browserTokenHandler();                 // Next.js app route
   * export default siren.events.browserTokenHandler();                      // Next.js pages route
   * ```
   *
   * It reads the event key from a JSON body `{"event": "..."}`, or from the
   * query `?event=`. It answers 200 with {@link browserToken}'s object, 400
   * `{error}` when the event is missing, is not in `options.events` when that
   * list is given, or is one Siren refuses, and 502 `{error}` when Siren
   * can't be reached or refuses the key. Every answer is JSON with
   * `Cache-Control: no-store`.
   *
   * It takes Node's `(req, res)`, as Express and Next.js pages routes call
   * it, reading `req.body` when a body parser already read it, and a Web
   * `Request`, returning a `Response`, as Next.js app routes call it.
   */
  browserTokenHandler(options: BrowserTokenHandlerOptions = {}): BrowserTokenHandler {
    const allowed = options.events === undefined ? null : new Set(options.events);
    const answer = async (eventKey: unknown): Promise<HandlerAnswer> => {
      if (typeof eventKey !== 'string' || !EVENT_KEY.test(eventKey)) {
        return { status: 400, body: { error: 'Name the event to get a token for, as {"event": "your-event-key"}.' } };
      }
      if (allowed !== null && !allowed.has(eventKey)) {
        return { status: 400, body: { error: 'This server gives no token for that event.' } };
      }
      try {
        return { status: 200, body: await this.browserToken(eventKey) };
      } catch (error) {
        if (error instanceof SirenError && error.statusCode === 400 && error.code === 'invalid_scope') {
          return { status: 400, body: { error: error.message } };
        }
        return { status: 502, body: { error: 'Siren could not give a token just now. Try again shortly.' } };
      }
    };

    const handler = async (req: unknown, res?: unknown): Promise<Response | void> => {
      if (res === undefined && isWebRequest(req)) {
        const { status, body } = await answer(await eventFromWebRequest(req));
        return new Response(JSON.stringify(body), { status, headers: HANDLER_HEADERS });
      }
      const node = req as NodeRequestLike;
      const out = res as NodeResponseLike;
      const { status, body } = await answer(await eventFromNodeRequest(node));
      out.statusCode = status;
      for (const [name, value] of Object.entries(HANDLER_HEADERS)) out.setHeader(name, value);
      out.end(JSON.stringify(body));
    };
    return handler as BrowserTokenHandler;
  }

  /** The app's token source for a custom event's send, or undefined to send with the client's own credential. */
  private tokensFor(slug: string): AccessTokenSource | undefined {
    const tokens = this.http.appTokens;
    if (tokens === null || BUILT_IN_SLUGS.has(slug) || FORWARDED_SLUGS.has(slug)) return undefined;
    return tokens;
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
    tokens?: AccessTokenSource,
  ): Promise<EventResult> {
    const response = await this.http.request({
      method: 'POST',
      path: `/event/${encodeURIComponent(slug)}`,
      body: payload,
      retriable,
      ...(headers !== undefined ? { headers } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
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

/**
 * The handler `events.browserTokenHandler` returns. Called with a Web
 * `Request` it answers a `Response`. Called with Node's `(req, res)` it
 * writes the answer to `res`.
 */
export interface BrowserTokenHandler {
  (request: Request): Promise<Response>;
  (req: NodeRequestLike, res: NodeResponseLike): Promise<void>;
}

/** The part of Node's `IncomingMessage`, or Express's request, the handler reads. */
export interface NodeRequestLike {
  url?: string;
  body?: unknown;
  query?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

/** The part of Node's `ServerResponse` the handler writes. */
export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

interface HandlerAnswer {
  status: number;
  body: unknown;
}

const HANDLER_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

/** Whether the handler was given a Web `Request`. */
function isWebRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { url?: unknown }).url === 'string' &&
    typeof (value as { text?: unknown }).text === 'function' &&
    typeof (value as { headers?: { get?: unknown } }).headers?.get === 'function'
  );
}

/** The event key a Web `Request` names, in its JSON body or its query. */
async function eventFromWebRequest(request: Request): Promise<unknown> {
  let text = '';
  try {
    text = request.body === null ? '' : await request.text();
  } catch {
    text = '';
  }
  return eventFromBody(text.length > HANDLER_BODY_LIMIT ? '' : text) ?? eventFromUrl(request.url);
}

/** The event key a Node request names, in its parsed or raw body, or its query. */
async function eventFromNodeRequest(req: NodeRequestLike): Promise<unknown> {
  let fromBody: unknown;
  if (req.body !== undefined) {
    fromBody = typeof req.body === 'string' ? eventFromBody(req.body) : eventOf(req.body);
  } else if (typeof req[Symbol.asyncIterator] === 'function') {
    fromBody = eventFromBody(await readLimited(req as AsyncIterable<unknown>));
  }
  if (fromBody !== undefined) return fromBody;
  if (isPlainObject(req.query) && req.query.event !== undefined) return req.query.event;
  return typeof req.url === 'string' ? eventFromUrl(req.url) : undefined;
}

/** Reads a Node request body as text, giving up past {@link HANDLER_BODY_LIMIT} bytes. */
async function readLimited(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: string[] = [];
  let size = 0;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    size += text.length;
    if (size > HANDLER_BODY_LIMIT) return '';
    chunks.push(text);
  }
  return chunks.join('');
}

function eventFromBody(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return eventOf(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function eventOf(body: unknown): unknown {
  return isPlainObject(body) ? body.event : undefined;
}

function eventFromUrl(url: string): unknown {
  try {
    return new URL(url, 'http://localhost').searchParams.get('event') ?? undefined;
  } catch {
    return undefined;
  }
}
