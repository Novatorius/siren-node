import type { ApiKeyScope } from './api-key-scopes';
import type { WebhookEventType } from './event-types';

/** Options accepted by `new Siren({...})`. */
export interface SirenOptions {
  /** Your Siren API key (`sk_live_...`). Required. */
  apiKey: string;
  /**
   * API base URL. Defaults to `https://api.sirenaffiliates.com/siren/v1`.
   * Point this at staging or a local dev server as needed.
   */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /**
   * Retry count for network errors and 429/5xx responses on idempotent
   * operations (reads and event ingestion). Management writes (create API
   * key, create webhook subscription) are never auto-retried. Defaults to 2.
   */
  maxRetries?: number;
}

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

/** Parameters for `events.sale`. */
export interface SaleParams {
  /** Commerce source identifier, e.g. `"stripe"`, `"woocommerce"`. */
  source: string;
  /** Your order or transaction id, used later to match refunds. Siren stores a number as text. */
  externalId: string | number;
  /** Order total in major currency units (9.99 = $9.99). */
  total: number;
  /** Opportunity id from the Siren tracking cookie / attribution. */
  trackingId: number;
  /**
   * Currency code for the sale, such as `"EUR"`. It must be a currency your
   * organization uses, or Siren answers 400. Every line is recorded in it.
   * When omitted, the lines read as the organization's default currency.
   */
  currency?: string;
  /** Line items. Omit to treat `total` as a single line. */
  items?: LineItem[];
}

/** Parameters for `events.refund`. Both fields must match the original sale. */
export interface RefundParams {
  source: string;
  externalId: string | number;
}

/** Parameters for `events.siteVisited`. */
export interface SiteVisitedParams {
  /** The collaborator (affiliate) to attribute the visit to. */
  collaboratorId: number;
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
