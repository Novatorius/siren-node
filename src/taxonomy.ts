/**
 * Siren's domain vocabulary: the statuses, slugs and kinds the API speaks.
 *
 * Siren owns these terms. This module carries them as types, so an
 * integration compares against a constant instead of a hand-typed string.
 * Each one is a `const` object with a union type of the same name, as
 * `WebhookEventType` and `ApiKeyScope` are. The values match the Siren PHP
 * SDK's classes of the same names, and where the Siren service lists more
 * values than the PHP SDK, the service's list wins. The bulk actions and
 * alias types come from constants on the PHP SDK's resource classes instead
 * (`Collaborators::BULK_*`, `Programs::BULK_*`, `ProgramGroups::BULK_DELETE`
 * and `CollaboratorAliases::TYPE_*`), and `ProgramGroupSorter` matches its
 * PHP class.
 *
 * ```ts
 * const approved = await siren.conversions.list({ status: ConversionStatus.Approved });
 * ```
 */

/** URL slugs for the built-in event types (`POST /event/{slug}`). */
export const EventSlug = {
  Sale: 'sale',
  Refund: 'refund',
  SiteVisited: 'site-visited',
} as const;

/** Union of the {@link EventSlug} strings. */
export type EventSlug = (typeof EventSlug)[keyof typeof EventSlug];

/** How a whole order ended, sent as a refund's `kind`. Siren reads `refund` when it is left out. */
export const RefundKind = {
  Refund: 'refund',
  Cancelled: 'cancelled',
  Voided: 'voided',
} as const;

/** Union of the {@link RefundKind} strings. */
export type RefundKind = (typeof RefundKind)[keyof typeof RefundKind];

/**
 * The `status` Siren reports in the body of an ingested event
 * (`EventResult.status`). A sale answers `created`, `recorded`, `duplicate`,
 * `unattributed` or `ignored`. A site visit answers `attributed`, `recorded`
 * or `not_attributed`, and a site check visit answers `checked`. Any event
 * can answer `queued` while the organization's engine is paused.
 */
export const EventStatus = {
  Created: 'created',
  Recorded: 'recorded',
  Duplicate: 'duplicate',
  Unattributed: 'unattributed',
  Ignored: 'ignored',
  Attributed: 'attributed',
  NotAttributed: 'not_attributed',
  Queued: 'queued',
  Checked: 'checked',
} as const;

/** Union of the {@link EventStatus} strings. */
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

/**
 * The `reason` Siren adds to an event's body when a sale is recorded and
 * earns nothing, or a site visit is not attributed.
 */
export const EventReason = {
  NoOpportunity: 'no_opportunity',
  UnknownTrackingId: 'unknown_tracking_id',
  NoProgram: 'no_program',
  NoEngagement: 'no_engagement',
  EngagementUsed: 'engagement_used',
  EngagementEnded: 'engagement_ended',
  NotAwarded: 'not_awarded',
  CollaboratorNotFound: 'collaborator_not_found',
  CollaboratorNotActive: 'collaborator_not_active',
  SiteCheckNotFound: 'site_check_not_found',
} as const;

/** Union of the {@link EventReason} strings. */
export type EventReason = (typeof EventReason)[keyof typeof EventReason];

/** Statuses a conversion can hold (`siren.conversions` and `conversion.*` webhooks). */
export const ConversionStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Expired: 'expired',
  Deleted: 'deleted',
} as const;

/** Union of the {@link ConversionStatus} strings. */
export type ConversionStatus = (typeof ConversionStatus)[keyof typeof ConversionStatus];

/** Statuses a transaction can hold (`siren.transactions` and `transaction.*` webhooks). */
export const TransactionStatus = {
  Complete: 'complete',
  Cancelled: 'cancelled',
  Refunded: 'refunded',
} as const;

/** Union of the {@link TransactionStatus} strings. */
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

/**
 * Statuses an obligation can hold (`siren.obligations` and `obligation.*`
 * webhooks). A `draft` obligation is the reward a pending conversion will
 * produce, and an obligation that is paid out is `complete`.
 */
export const ObligationStatus = {
  Draft: 'draft',
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Complete: 'complete',
  Deleted: 'deleted',
  Cancelled: 'cancelled',
} as const;

/** Union of the {@link ObligationStatus} strings. */
export type ObligationStatus = (typeof ObligationStatus)[keyof typeof ObligationStatus];

/** Statuses a payout can hold (`siren.payouts` and `payout.*` webhooks). */
export const PayoutStatus = {
  Unpaid: 'unpaid',
  Processing: 'processing',
  Paid: 'paid',
  Failed: 'failed',
} as const;

/** Union of the {@link PayoutStatus} strings. */
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

/**
 * Statuses an opportunity can hold (`opportunity.*` webhooks). A sale's
 * `trackingId` names an opportunity.
 */
export const OpportunityStatus = {
  Active: 'active',
  Inactive: 'inactive',
  Invalid: 'invalid',
} as const;

/** Union of the {@link OpportunityStatus} strings. */
export type OpportunityStatus = (typeof OpportunityStatus)[keyof typeof OpportunityStatus];

/** Program statuses. Siren sets `deleted` on the first delete, never directly. */
export const ProgramStatus = {
  Active: 'active',
  Inactive: 'inactive',
  Deleted: 'deleted',
} as const;

/** Union of the {@link ProgramStatus} strings. */
export type ProgramStatus = (typeof ProgramStatus)[keyof typeof ProgramStatus];

/**
 * Collaborator statuses. `active`, `inactive` and `pending` can be set on
 * create, and `rejected` on update. Siren sets `deleted` on the first
 * delete, never directly.
 */
export const CollaboratorStatus = {
  Active: 'active',
  Inactive: 'inactive',
  Pending: 'pending',
  Rejected: 'rejected',
  Deleted: 'deleted',
} as const;

/** Union of the {@link CollaboratorStatus} strings. */
export type CollaboratorStatus = (typeof CollaboratorStatus)[keyof typeof CollaboratorStatus];

/** Distributor statuses. Siren sets `deleted` on the first delete, never directly. */
export const DistributorStatus = {
  Active: 'active',
  Inactive: 'inactive',
  Deleted: 'deleted',
} as const;

/** Union of the {@link DistributorStatus} strings. */
export type DistributorStatus = (typeof DistributorStatus)[keyof typeof DistributorStatus];

/** Statuses a fulfillment can hold (`fulfillment.*` webhooks). */
export const FulfillmentStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Complete: 'complete',
  Failed: 'failed',
} as const;

/** Union of the {@link FulfillmentStatus} strings. */
export type FulfillmentStatus = (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

/** Statuses an API key can hold (`siren.apiKeys`). */
export const ApiKeyStatus = {
  Active: 'active',
  Revoked: 'revoked',
} as const;

/** Union of the {@link ApiKeyStatus} strings. */
export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

/** Statuses a webhook subscription can hold (`siren.webhooks.subscriptions`). */
export const WebhookSubscriptionStatus = {
  Active: 'active',
  Paused: 'paused',
} as const;

/** Union of the {@link WebhookSubscriptionStatus} strings. */
export type WebhookSubscriptionStatus =
  (typeof WebhookSubscriptionStatus)[keyof typeof WebhookSubscriptionStatus];

/** Custom currency types. */
export const CustomCurrencyType = {
  Internal: 'internal',
  Monetary: 'monetary',
} as const;

/** Union of the {@link CustomCurrencyType} strings. */
export type CustomCurrencyType = (typeof CustomCurrencyType)[keyof typeof CustomCurrencyType];

/** The bulk actions `collaborators.bulk()` runs, as Siren names them. */
export const CollaboratorBulkAction = {
  Activate: 'activate',
  /** Sets the status to `rejected`. An applicant it declines gets the declined email. */
  Reject: 'reject',
  Deactivate: 'deactivate',
  Restore: 'restore',
  Delete: 'delete',
  PermanentDelete: 'permanent_delete',
  /** Needs `{ programId }` in `extra`. */
  AddToProgram: 'addToProgram',
  /** Needs `{ programId }` in `extra`. */
  RemoveFromProgram: 'removeFromProgram',
  /** Needs `{ distributorId }` in `extra`. */
  AddToDistributor: 'addToDistributor',
  /** Needs `{ distributorId }` in `extra`. */
  RemoveFromDistributor: 'removeFromDistributor',
  SendSignupEmail: 'sendSignupEmail',
} as const;

/** Union of the {@link CollaboratorBulkAction} strings. */
export type CollaboratorBulkAction = (typeof CollaboratorBulkAction)[keyof typeof CollaboratorBulkAction];

/** The plain code types Siren gives out. A credit coupon's type is `credit_coupon_{CURRENCY}`. */
export const CollaboratorAliasType = {
  Tracking: 'tracking',
  Coupon: 'coupon',
} as const;

/** Union of the {@link CollaboratorAliasType} strings. */
export type CollaboratorAliasType = (typeof CollaboratorAliasType)[keyof typeof CollaboratorAliasType];

/** The bulk actions `programs.bulk()` runs, as Siren names them. */
export const ProgramBulkAction = {
  Activate: 'activate',
  Deactivate: 'deactivate',
  Restore: 'restore',
  Delete: 'delete',
  PermanentDelete: 'permanent_delete',
} as const;

/** Union of the {@link ProgramBulkAction} strings. */
export type ProgramBulkAction = (typeof ProgramBulkAction)[keyof typeof ProgramBulkAction];

/** How a program group picks the winning program when several could claim the same engagement. */
export const ProgramGroupSorter = {
  /** The program the opportunity was bound to first wins. */
  OldestBindingWins: 'oldestBindingWins',
  /** The program the opportunity was bound to most recently wins. */
  NewestBindingWins: 'newestBindingWins',
} as const;

/** Union of the {@link ProgramGroupSorter} strings. */
export type ProgramGroupSorter = (typeof ProgramGroupSorter)[keyof typeof ProgramGroupSorter];

/** The bulk actions `programGroups.bulk()` runs, as Siren names them. */
export const ProgramGroupBulkAction = {
  Delete: 'delete',
} as const;

/** Union of the {@link ProgramGroupBulkAction} strings. */
export type ProgramGroupBulkAction = (typeof ProgramGroupBulkAction)[keyof typeof ProgramGroupBulkAction];

/** The bulk actions `conversions.bulk()` runs, as Siren names them. */
export const ConversionBulkAction = {
  Approve: 'approve',
  Reject: 'reject',
  MarkPending: 'markPending',
  Delete: 'delete',
  PermanentDelete: 'permanent_delete',
} as const;

/** Union of the {@link ConversionBulkAction} strings. */
export type ConversionBulkAction = (typeof ConversionBulkAction)[keyof typeof ConversionBulkAction];

/** The bulk actions `transactions.bulk()` runs, as Siren names them. */
export const TransactionBulkAction = {
  Cancel: 'cancel',
  Refund: 'refund',
  Delete: 'delete',
} as const;

/** Union of the {@link TransactionBulkAction} strings. */
export type TransactionBulkAction = (typeof TransactionBulkAction)[keyof typeof TransactionBulkAction];

/** The bulk actions `distributors.bulk()` runs, as Siren names them. */
export const DistributorBulkAction = {
  Activate: 'activate',
  Deactivate: 'deactivate',
  Restore: 'restore',
  Delete: 'delete',
  PermanentDelete: 'permanent_delete',
} as const;

/** Union of the {@link DistributorBulkAction} strings. */
export type DistributorBulkAction = (typeof DistributorBulkAction)[keyof typeof DistributorBulkAction];

/**
 * The statuses a store credit hold can take. A hold is `active` until its
 * `ttl` runs out (`expired`), the site gives it back (`released`), or Siren
 * spends it from the order's redemption (`settled`).
 */
export const CreditHoldStatus = {
  Active: 'active',
  Settled: 'settled',
  Released: 'released',
  Expired: 'expired',
} as const;

/** Union of the {@link CreditHoldStatus} strings. */
export type CreditHoldStatus = (typeof CreditHoldStatus)[keyof typeof CreditHoldStatus];
