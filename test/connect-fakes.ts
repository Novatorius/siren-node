import { HttpTransport } from '../src/http';
import type { HttpResponse } from '../src/http';
import { ConnectResource } from '../src/connect/index';
import { FakeHttpClient, spySource } from './http-fakes';

/*
 * Slice 5 test doubles for the connected-site routes. The network boundary is
 * the SDK's `HttpClient` seam, so these tests keep the real transport and the
 * real resources (KB 568).
 *
 * The bodies are the ones Siren's controllers build at b6f7140d0. Each
 * controller lives in lib/Webhooks/Service/Rest/Connector unless its comment
 * names saas/Rest/Connector, saas/Rest or lib/Customers/Rest/Service/Connector.
 * The scope refusals come from
 * lib/OAuth/Service/Middleware/OAuthScopeMiddleware.php, rendered by
 * saas/Strategies/RestStrategy.php as `{ error: { message, context } }`.
 */

export const BASE = 'https://api.sirenaffiliates.com/siren/v1';

/** The real transport over a fake client. `Retry-After: 0` keeps retries instant. */
export function connectOver(replies: Array<HttpResponse | Error>, maxRetries = 2) {
  const http = new FakeHttpClient(replies);
  const tokens = spySource(['tok-1'], 'tok-2');
  const transport = new HttpTransport({ tokens, client: http, baseUrl: BASE, timeout: 30_000, maxRetries });
  return { http, tokens, connect: new ConnectResource(transport) };
}

export const ConnectAnswers = {
  /** saas/Rest/Connector/GetConnectorPlan.php line 84, a Pro trial. */
  plan: {
    status: 'active',
    capabilities: ['collaborator-portal', 'lifetime-commissions'],
    trial: { active: true, plan: 'pro', endsAt: '2026-11-26T00:00:00+00:00', ended: false },
    paidPlan: null,
    /** GetConnectorPlan::PRICING_URL, line 60. */
    pricingUrl: 'https://www.sirenaffiliates.com/pricing/cloud',
  },
  /** saas/Rest/Connector/GetConnectorPlan.php line 81, through ApiErrorCode::respond (line 153). */
  planUnavailable: {
    error: {
      message: "Siren Cloud could not read this organization's plan. Keep the plan you have and ask again later.",
      code: 'plan_unavailable',
    },
  },
  /** saas/Rest/Connector/IssueUpdateGrant.php line 75, ConnectorUpdateGrants::forStore. */
  updateGrant: { grant: 'eyJhbGciOiJIUzI1NiJ9.grant.sig', expiresAt: 1_762_003_600, expiresIn: 3600 },
  /** ReportConnectedSiteState.php line 81. */
  siteState: { reported: true, forwarding: true, cutOverAt: 1_762_000_000, localDataDeletedAt: null },
  /** SyncConnectedStoreProducts.php line 147. */
  productSync: { upserted: 2, skipped: 0, removed: 1, pruned: 0, serverTime: 1_762_000_123 },
  /** DisconnectConnectedSite.php line 56. */
  disconnected: { disconnected: true, clientRevoked: true, tokensRevoked: 3, webhooksRemoved: 1 },
  /** GetMigrationWindow.php line 59. */
  migrationWindow: { open: true, closesAt: 1_764_592_000 },
  /** lib/Customers/Rest/Service/Connector/GetCustomerEmailKey.php line 58. */
  customerEmailKey: { keyId: 'cek_2026a', secret: 'c2VjcmV0LWhtYWMta2V5LWJ5dGVzLTMyLWxvbmctIQ==' },
  /** saas/Rest/Ping.php line 83. */
  ping: { ok: true, org: { id: 42, name: 'Example Org' } },
  /** OAuthScopeMiddleware.php line 70. */
  missingScope(scope: string) {
    return { error: { message: `This token is not authorized for ${scope}.`, context: [] } };
  },
  /** saas/Auth/ApiKeyAuthMiddleware.php line 273: `/ping` with a token that lacks `connect:ingest`. It names no scope. */
  ingestRefused: { error: { message: 'This token is not authorized to ingest events.', context: [] } },
  /** OAuthScopeMiddleware.php line 58. */
  invalidToken: { error: { message: 'Invalid access token.', context: [] } },
  /** A 5xx with Siren's error envelope. */
  unavailable: { error: { message: 'Service unavailable', context: [] } },
  /** GetConnectorWebhook.php line 60 and ReplaceConnectorWebhook.php line 90, WebhookSubscriptionAdapter plus the Property. */
  webhook: {
    id: 77,
    targetUrl: 'https://store.example/siren/webhook',
    events: ['conversion.approved', 'payout.paid'],
    description: 'Siren connector',
    status: 'active',
    urlValid: true,
    urlProblem: null,
    propertyId: 9,
    oauthClientId: 'sc_4b1f0e3a9d2c',
    dateCreated: '2026-11-01 10:00:00',
    dateModified: '2026-11-12 09:00:00',
    property: { id: 9, siteUrl: 'https://store.example' },
  },
  /** ReplaceConnectorWebhook.php: the new secret, shown once. */
  signingSecret: 'whsec_SIGNINGSECRET_0f1e2d3c',
  /** DeleteConnectorWebhook.php line 49. */
  deleted: { deleted: true },
  /** TestConnectorWebhook.php line 78, ConnectorWebhookTester::sendTest. */
  tested: { delivered: true, httpStatus: 200, error: null },
  /**
   * ListConnectorWebhookDeliveries.php line 55, WebhookDeliveryAdapter. Dates
   * come from phpnomad's DateFormatterService as `Y-m-d H:i:s`, with no offset.
   */
  delivery: {
    id: 501,
    webhookSubscriptionId: 77,
    eventType: 'conversion.approved',
    eventId: '0b7f5c62-3d1e-4f8a-9c2b-1a0e9d8c7b6a',
    payload: { conversionId: 7 },
    status: 'delivered',
    attemptCount: 1,
    httpStatusCode: 200,
    responseBody: 'ok',
    errorMessage: null,
    nextRetryAt: null,
    deliveredAt: '2026-11-12 09:01:00',
    dateCreated: '2026-11-12 09:00:59',
    dateModified: '2026-11-12 09:01:00',
  },
} as const;
