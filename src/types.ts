import type { ApiKeyScope } from './api-key-scopes';
import type { WebhookEventType } from './event-types';
import type { RefundKind } from './taxonomy';
import type { AccessTokenSource } from './auth/access-token-source';
import type { HttpClient } from './http';

/** Options every `Siren` client takes, whichever credential it uses. */
export interface SirenBaseOptions {
  /**
   * API base URL. Defaults to `https://api.sirenaffiliates.com/siren/v1`.
   * Point this at staging or a local dev server as needed. Any value but an
   * http or https URL with no user name or password in it, and no query,
   * fragment, space or control character, throws `SirenError` at
   * construction.
   */
  baseUrl?: string;
  /**
   * Timeout for each send in milliseconds, from 1 to 2147483647. Defaults
   * to 30000. A call that retries makes several sends, each with its own
   * timeout. Any other value, NaN and Infinity included, throws `SirenError`
   * at construction.
   */
  timeout?: number;
  /**
   * Retry count for network errors and 429/5xx responses on idempotent
   * operations (reads, and sales and refunds that Siren can match). Site
   * visits, custom events, sales with no `externalId` and management writes
   * are never auto-retried. A token the SDK refuses is never sent, so never
   * retried. A whole number, 0 or more, and defaults to 2, with no ceiling.
   * Any other value throws `SirenError` at construction. A caller with a
   * durable queue sets 0, because the queue owns redelivery.
   *
   * The one resend after a 401 with a refreshed token is not a retry and
   * happens whatever this says.
   */
  maxRetries?: number;
  /**
   * The HTTP stack to send requests through. Defaults to `FetchHttpClient`
   * over the global `fetch`. A value without a `send` function throws
   * `SirenError` at construction.
   */
  httpClient?: HttpClient;
}

/** A client that sends a fixed API key. */
export interface SirenApiKeyOptions extends SirenBaseOptions {
  /** Your Siren API key (`sk_live_...`). */
  apiKey: string;
  accessToken?: never;
}

/** A client that sends an OAuth access token, such as a connected store's. */
export interface SirenAccessTokenOptions extends SirenBaseOptions {
  /**
   * A fixed token, or an `AccessTokenSource` that supplies the token and a
   * fresh one after a 401. An empty string throws `SirenError` at
   * construction.
   */
  accessToken: string | AccessTokenSource;
  apiKey?: never;
}

/**
 * Options for `new Siren()`. Pass `apiKey` or `accessToken`, never both:
 * both, neither, or an empty one throws `SirenError` at construction.
 */
export type SirenOptions = SirenApiKeyOptions | SirenAccessTokenOptions;

/** Result of every event-ingestion call. */
export interface EventResult {
  /**
   * The opportunity (tracking) id associated with the event. Read from the
   * `X-Siren-OID` response header, or from the body's `opportunityId` when
   * the header is absent (a visit queued while the organization is paused
   * reports it only in the body). Absent when the API returns neither.
   */
  opportunityId?: number;
  /**
   * What Siren did with the event, from the response body. A sale reports
   * `created`, `recorded`, `duplicate`, `unattributed` or `ignored`. A site
   * visit reports `attributed`, `recorded` or `not_attributed`. Either may
   * report `queued`. Absent when the body is empty, as it is for a refund.
   */
  status?: string;
  /**
   * `true` when Siren accepted the event into its paused-ingest queue
   * (HTTP 202) because the organization's engine is paused. The event is
   * processed once the organization can run again. Nothing to resend.
   */
  queued?: boolean;
  /**
   * The parsed response body, when Siren sent one. A sale carries
   * `{ status, created, transactionId, conversions, message, reason? }`. A
   * site visit carries `{ status, attributed, opportunityId, message, reason? }`.
   */
  body?: Record<string, unknown>;
}

/** A sale line item. `amount` is the per-unit price in major currency units. */
export interface LineItem {
  /** Your id for this line item. Siren stores a number as text. */
  externalId?: string | number;
  /**
   * Your id for this order line, 1 to 191 characters. Siren keeps it on the
   * line, so a later refund can name the line by it in `RefundLine.lineId`.
   * Siren stores a number as text.
   */
  lineId?: string | number;
  /** Human-readable product name. Optional, as Siren needs only `amount`. */
  name?: string | number;
  /**
   * Units sold. Reward pools compute `amount x quantity`, so this must be
   * honest. Defaults to 1 when omitted.
   */
  quantity?: number;
  /** Per-unit price in major currency units (9.99 = $9.99). */
  amount: number;
}

/** The fields a sale carries, live or test. */
export interface SaleFields {
  /** Commerce source identifier, e.g. `"stripe"`, `"woocommerce"`. */
  source: string;
  /** Your order or transaction id, used later to match refunds. Siren stores a number as text. */
  externalId: string | number;
  /** Order total in major currency units (9.99 = $9.99). */
  total: number;
  /**
   * Currency code for the sale, such as `"EUR"`. It must be a currency your
   * organization uses, or Siren answers 400. Every line is recorded in it.
   * When omitted, the lines read as the organization's default currency.
   */
  currency?: string;
  /** Line items. Omit to treat `total` as a single line. */
  items?: LineItem[];
}

/** A real sale. `trackingId` names the opportunity it belongs to. */
export interface LiveSaleParams extends SaleFields {
  /** Opportunity id from the Siren tracking cookie / attribution. */
  trackingId: number;
  /** Leave out, or send `false`, for a real sale. */
  test?: false;
}

/**
 * A test sale, sent to check an integration. Siren needs no other field,
 * marks it as a test, counts it toward nothing, and reads a repeat as a pass.
 * It ignores `trackingId`, so a real visit is never spent by a test.
 */
export interface TestSaleParams extends Partial<SaleFields> {
  test: true;
  /** Ignored by Siren on a test sale. */
  trackingId?: number;
}

/** Parameters for `events.sale`: a real sale, or a test sale with `test: true`. */
export type SaleParams = LiveSaleParams | TestSaleParams;

/**
 * One refunded order line. Name the line by `lineId`, as the sale's item
 * sent it, or by `sku`. Siren refuses a line that names neither.
 */
export interface RefundLine {
  /** The sale line's `lineId`. Siren stores a number as text. */
  lineId?: string | number;
  /** The product SKU of the line, when the sale sent no `lineId`. */
  sku?: string | number;
  /** Units returned, 0 to 1,000,000. */
  quantity?: number;
  /** Money refunded for this line in major currency units (9.99 = $9.99). */
  amount?: number;
}

/**
 * Parameters for `events.refund`. `source` and `externalId` must match the
 * original sale. `refundId` names this refund.
 *
 * Siren refunds the whole order when `whole` is `true`, or when neither
 * `amount` nor `lines` is sent. Anything else refunds part of it, and a part
 * that leaves the order worth nothing counts as a whole refund.
 */
export interface RefundParams {
  source: string;
  /** The order the refund belongs to, as the sale sent it. */
  externalId: string | number;
  /**
   * The store's own id for this refund, such as WooCommerce refund 2201.
   * Siren requires it and records each refund id once per order, so sending
   * the same refund again is safe.
   */
  refundId: string | number;
  /** Money refunded, in major currency units (9.99 = $9.99). */
  amount?: number;
  /**
   * Currency code of the amounts. When omitted, Siren reads them in the
   * sale's own currency, or else the organization's default.
   */
  currency?: string;
  /** The refunded order lines. At most 500. */
  lines?: RefundLine[];
  /** `true` refunds the whole order, whatever else is sent. */
  whole?: boolean;
  /** How the whole order ended. Siren reads `refund` when it is left out. */
  kind?: RefundKind;
}

/**
 * A collaborator's tracking code as Siren reads it in `collaboratorId`, such
 * as `tracking:summer-sale`. Siren resolves the code to its collaborator.
 */
export type TrackingCodeReference = `tracking:${string}`;

/** Parameters for `events.siteVisited`. */
export interface SiteVisitedParams {
  /**
   * The collaborator (affiliate) to attribute the visit to: their numeric id,
   * or one of their tracking codes as `tracking:{code}`.
   */
  collaboratorId: number | TrackingCodeReference;
  /** Your platform user id, if known. */
  userId?: number;
}

/** A verified, parsed webhook delivery. */
export interface WebhookEvent {
  /**
   * Event type, e.g. `"conversion.approved"`, from the `X-Siren-Event`
   * header, or from the envelope a connected site's subscription receives.
   */
  type: string;
  /** Event payload: the JSON request body, or the envelope's `data`. */
  data: Record<string, unknown>;
  /**
   * Unique delivery id (`evt_...`) from the `X-Siren-Delivery` header or the
   * envelope's `id`. Use it to skip a delivery you already processed.
   */
  deliveryId?: string;
  /**
   * The whole parsed body. For most subscriptions this is the payload
   * itself. A connected site's subscription receives an envelope, which also
   * carries `version`, `kind`, `occurredAt`, `propertyId`, `match` and the
   * related `records`. Always set by `constructEvent`.
   */
  body?: Record<string, unknown>;
}

/**
 * Request headers passed to `webhooks.constructEvent`, so it can read
 * `X-Siren-Event` and `X-Siren-Delivery`. Accepts a Fetch `Headers` object or
 * a plain object such as Node's `req.headers` (names in any case).
 */
export type WebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

/** A webhook subscription as returned by the API. */
export interface WebhookSubscription {
  id: number;
  targetUrl: string;
  events: string[];
  description?: string;
  status?: string;
  /** Whether the stored URL still passes Siren's outbound URL rules. A URL that fails gets no deliveries. */
  urlValid?: boolean;
  /** Why the URL fails those rules, or `null`. */
  urlProblem?: string | null;
  /** The Property the subscription is bound to, or `null` for the whole organization. */
  propertyId?: number | null;
  /** The connected site that manages the subscription, if any. */
  oauthClientId?: string | null;
  dateCreated?: string | null;
  dateModified?: string | null;
  /** @deprecated Siren never sends this field. Read `dateCreated`. */
  createdAt?: string;
}

/**
 * A freshly created subscription. `signingSecret` is returned exactly once —
 * store it; it cannot be retrieved later.
 */
export interface CreatedWebhookSubscription extends WebhookSubscription {
  signingSecret: string;
}

/** Parameters for `webhooks.subscriptions.create`. */
export interface CreateWebhookSubscriptionParams {
  /** The URL Siren will POST deliveries to. */
  targetUrl: string;
  /** Event types to subscribe to. `["*"]` subscribes to all. */
  events: Array<WebhookEventType | (string & {})>;
  description?: string;
}

/** An API key as returned by list (never includes raw key material). */
export interface ApiKey {
  id: number;
  keyPrefix?: string;
  label: string;
  status?: string;
  scopes?: string[];
  /**
   * The store (Property) the key is bound to, or `null` for an
   * organization-wide key. A bound key stamps its store on the events it
   * sends and reads only that store's conversions, transactions and
   * obligations.
   */
  propertyId?: number | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  dateCreated?: string | null;
  dateModified?: string | null;
  /** @deprecated Siren never sends this field. Read `dateCreated`. */
  createdAt?: string;
}

/**
 * A freshly created API key. `rawKey` (`sk_live_...`) is returned exactly
 * once — store it; it cannot be retrieved later.
 */
export interface CreatedApiKey extends ApiKey {
  rawKey: string;
}

/** Parameters for `apiKeys.create`. */
export interface CreateApiKeyParams {
  /** Human-readable label, e.g. `"Production server"`. Optional, and left out of the request when not given. */
  label?: string;
  /**
   * Scopes to grant, from {@link ApiKeyScope}. At least one is required.
   * Event scopes (`event:*` or `event:{slug}`) send events. The ledger scopes,
   * such as `ledger:conversions:read`, read conversions, transactions,
   * obligations and payouts. `webhook-subscriptions:read` and
   * `webhook-subscriptions:manage` read and manage webhook subscriptions.
   * Siren answers 400 for an older resource scope such as `programs:read` or
   * `conversions:read`.
   */
  scopes: Array<ApiKeyScope | (string & {})>;
  /** When the key stops working, as an ISO 8601 date. Omit for a key that never expires. */
  expiresAt?: string;
  /**
   * Bind the key to one store (Property). Siren stamps it on the key's
   * events, and the key reads only that store's conversions, transactions and
   * obligations. A bound key is refused on payouts and webhook subscriptions
   * with a `StoreKeyNotAllowedError`.
   */
  propertyId?: number;
}

/**
 * Parameters for the reconciliation `.list()` readers. Page with `page` and
 * `perPage`, which the SDK turns into Siren's `number` and `offset`, or pass
 * `number` and `offset` yourself. Any other key is sent as a query-string
 * filter, such as `status`.
 */
export interface ListParams {
  /**
   * Narrow an organization-wide read to one store (Property). A key bound to
   * one store reads only its own store's rows, whatever it sends here.
   */
  propertyId?: number;
  /** Page number, starting at 1. */
  page?: number;
  /** Page size, 1 to 200. Siren's default is 10. A larger value is lowered to 200. */
  perPage?: number;
  /** Siren's own page size parameter, 1 to 200. */
  number?: number;
  /** Siren's own first-row parameter, 0 or greater. */
  offset?: number;
  [filter: string]: string | number | boolean | undefined;
}

/**
 * The result of a reconciliation `.list()` — a real array of records you can
 * iterate directly, with the server's total count attached when Siren reports
 * it (the list body's `total`, or the `x-siren-estimated-count` header).
 *
 * ```ts
 * const conversions = await siren.conversions.list();
 * for (const c of conversions) { ... }
 * console.log(conversions.estimatedCount); // total across all pages, if known
 * ```
 */
export interface SirenList<T = Record<string, unknown>> extends Array<T> {
  /** Total record count across all pages, when Siren reports it. */
  estimatedCount?: number;
}

/**
 * One event type a webhook subscription can name, as `GET /webhooks/events`
 * lists it, such as
 * `{ event: 'sale.created', category: 'Sales', label: 'A sale was recorded' }`.
 */
export interface WebhookCatalogEntry {
  /** The event type. Siren may list one this SDK's {@link WebhookEventType} lacks yet. */
  event: WebhookEventType | (string & {});
  /** The group the dashboard's event picker shows it under, such as `Sales`. */
  category: string;
  /** A readable description, such as `A sale was recorded`. */
  label: string;
}

/**
 * One scope a new API key may be given, as `GET /api-keys/scopes` lists it,
 * such as
 * `{ scope: 'ledger:conversions:read', resource: 'ledger', action: 'conversions:read', label: 'Read conversions' }`.
 */
export interface ApiKeyScopeEntry {
  /** The scope string to pass to `apiKeys.create`. */
  scope: ApiKeyScope | (string & {});
  /** The group the scope belongs to, such as `events` or `ledger`. */
  resource: string;
  /** What the scope allows within its group, such as `conversions:read`. */
  action: string;
  /** A readable description. */
  label: string;
}

/**
 * The scopes a new API key may be given, grouped by resource, from
 * `GET /api-keys/scopes`. Siren lists the event scopes under `events`, the
 * ledger read scopes under `ledger`, the webhook scopes under
 * `webhook-subscriptions`, and the record scopes under one `records:*` group
 * each, such as `records:programs`. It leaves out a group with no scopes.
 */
export interface ApiKeyScopeGroups {
  events?: ApiKeyScopeEntry[];
  ledger?: ApiKeyScopeEntry[];
  'webhook-subscriptions'?: ApiKeyScopeEntry[];
  [resource: string]: ApiKeyScopeEntry[] | undefined;
}
