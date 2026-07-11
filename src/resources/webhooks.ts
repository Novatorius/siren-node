import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureVerificationError } from '../errors';
import type { HttpClient } from '../http';
import type {
  CreatedWebhookSubscription,
  CreateWebhookSubscriptionParams,
  WebhookEvent,
  WebhookSubscription,
} from '../types';

const SIGNATURE_PREFIX = 'sha256=';
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

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
   * @throws {SignatureVerificationError} when the header is missing or the
   *   signature does not match.
   */
  constructEvent(
    rawBody: string | Uint8Array,
    signatureHeader: string | null | undefined,
    secret: string,
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
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const event: WebhookEvent = {
      type: typeof parsed.type === 'string' ? parsed.type : '',
      data:
        parsed.data && typeof parsed.data === 'object'
          ? (parsed.data as Record<string, unknown>)
          : {},
    };
    if (typeof parsed.deliveryId === 'string') event.deliveryId = parsed.deliveryId;
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
