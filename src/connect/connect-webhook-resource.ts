import { SirenError, UnexpectedResponseError } from '../errors';
import { parseJsonBody } from '../http';
import type { HttpMethod, HttpTransport } from '../http';
import type {
  ConnectorWebhook,
  ConnectorWebhookDelivery,
  ConnectorWebhookParams,
  ConnectorWebhookWithSecret,
  WebhookTestResult,
} from './types';

/** The nonce pattern Cloud's `TestConnectorWebhook` checks. */
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

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
  constructor(private readonly http: HttpTransport) {}

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
    const answer = await this.send<ConnectorWebhookWithSecret>(
      'PUT',
      '/connect/webhook',
      { targetUrl: params.targetUrl, events: params.events },
      false,
      'object',
    );
    if (typeof answer.signingSecret !== 'string' || answer.signingSecret === '') {
      throw new UnexpectedResponseError('Siren: Cloud answered PUT /connect/webhook without a signingSecret.');
    }
    return answer;
  }

  /**
   * `GET /connect/webhook`, retried as a read. Resolves with the JSON object
   * Cloud sent. Cloud answers 404 when the site has no subscription, which
   * raises `NotFoundError`.
   */
  async get(): Promise<ConnectorWebhook> {
    return this.send<ConnectorWebhook>('GET', '/connect/webhook', undefined, true, 'object');
  }

  /**
   * `DELETE /connect/webhook`, retried, because a repeat removes nothing
   * more. Resolves with `{ deleted }`. `deleted: false` means the site had
   * no webhook left to remove, which is also what a retry after a lost
   * answer meets, so it counts as success.
   */
  async delete(): Promise<{ deleted: boolean }> {
    return this.send<{ deleted: boolean }>('DELETE', '/connect/webhook', undefined, true, 'object');
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
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
      throw new SirenError('Siren: the webhook test nonce must be 16 to 128 letters, digits, hyphens or underscores.');
    }
    return this.send<WebhookTestResult>('POST', '/connect/webhook/test', { nonce }, false, 'object');
  }

  /**
   * `GET /connect/webhook/deliveries`, retried as a read. Resolves with the
   * JSON array Cloud sent, newest first. A 2xx body that is not an array
   * raises `UnexpectedResponseError`.
   */
  async deliveries(): Promise<ConnectorWebhookDelivery[]> {
    return this.send<ConnectorWebhookDelivery[]>('GET', '/connect/webhook/deliveries', undefined, true, 'array');
  }

  /**
   * Sends one route and answers its parsed body when the body is the JSON
   * shape named, an array or an object that is not an array. Any other 2xx
   * body raises `UnexpectedResponseError` with the status only, so no secret
   * from the body reaches the error.
   */
  private async send<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    retriable: boolean,
    shape: 'object' | 'array',
  ): Promise<T> {
    const response = await this.http.request({ method, path, body, retriable });
    const parsed = await parseJsonBody(response);
    const ok =
      shape === 'array'
        ? Array.isArray(parsed)
        : typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    if (!ok) {
      throw new UnexpectedResponseError(`Siren: Cloud answered ${method} ${path} with a body that is not a JSON ${shape}.`, {
        statusCode: response.status,
      });
    }
    return parsed as T;
  }
}
