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
   * The opportunity (tracking) id associated with the event, read from the
   * `X-Siren-OID` response header. Absent when the API does not return one.
   */
  opportunityId?: number;
}

/** A sale line item. `amount` is the per-unit price in major currency units. */
export interface LineItem {
  /** Your id for this line item. */
  externalId?: string;
  /** Human-readable product name. */
  name: string;
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
  /** Your order/transaction id; used later to match refunds. */
  externalId: string;
  /** Order total in major currency units (9.99 = $9.99). */
  total: number;
  /** Opportunity id from the Siren tracking cookie / attribution. */
  trackingId: number;
  /** ISO currency code. The API defaults to `"USD"` when omitted. */
  currency?: string;
  /** Line items. Omit to treat `total` as a single line. */
  items?: LineItem[];
}

/** Parameters for `events.refund`. Both fields must match the original sale. */
export interface RefundParams {
  source: string;
  externalId: string;
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
  /** Event type, e.g. `"conversion.approved"`. */
  type: string;
  /** Event payload. */
  data: Record<string, unknown>;
  /** Unique id for this delivery attempt, when present in the payload. */
  deliveryId?: string;
}

/** A webhook subscription as returned by the API. */
export interface WebhookSubscription {
  id: number;
  targetUrl: string;
  events: string[];
  description?: string;
  status?: string;
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
  createdAt?: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
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
  /** Human-readable label, e.g. `"Production server"`. */
  label: string;
  /** Scopes to grant. Omit for full access. */
  scopes?: string[];
}

/**
 * Parameters for the reconciliation `.list()` readers. `page`/`perPage`
 * paginate; any additional keys pass through as query-string filters.
 */
export interface ListParams {
  page?: number;
  perPage?: number;
  [filter: string]: string | number | boolean | undefined;
}

/**
 * The result of a reconciliation `.list()` — a real array of records you can
 * iterate directly, with the server's estimated total count attached when the
 * `x-siren-estimated-count` response header is present.
 *
 * ```ts
 * const conversions = await siren.conversions.list();
 * for (const c of conversions) { ... }
 * console.log(conversions.estimatedCount); // total across all pages, if known
 * ```
 */
export interface SirenList<T = Record<string, unknown>> extends Array<T> {
  /** Estimated total record count from `x-siren-estimated-count`, if present. */
  estimatedCount?: number;
}
