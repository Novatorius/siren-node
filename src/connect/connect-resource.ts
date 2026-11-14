import { UnexpectedResponseError } from '../errors';
import { parseJsonBody } from '../http';
import type { HttpMethod, HttpTransport } from '../http';
import { ConnectWebhookResource } from './connect-webhook-resource';
import type {
  ConnectPlan,
  ConnectUpdateGrant,
  CustomerEmailKey,
  DisconnectResult,
  MigrationWindow,
  PingResult,
  ProductSyncParams,
  ProductSyncResult,
  ReportedIntegration,
  SiteStateParams,
  SiteStateReport,
} from './types';

/**
 * Standard base64 with its padding, as PHP's `base64_encode` writes it. No
 * `-` or `_`, so a base64url key is refused.
 */
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The shortest customer email key a site may hash with, in bytes. */
const MIN_EMAIL_KEY_BYTES = 16;

/**
 * The connected-site routes, `/connect/*` and `/ping`, sent with the site's
 * OAuth access token. Each method names the `ConnectScope` its route needs.
 * Cloud answers a token without it with 403, raised as `MissingScopeError`.
 *
 * Every method follows the transport's rules: one resend with a refreshed
 * token after the first 401, and retries on network errors, 429 and 5xx for
 * the methods marked retried. The reads and `updateGrant` are retried,
 * because a repeat changes nothing and a site calls them inline, while a
 * person waits or as a task starts. A store that calls one from its own
 * queue builds its client with `maxRetries: 0`, so the queue's tries are
 * the only ones. The three reports (`reportSiteState`,
 * `reportIntegrations`, `syncProducts`) are sent once: a site sends them
 * from its task queue, which owns redelivery, so an inline retry would
 * multiply every queue try. `disconnect` is sent once, because Cloud cuts
 * the client off as it commits and answers a resend with 401. A 2xx whose
 * body is not a JSON object raises `UnexpectedResponseError`, and its
 * message quotes none of the body.
 */
export class ConnectResource {
  /** The site's own webhook subscription. Needs `connect:webhooks`. */
  readonly webhook: ConnectWebhookResource;

  constructor(private readonly http: HttpTransport) {
    this.webhook = new ConnectWebhookResource(http);
  }

  /**
   * `GET /connect/plan`, `connect:read`. The organization's plan, trial and
   * capabilities. Cloud answers 503 with code `plan_unavailable` when it
   * cannot read billing, which raises `ApiError` with that code, so the
   * store logs the error and keeps what it last knew.
   */
  async plan(): Promise<ConnectPlan> {
    return (await this.object('GET', '/connect/plan', undefined, true)) as unknown as ConnectPlan;
  }

  /**
   * `POST /connect/update-grant`, `connect:read`, no body. A short-lived
   * signed grant the site's updater sends to fetch a paid build. Retried:
   * each send signs a new grant and records nothing. A 2xx without a
   * non-empty text `grant` raises `UnexpectedResponseError`, which quotes
   * no part of the answer.
   */
  async updateGrant(): Promise<ConnectUpdateGrant> {
    const answer = await this.object('POST', '/connect/update-grant', undefined, true);
    if (!isFilled(answer.grant)) throw unexpected('POST', '/connect/update-grant', 'a non-empty text grant');
    return answer as unknown as ConnectUpdateGrant;
  }

  /**
   * `PUT /connect/site-state`, `connect:read`, with body `{ forwarding }`
   * plus each of `cutOverAt`, `localDataDeletedAt` and `migrationComplete`
   * that is not `undefined`. Sent once. The site's queue reports again.
   */
  async reportSiteState(params: SiteStateParams): Promise<SiteStateReport> {
    const body = withDefined(
      { forwarding: params.forwarding },
      { cutOverAt: params.cutOverAt, localDataDeletedAt: params.localDataDeletedAt, migrationComplete: params.migrationComplete },
    );
    return (await this.object('PUT', '/connect/site-state', body, false)) as unknown as SiteStateReport;
  }

  /**
   * `PUT /connect/integrations`, `connect:records:write`, with body
   * `{ integrations }`: the whole list, up to 50, which replaces the one
   * Cloud held. Cloud answers 204 with no body, and the promise resolves
   * with nothing. Sent once. The site's queue reports again.
   */
  async reportIntegrations(integrations: ReportedIntegration[]): Promise<void> {
    await this.http.request({ method: 'PUT', path: '/connect/integrations', body: { integrations }, retriable: false });
  }

  /**
   * `PUT /connect/products`, `connect:records:write`, with body `{ platform }`
   * plus each of `products`, `removed` and `pruneBefore` that is not
   * `undefined`. Upserts and removes up to 200 products a call. Sent once.
   * The site's queue sends the batch again. The upsert is idempotent, but
   * Cloud announces the batch's imported and deleted products on every
   * send, a resend included.
   */
  async syncProducts(params: ProductSyncParams): Promise<ProductSyncResult> {
    const body = withDefined(
      { platform: params.platform },
      { products: params.products, removed: params.removed, pruneBefore: params.pruneBefore },
    );
    return (await this.object('PUT', '/connect/products', body, false)) as unknown as ProductSyncResult;
  }

  /**
   * `POST /connect/disconnect`, `connect:read`, no body. Revokes the site's
   * client, its tokens and its webhook. After it the site's tokens are dead,
   * so discard them.
   *
   * Sent once, never retried. Cloud cuts the client off as the disconnect
   * commits, so a resend after a lost answer meets a 401 saying the
   * connection was revoked, and the store's refresh then fails with
   * `OAuthError` `invalid_grant`. A site that sent `disconnect` and then
   * meets that 401 or that `invalid_grant` treats itself as disconnected.
   */
  async disconnect(): Promise<DisconnectResult> {
    return (await this.object('POST', '/connect/disconnect', undefined, false)) as unknown as DisconnectResult;
  }

  /** `GET /connect/migration-window`, `connect:migrate`. Whether the site may still migrate, and until when. */
  async migrationWindow(): Promise<MigrationWindow> {
    return (await this.object('GET', '/connect/migration-window', undefined, true)) as unknown as MigrationWindow;
  }

  /**
   * `GET /connect/customer-email-key`, `connect:records:read`. The key the
   * site hashes customer emails with. Cloud sends it with
   * `Cache-Control: no-store`. Never log it. A 2xx raises
   * `UnexpectedResponseError` unless `keyId` is non-empty text and `secret`
   * is standard base64 of at least 16 bytes, as Siren's
   * `CloudCustomerEmailKeys` reads it, so a site never hashes with a
   * missing or weak key. That error quotes no part of the answer, in its
   * message, `data` or cause.
   */
  async customerEmailKey(): Promise<CustomerEmailKey> {
    const answer = await this.object('GET', '/connect/customer-email-key', undefined, true);
    if (!isFilled(answer.keyId) || !isEmailKey(answer.secret)) {
      throw unexpected(
        'GET',
        '/connect/customer-email-key',
        `a non-empty text keyId and a secret of at least ${MIN_EMAIL_KEY_BYTES} bytes in standard base64`,
      );
    }
    return answer as unknown as CustomerEmailKey;
  }

  /**
   * `GET /ping`, `connect:ingest`. Proves the token works, and names the
   * organization it belongs to. A token without `connect:ingest` is refused
   * with `PermissionError`.
   */
  async ping(): Promise<PingResult> {
    return (await this.object('GET', '/ping', undefined, true)) as unknown as PingResult;
  }

  /**
   * Sends one route through the transport and answers its body when it is a
   * JSON object. Any other 2xx raises `UnexpectedResponseError`, which
   * carries no part of the body.
   */
  private async object(
    method: HttpMethod,
    path: string,
    body: Record<string, unknown> | undefined,
    retriable: boolean,
  ): Promise<Record<string, unknown>> {
    const response = await this.http.request({ method, path, ...(body !== undefined ? { body } : {}), retriable });
    const answer = await parseJsonBody(response);
    if (!isJsonObject(answer)) throw unexpected(method, path, 'a JSON object');
    return answer;
  }
}

/** `required` with each entry of `optional` that is not `undefined`. */
function withDefined(required: Record<string, unknown>, optional: Record<string, unknown>): Record<string, unknown> {
  const body = { ...required };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/** A JSON object, not an array or `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string. */
function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Standard padded base64 that decodes to at least {@link MIN_EMAIL_KEY_BYTES} bytes. */
function isEmailKey(value: unknown): value is string {
  if (!isFilled(value) || !STANDARD_BASE64.test(value)) return false;
  return Buffer.from(value, 'base64').length >= MIN_EMAIL_KEY_BYTES;
}

/** The error for a 2xx without the shape a route names. It quotes none of the body. */
function unexpected(method: HttpMethod, path: string, wanted: string): UnexpectedResponseError {
  return new UnexpectedResponseError(`Siren: ${method} ${path} answered a 2xx without ${wanted}.`);
}
