import type { HttpTransport } from '../http';
import type {
  ConnectorWebhook,
  ConnectorWebhookDelivery,
  ConnectorWebhookParams,
  ConnectorWebhookWithSecret,
  WebhookTestResult,
} from './types';

/**
 * The connected site's own webhook subscription, `/connect/webhook`: the one
 * Siren Cloud delivers the site's events back through. Each route needs
 * `connect:webhooks`, which no wildcard grants. Siren's
 * `ReplaceConnectorWebhook`, `GetConnectorWebhook`, `DeleteConnectorWebhook`,
 * `TestConnectorWebhook` and `ListConnectorWebhookDeliveries`.
 *
 * Every method follows the transport's rules for status codes and errors. A
 * 2xx whose body is not the JSON shape the method names raises
 * `UnexpectedResponseError`, and its message quotes none of the body.
 */
export class ConnectWebhookResource {
  constructor(private readonly http: HttpTransport) {
    // Stub: slice 5 packet P4.
    void this.http;
  }

  /**
   * `PUT /connect/webhook` with body `{ targetUrl, events }`. Creates the
   * subscription (201) or replaces it (200), and either way answers a new
   * signing secret, shown only in this answer. Sent once, never retried:
   * each send rotates the secret, so only the caller may decide to send
   * again. Resolves with a JSON object that carries a text `signingSecret`.
   * No error it raises carries the secret from Cloud's answer.
   *
   * After a `ConnectionError` the site cannot know whether the secret
   * rotated, so it calls `replace` again before it trusts the stored secret.
   */
  async replace(params: ConnectorWebhookParams): Promise<ConnectorWebhookWithSecret> {
    // Stub: slice 5 packet P4.
    void params;
    return { id: 0, targetUrl: '', events: [], property: { id: 0, siteUrl: '' }, signingSecret: '' };
  }

  /**
   * `GET /connect/webhook`, retried as a read. Resolves with the JSON object
   * Cloud sent. Cloud answers 404 when the site has no subscription, which
   * raises `NotFoundError`.
   */
  async get(): Promise<ConnectorWebhook> {
    // Stub: slice 5 packet P4.
    return { id: 0, targetUrl: '', events: [], property: { id: 0, siteUrl: '' } };
  }

  /** `DELETE /connect/webhook`, retried: a repeat removes nothing more. Resolves with `{ deleted }`. */
  async delete(): Promise<{ deleted: boolean }> {
    // Stub: slice 5 packet P4.
    return { deleted: false };
  }

  /**
   * `POST /connect/webhook/test` with body `{ nonce }`. Cloud signs one test
   * delivery and reports what the site answered. Sent once, never retried,
   * because Cloud allows ten tests a site an hour.
   *
   * Throws `SirenError` before sending when `nonce` is not 16 to 128
   * characters of `A-Z`, `a-z`, `0-9`, `-` and `_`, the pattern Cloud
   * checks, so a malformed nonce spends none of that allowance.
   */
  async test(nonce: string): Promise<WebhookTestResult> {
    // Stub: slice 5 packet P4.
    void nonce;
    return { delivered: false, httpStatus: null, error: null };
  }

  /**
   * `GET /connect/webhook/deliveries`, retried as a read. Resolves with the
   * JSON array Cloud sent, newest first. A 2xx body that is not an array
   * raises `UnexpectedResponseError`.
   */
  async deliveries(): Promise<ConnectorWebhookDelivery[]> {
    // Stub: slice 5 packet P4.
    return [];
  }
}
