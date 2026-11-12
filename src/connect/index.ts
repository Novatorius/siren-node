/*
 * `@novatorius/siren/connect`: what a connected site needs to connect to
 * Siren Cloud and keep the connection. OAuth registration, PKCE, the
 * consent screen URL and token calls, and a client for the `/connect/*`
 * routes. The SDK keeps no state: the site stores its client id, verifier,
 * state and token pair, and locks its own refresh.
 */
export { SirenConnect } from './siren-connect';
export { ConnectResource } from './connect-resource';
export { ConnectWebhookResource } from './connect-webhook-resource';
export { OAuthClient, DEFAULT_CONSENT_SCREEN_URL, DEFAULT_OAUTH_TIMEOUT_MS } from './oauth';
export { OAuthError } from './errors';
export { createCodeVerifier, createState, codeChallengeS256 } from './pkce';
export { ConnectScope } from './scopes';
export { ConnectorSoftware, OAuthErrorCode } from './types';
export type {
  OAuthClientOptions,
  OAuthRegisterParams,
  OAuthClientRegistration,
  OAuthAuthorizeParams,
  OAuthExchangeCodeParams,
  OAuthRefreshParams,
  OAuthTokenResponse,
  SirenConnectOptions,
  ConnectPlan,
  ConnectUpdateGrant,
  SiteStateParams,
  SiteStateReport,
  ReportedIntegration,
  ConnectProduct,
  ProductSyncParams,
  ProductSyncResult,
  DisconnectResult,
  MigrationWindow,
  CustomerEmailKey,
  PingResult,
  ConnectorWebhookParams,
  ConnectorWebhook,
  ConnectorWebhookWithSecret,
  WebhookTestResult,
  ConnectorWebhookDelivery,
} from './types';

// The token sources and the forwarded event vocabulary, so a connected site
// takes them from this entry too. Each is the same class or value the main
// entry exports. Webhook verification (`webhooks.constructEvent`) stays on
// the main client.
export { ConnectorScope } from '../auth/connector-scope';
export { StaticAccessToken } from '../auth/static-access-token';
export { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
export type { AccessTokenSource } from '../auth/access-token-source';
export { ForwardedEventSlug, FORWARDED_EVENT_VERSION } from './forwarded-events';
export type * from './forwarded-events';
