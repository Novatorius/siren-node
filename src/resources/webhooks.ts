import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureVerificationError } from '../errors';
import type { HttpClient } from '../http';
import type {
  CreatedWebhookSubscription,
  CreateWebhookSubscriptionParams,
  WebhookEvent,
  WebhookHeaders,
  WebhookSubscription,
} from '../types';

const SIGNATURE_PREFIX = 'sha256=';
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

function readHeader(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value == null || value === '' ? undefined : value;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first == null || first === '' ? undefined : first;
  }
  return undefined;
}

/**
 * Whether a body is the envelope Siren sends to a subscription bound to a
 * connected site's Property: `{ version, id, type, data, records, ... }`.
 * Every other subscription receives the event payload itself as the body.
 */
function isPropertyEnvelope(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.version === 'number' &&
    typeof parsed.type === 'string' &&
    !!parsed.data &&
    typeof parsed.data === 'object' &&
    !Array.isArray(parsed.data)
  );
}

function computeDigest(rawBody: string | Uint8Array, secret: string): Buffer {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', secret).update(bytes).digest();
}

/** Manage webhook subscriptions (`/webhooks`). */
export class WebhookSubscriptionsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Register a URL to receive event callbacks.
   *
   * The response's `signingSecret` is returned exactly once — store it to
   * verify future deliveries. This write is never auto-retried.
   */
  create(params: CreateWebhookSubscriptionParams): Promise<CreatedWebhookSubscription> {
    return this.http.requestData<CreatedWebhookSubscription>({
      method: 'POST',
      path: '/webhooks',
      body: params,
      retriable: false,
    });
  }

  /** List webhook subscriptions. */
  list(): Promise<WebhookSubscription[]> {
    return this.http.requestData<WebhookSubscription[]>({
      method: 'GET',
      path: '/webhooks',
      retriable: true,
    });
  }

  /** Delete a webhook subscription. */
  async delete(id: number): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: `/webhooks/${encodeURIComponent(String(id))}`,
      retriable: true,
    });
  }
}

/**
 * Webhook signature verification plus subscription management.
 *
 * Siren signs every delivery with
 * `X-Siren-Signature: sha256=<hex hmac-sha256(rawBody, signingSecret)>`.
 * Verification MUST run against the exact raw bytes received — a
 * re-serialized object will not produce the same HMAC.
 *
 * The body is the event payload itself. The event type and the delivery id
 * travel in the `X-Siren-Event` and `X-Siren-Delivery` headers.
 */
export class WebhooksResource {
  readonly subscriptions: WebhookSubscriptionsResource;

  constructor(http: HttpClient) {
    this.subscriptions = new WebhookSubscriptionsResource(http);
  }

  /**
   * Verify a delivery's signature and parse the event — call this in your
   * webhook handler.
   *
   * @param rawBody The exact raw request body bytes (string or Buffer). Do
   *   NOT pass a re-parsed/re-serialized object.
   * @param signatureHeader The `X-Siren-Signature` header value.
   * @param secret The subscription's signing secret.
   * @param headers The request headers (a Fetch `Headers` object or Node's
   *   `req.headers`). The event type and delivery id are read from
   *   `X-Siren-Event` and `X-Siren-Delivery`. A delivery whose body is the
   *   bare payload is refused without them. A connected site's envelope
   *   names its own type and id.
   * @throws {SignatureVerificationError} when the header is missing, the
   *   signature does not match, the body is not a JSON object, or a bare
   *   payload arrives without the `X-Siren-Event` header.
   */
  constructEvent(
    rawBody: string | Uint8Array,
    signatureHeader: string | null | undefined,
    secret: string,
    headers?: WebhookHeaders,
  ): WebhookEvent {
    if (signatureHeader == null || signatureHeader === '') {
      throw new SignatureVerificationError(
        'Missing X-Siren-Signature header. Was the request really sent by Siren?',
      );
    }
    if (!this.verifySignature(rawBody, signatureHeader, secret)) {
      throw new SignatureVerificationError(
        'Webhook signature verification failed. Make sure you are passing the raw request ' +
          'body (exact bytes received) and the correct signing secret.',
      );
    }

    const text =
      typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new SignatureVerificationError('The webhook payload is not valid JSON.', { cause });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SignatureVerificationError('The webhook payload must be a JSON object.');
    }
    const body = parsed as Record<string, unknown>;
    const envelope = isPropertyEnvelope(body);

    let type = readHeader(headers, 'x-siren-event')?.trim() || undefined;
    let deliveryId = readHeader(headers, 'x-siren-delivery');
    if (envelope) {
      type ??= body.type as string;
      if (deliveryId === undefined && typeof body.id === 'string') deliveryId = body.id;
    }

    // A plain subscription's body never names its event. Without the
    // X-Siren-Event header there is nothing to dispatch on, so refuse the
    // delivery loudly rather than return an event with an empty type that
    // matches no handler. Code written for 0.1.0 passes no headers.
    if (type === undefined) {
      throw new SignatureVerificationError(
        "Siren names this delivery's event in the X-Siren-Event header, and the body does not " +
          'carry it. Pass the request headers as the fourth argument to constructEvent.',
      );
    }

    const event: WebhookEvent = {
      type,
      data: envelope ? (body.data as Record<string, unknown>) : body,
      body,
    };
    if (deliveryId !== undefined) event.deliveryId = deliveryId;
    return event;
  }

  /**
   * Constant-time signature check for callers that parse the body themselves.
   * Returns `false` for a missing/malformed header or a mismatched HMAC.
   */
  verifySignature(
    rawBody: string | Uint8Array,
    signatureHeader: string | null | undefined,
    secret: string,
  ): boolean {
    if (signatureHeader == null || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
      return false;
    }
    const provided = signatureHeader.slice(SIGNATURE_PREFIX.length).trim();
    if (!HEX_DIGEST_PATTERN.test(provided)) return false;

    const expected = computeDigest(rawBody, secret);
    const providedBytes = Buffer.from(provided, 'hex');
    if (providedBytes.length !== expected.length) return false;
    return timingSafeEqual(providedBytes, expected);
  }
}
