/**
 * Siren's domain taxonomy — the canonical vocabularies the API speaks.
 *
 * Siren owns these terms (statuses, event slugs); this module is the typed
 * source for them so integrations never hand-roll magic strings. Use the
 * constants when filtering reconciliation readers or dispatching on webhook
 * payload fields:
 *
 * ```ts
 * const approved = await siren.conversions.list({ status: ConversionStatus.Approved });
 * ```
 */

/**
 * URL slugs for the built-in ingestion event types (`POST /event/{slug}`).
 *
 * `siren.events.sale()` / `.refund()` / `.siteVisited()` already use these
 * internally; the constants exist for code that routes slugs dynamically
 * (e.g. wrapping `siren.events.ingest`).
 */
export const EventSlug = {
  Sale: 'sale',
  Refund: 'refund',
  SiteVisited: 'site-visited',
} as const;

/** Union of built-in ingestion event slugs. */
export type EventSlug = (typeof EventSlug)[keyof typeof EventSlug];

/**
 * Statuses a conversion can hold (`siren.conversions` records and
 * `conversion.*` webhook payloads).
 */
export const ConversionStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Expired: 'expired',
  /** Soft-delete bucket written by the bulk delete action. */
  Deleted: 'deleted',
} as const;

/** Union of conversion status strings. */
export type ConversionStatus = (typeof ConversionStatus)[keyof typeof ConversionStatus];

/**
 * Statuses a transaction can hold (`siren.transactions` records and
 * `transaction.*` webhook payloads).
 */
export const TransactionStatus = {
  Complete: 'complete',
  Cancelled: 'cancelled',
  Refunded: 'refunded',
} as const;

/** Union of transaction status strings. */
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

/**
 * Statuses an obligation can hold (`siren.obligations` records and
 * `obligation.*` webhook payloads).
 *
 * Note: Siren's machine paths (fulfillment generation, bulk actions) write
 * `complete`, while its management REST surface accepts `fulfilled` — both
 * appear in the wild, so both are listed here.
 */
export const ObligationStatus = {
  Pending: 'pending',
  Complete: 'complete',
  Fulfilled: 'fulfilled',
  Cancelled: 'cancelled',
} as const;

/** Union of obligation status strings. */
export type ObligationStatus = (typeof ObligationStatus)[keyof typeof ObligationStatus];

/**
 * Statuses a payout can hold (`siren.payouts` records and `payout.*`
 * webhook payloads).
 */
export const PayoutStatus = {
  Unpaid: 'unpaid',
  Processing: 'processing',
  Paid: 'paid',
  Failed: 'failed',
} as const;

/** Union of payout status strings. */
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

/**
 * Statuses a fulfillment can hold (`fulfillment.created` /
 * `fulfillment.updated` webhook payloads).
 */
export const FulfillmentStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Complete: 'complete',
  Failed: 'failed',
} as const;

/** Union of fulfillment status strings. */
export type FulfillmentStatus = (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

/**
 * Statuses an opportunity can hold (`opportunity.created` /
 * `opportunity.invalidated` webhook payloads; `trackingId` on sales refers
 * to an opportunity).
 */
export const OpportunityStatus = {
  Active: 'active',
  Inactive: 'inactive',
  /** Set by Siren's invalidation service; never operator-settable. */
  Invalid: 'invalid',
} as const;

/** Union of opportunity status strings. */
export type OpportunityStatus = (typeof OpportunityStatus)[keyof typeof OpportunityStatus];

/** Statuses an API key can hold (`siren.apiKeys` records). */
export const ApiKeyStatus = {
  Active: 'active',
  Revoked: 'revoked',
} as const;

/** Union of API key status strings. */
export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

/** Statuses a webhook subscription can hold (`siren.webhooks.subscriptions`). */
export const WebhookSubscriptionStatus = {
  Active: 'active',
  Paused: 'paused',
} as const;

/** Union of webhook subscription status strings. */
export type WebhookSubscriptionStatus =
  (typeof WebhookSubscriptionStatus)[keyof typeof WebhookSubscriptionStatus];
