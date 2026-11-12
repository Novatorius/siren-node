import type { HttpTransport } from '../http';
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
    // Stub: slice 5 packet P3.
    void this.http;
    this.webhook = new ConnectWebhookResource(http);
  }

  /**
   * `GET /connect/plan`, `connect:read`. The organization's plan, trial and
   * capabilities. Cloud answers 503 with code `plan_unavailable` when it
   * cannot read billing, which raises `ApiError` with that code, so the
   * store logs the error and keeps what it last knew.
   */
  async plan(): Promise<ConnectPlan> {
    // Stub: slice 5 packet P3.
    return {
      status: 'none',
      capabilities: [],
      trial: { active: false, plan: null, endsAt: null, ended: false },
      paidPlan: null,
      pricingUrl: '',
    };
  }

  /**
   * `POST /connect/update-grant`, `connect:read`, no body. A short-lived
   * signed grant the site's updater sends to fetch a paid build. Retried:
   * each send signs a new grant and records nothing. A 2xx without a
   * non-empty text `grant` raises `UnexpectedResponseError`, which quotes
   * no part of the answer.
   */
  async updateGrant(): Promise<ConnectUpdateGrant> {
    // Stub: slice 5 packet P3.
    return { grant: '', expiresAt: 0, expiresIn: 0 };
  }

  /**
   * `PUT /connect/site-state`, `connect:read`, with body `{ forwarding }`
   * plus each of `cutOverAt`, `localDataDeletedAt` and `migrationComplete`
   * that is not `undefined`. Sent once. The site's queue reports again.
   */
  async reportSiteState(params: SiteStateParams): Promise<SiteStateReport> {
    // Stub: slice 5 packet P3.
    void params;
    return { reported: true, forwarding: false, cutOverAt: null, localDataDeletedAt: null };
  }

  /**
   * `PUT /connect/integrations`, `connect:records:write`, with body
   * `{ integrations }`: the whole list, up to 50, which replaces the one
   * Cloud held. Cloud answers 204 with no body, and the promise resolves
   * with nothing. Sent once. The site's queue reports again.
   */
  async reportIntegrations(integrations: ReportedIntegration[]): Promise<void> {
    // Stub: slice 5 packet P3.
    void integrations;
  }

  /**
   * `PUT /connect/products`, `connect:records:write`, with body `{ platform }`
   * plus each of `products`, `removed` and `pruneBefore` that is not
   * `undefined`. Upserts and removes up to 200 products a call. Sent once.
   * The site's queue sends the batch again.
   */
  async syncProducts(params: ProductSyncParams): Promise<ProductSyncResult> {
    // Stub: slice 5 packet P3.
    void params;
    return { upserted: 0, skipped: 0, removed: 0, pruned: 0, serverTime: 0 };
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
   * meets either one treats itself as disconnected.
   */
  async disconnect(): Promise<DisconnectResult> {
    // Stub: slice 5 packet P3.
    return { disconnected: true, clientRevoked: false, tokensRevoked: 0, webhooksRemoved: 0 };
  }

  /** `GET /connect/migration-window`, `connect:migrate`. Whether the site may still migrate, and until when. */
  async migrationWindow(): Promise<MigrationWindow> {
    // Stub: slice 5 packet P3.
    return { open: false, closesAt: null };
  }

  /**
   * `GET /connect/customer-email-key`, `connect:records:read`. The key the
   * site hashes customer emails with. Cloud sends it with
   * `Cache-Control: no-store`. Never log it. A 2xx without a non-empty
   * text `keyId`, and a `secret` that is standard base64 of at least 16
   * bytes, raises `UnexpectedResponseError`, so a site never hashes with a
   * missing or weak key. That error quotes no part of the answer, in its
   * message, `data` or cause. Siren's `CloudCustomerEmailKeys` reads it the same
   * way.
   */
  async customerEmailKey(): Promise<CustomerEmailKey> {
    // Stub: slice 5 packet P3.
    return { keyId: '', secret: '' };
  }

  /** `GET /ping`. Proves the token works, and names the organization it belongs to. */
  async ping(): Promise<PingResult> {
    // Stub: slice 5 packet P3.
    return { ok: true, org: { id: 0, name: '' } };
  }
}
