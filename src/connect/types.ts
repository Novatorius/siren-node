import type { SirenBaseOptions } from '../types';
import type { AccessTokenSource } from '../auth/access-token-source';
import type { HttpClient } from '../http';
import type { WebhookEventType } from '../event-types';
import type { WebhookSubscription } from '../types';

/*
 * Wire types for the connected-site routes. Siren Cloud owns every field
 * name here, and each type names the Cloud class whose answer or body it
 * mirrors, read at Siren b6f7140d0. Answers pass through as Cloud sends
 * them, so a field Cloud adds later reaches the caller untouched.
 */

/**
 * The software a connected site says it is at registration, RFC 7591
 * `software_id`. Siren's `ConnectorSoftware`. A client that sends none
 * registers as the WordPress connector.
 */
export const ConnectorSoftware = {
  WordPress: 'siren-wordpress',
  Medusa: 'siren-medusa',
} as const;

/** Union of the {@link ConnectorSoftware} strings. */
export type ConnectorSoftware = (typeof ConnectorSoftware)[keyof typeof ConnectorSoftware];

/** Options for {@link OAuthClient}. None is required. */
export interface OAuthClientOptions {
  /** The API base URL. Defaults to `https://api.sirenaffiliates.com/siren/v1`. */
  baseUrl?: string;
  /**
   * The Siren Cloud consent screen the merchant's browser opens. Defaults to
   * `https://api.sirenaffiliates.com/connect-site`. A local Cloud serves it
   * from another host than the one the store's server calls.
   */
  consentScreenUrl?: string;
  /** The HTTP stack to send through. Defaults to `FetchHttpClient` over the global `fetch`. */
  httpClient?: HttpClient;
  /**
   * Milliseconds to allow for each call. Defaults to 15000, the wait Siren
   * Cloud's 30 second refresh grace window is built around.
   */
  timeout?: number;
}

/** What `oauth.register` sends. */
export interface OAuthRegisterParams {
  /** The store's name, up to 200 characters. Cloud names the Property after it. */
  clientName: string;
  /** Up to 10 redirect URIs: https, or http on `localhost`, `127.0.0.1` or `[::1]`. */
  redirectUris: string[];
  /** The space-separated scopes to register for. Defaults to `ConnectorScope.CONNECTED_SITE`. */
  scope?: string;
  /** Which connector this is. Left out, Cloud registers the WordPress connector. */
  softwareId?: ConnectorSoftware;
}

/** Cloud's answer to `POST /oauth/register`, as RFC 7591 names it. Siren's `OAuthService::registerClient`. */
export interface OAuthClientRegistration {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  software_id?: ConnectorSoftware;
}

/** What `oauth.authorizeUrl` builds the consent screen URL from. */
export interface OAuthAuthorizeParams {
  clientId: string;
  /** Must match a registered redirect URI exactly. */
  redirectUri: string;
  /** A fresh value the store keeps until the callback, such as `createState()`. */
  state: string;
  /** `codeChallengeS256(verifier)`, never the verifier itself. */
  codeChallenge: string;
  /** Defaults to `ConnectorScope.CONNECTED_SITE`. */
  scope?: string;
}

/** What `oauth.exchangeCode` sends. */
export interface OAuthExchangeCodeParams {
  clientId: string;
  /** The `code` the callback carried. Single use. */
  code: string;
  /** The redirect URI the authorization request named. */
  redirectUri: string;
  /** The verifier whose challenge the authorization request carried. */
  codeVerifier: string;
}

/** What `oauth.refresh` sends. */
export interface OAuthRefreshParams {
  clientId: string;
  refreshToken: string;
  /**
   * A fresh random id for each refresh, such as `createState()` makes, sent
   * again unchanged on every try of that one refresh. Within 30 seconds of
   * the rotation, Cloud answers a try that carries it with the pair it
   * already issued, as often as it comes. A repeat without it is answered
   * once, and any repeat after 30 seconds makes Cloud revoke the whole token
   * family. A guessable id would let whoever holds a stolen refresh token
   * repeat it unnoticed inside the window.
   */
  attemptId?: string;
}

/** Cloud's token answer, as RFC 6749 names it. Siren's `OAuthService::tokenResponse`. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds. Cloud sends 3600. */
  expires_in: number;
  scope: string;
  /** The next refresh token. The one sent is spent: Cloud rotates it on every refresh. */
  refresh_token: string;
}

/** The error codes Cloud's OAuth routes answer with, in the RFC 6749 and 7591 envelope. */
export const OAuthErrorCode = {
  InvalidRequest: 'invalid_request',
  InvalidGrant: 'invalid_grant',
  InvalidClient: 'invalid_client',
  InvalidScope: 'invalid_scope',
  UnsupportedGrantType: 'unsupported_grant_type',
  InvalidClientMetadata: 'invalid_client_metadata',
  InvalidRedirectUri: 'invalid_redirect_uri',
} as const;

/** Union of the {@link OAuthErrorCode} strings. */
export type OAuthErrorCode = (typeof OAuthErrorCode)[keyof typeof OAuthErrorCode];

/** Options for {@link SirenConnect}: a connected site's OAuth grant, never an API key. */
export interface SirenConnectOptions extends SirenBaseOptions {
  /** The site's access token, or an `AccessTokenSource` that refreshes it after a 401. */
  accessToken: string | AccessTokenSource;
  apiKey?: never;
}

/** `GET /connect/plan`. Siren's `GetConnectorPlan`. */
export interface ConnectPlan {
  status: 'active' | 'lapsed' | 'none' | 'unrestricted';
  /** Every capability slug the organization's entitlements grant. */
  capabilities: string[];
  trial: {
    active: boolean;
    /** `essentials`, `plus` or `pro` during a trial, else `null`. */
    plan: string | null;
    /** ISO 8601, or `null` outside a trial. */
    endsAt: string | null;
    ended: boolean;
  };
  /** The highest tier the organization pays for, outside a trial. */
  paidPlan: string | null;
  pricingUrl: string;
}

/** `POST /connect/update-grant`. Siren's `ConnectorUpdateGrants::sign`. */
export interface ConnectUpdateGrant {
  grant: string;
  /** Unix time. */
  expiresAt: number;
  /** Seconds, so the store can time the grant by its own clock. */
  expiresIn: number;
}

/** What `connect.reportSiteState` sends. Siren's `ReportConnectedSiteState`. */
export interface SiteStateParams {
  forwarding: boolean;
  /** Unix time, 2020 or later, or `null`. */
  cutOverAt?: number | null;
  /** Unix time, 2020 or later, or `null`. */
  localDataDeletedAt?: number | null;
  /** Sent once the migration the cutover runs finished. Closes the site's migration window. */
  migrationComplete?: boolean;
}

/** `PUT /connect/site-state`. */
export interface SiteStateReport {
  reported: true;
  forwarding: boolean;
  cutOverAt: number | null;
  localDataDeletedAt: number | null;
}

/** One integration in `connect.reportIntegrations`. Siren's `ReplaceConnectedSiteIntegrations`. */
export interface ReportedIntegration {
  /** Letters, digits, `.`, `-` or `_`. */
  id: string;
  name?: string;
  /** Feature values such as `coupons`, `customers` and `products`. Cloud drops values it does not know. */
  supports?: string[];
}

/** One product in `connect.syncProducts`. Siren's `ConnectedStoreProductCatalog::summary`. */
export interface ConnectProduct {
  /** The platform's product id: a whole number, or text where the platform uses text ids, such as `medusa`. */
  id: string | number;
  parentId?: string | number | null;
  name?: string | null;
  sku?: string | null;
  type?: string | null;
  status?: string | null;
  /** An http or https link, or `null`. */
  editUrl?: string | null;
}

/** What `connect.syncProducts` sends. Siren's `SyncConnectedStoreProducts`. */
export interface ProductSyncParams {
  /** A catalog platform key, such as `wc` or `medusa`. */
  platform: string;
  /** Up to 200 products. */
  products?: ConnectProduct[];
  /** Up to 200 product ids. */
  removed?: Array<string | number>;
  /** The `serverTime` an earlier answer of the same sync gave. Ends a full sync. */
  pruneBefore?: number | null;
}

/** `PUT /connect/products`. */
export interface ProductSyncResult {
  upserted: number;
  skipped: number;
  removed: number;
  pruned: number;
  /** Unix time by Cloud's clock. Pass it as `pruneBefore` to end the sync. */
  serverTime: number;
}

/** `POST /connect/disconnect`. Siren's `ConnectedSiteDisconnector::disconnectClient`. */
export interface DisconnectResult {
  disconnected: true;
  clientRevoked: boolean;
  tokensRevoked: number;
  webhooksRemoved: number;
}

/** `GET /connect/migration-window`. Siren's `GetMigrationWindow`. */
export interface MigrationWindow {
  open: boolean;
  /** Unix time, or `null` when there is no window. */
  closesAt: number | null;
}

/** `GET /connect/customer-email-key`. Siren's `GetCustomerEmailKey`. Never log it. */
export interface CustomerEmailKey {
  keyId: string;
  /** The HMAC key, base64 encoded. */
  secret: string;
}

/** `GET /ping`. Siren's `Ping`. */
export interface PingResult {
  ok: true;
  org: { id: number; name: string };
}

/** What `connect.webhook.replace` sends. Siren's `ReplaceConnectorWebhook`. */
export interface ConnectorWebhookParams {
  /** Where Cloud delivers. Cloud refuses a URL its outbound rules refuse. */
  targetUrl: string;
  /** Up to 100 event types. */
  events: Array<WebhookEventType | (string & {})>;
}

/** The site's own webhook subscription. Siren's `WebhookSubscriptionAdapter` plus the Property. */
export interface ConnectorWebhook extends WebhookSubscription {
  property: { id: number; siteUrl: string };
}

/** `PUT /connect/webhook`: the subscription with its new signing secret, shown only here. */
export interface ConnectorWebhookWithSecret extends ConnectorWebhook {
  signingSecret: string;
}

/** `POST /connect/webhook/test`. Siren's `ConnectorWebhookTester::sendTest`. */
export interface WebhookTestResult {
  delivered: boolean;
  httpStatus: number | null;
  error: string | null;
}

/** One delivery to the site's subscription. Siren's `WebhookDeliveryAdapter`. */
export interface ConnectorWebhookDelivery {
  id: number;
  webhookSubscriptionId: number;
  eventType: string;
  eventId: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  attemptCount: number;
  httpStatusCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  deliveredAt: string | null;
  dateCreated: string | null;
  dateModified: string | null;
}
