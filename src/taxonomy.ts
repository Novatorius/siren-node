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

/**
 * The registries an app item, a feature, can join, as Siren names them
 * (lib/Apps/Core/Enums/AppItemKinds.php on Siren's int/preview-apps at
 * a22547327). A record selects a feature by `app:{id}`: a program for a
 * post-conversion action or an incentive resolver, a distributor for a
 * post-allocation action or a distribution resolver, an autofulfiller for a
 * payout method, a distributor's metric type for a metric calculation, and a
 * distributor for a metric filter.
 *
 * The payout kind's stored value is `payoutMethod`, the documentation's
 * word. `FulfillmentMethod` stays as an alias of the same value, as Siren's
 * `AppItemKinds::FulfillmentMethod` does, so code written against it sends
 * the new word. Siren refuses the old value `fulfillmentMethod`.
 */
export const AppItemKind = {
  PostConversionAction: 'postConversionAction',
  PostAllocationAction: 'postAllocationAction',
  PayoutMethod: 'payoutMethod',
  /** @deprecated Read `AppItemKind.PayoutMethod`. The same value, `payoutMethod`. */
  FulfillmentMethod: 'payoutMethod',
  DistributionResolver: 'distributionResolver',
  /**
   * An event of the app's own, which the app sends Siren at
   * `/event/{key}` and programs and distributors credit. It needs only the
   * app's key, never an address.
   */
  CustomEvent: 'customEvent',
  /**
   * A calculation strategy a distributor's metric type selects. Siren asks
   * the app to score a metric, and the app answers a score for each
   * collaborator. Its `scoresMoney` setting says the score is money.
   */
  MetricCalculation: 'metricCalculation',
  /**
   * A metric filter a distributor selects, which Siren names "Customer
   * filter for distributors". Siren asks the app whether one collaborator's
   * metric counts, and the app answers allow or suppress.
   */
  MetricFilter: 'metricFilter',
  /**
   * An incentive resolver a program selects. Siren asks the app how to split
   * the program's reward among the collaborators a sale, renewal or lead
   * converted, and the rewards wait for the answer, 24 hours at most.
   */
  IncentiveResolver: 'incentiveResolver',
  /**
   * An incentive type a program selects, which Siren names "Incentive
   * structure". Siren asks the app which engagements one sale, lead or
   * renewal converts and the pool the program's resolver divides. The
   * program's award waits for the answer, 24 hours at most.
   */
  IncentiveType: 'incentiveType',
} as const;

/** Which door made an app (`App::getSource()` on Siren's int/preview-apps). It never changes. */
export const AppSource = {
  /** The app file, through `PUT /apps/{key}`. */
  Code: 'code',
  /** The dashboard's "Create it here", through `POST /apps`. */
  Dashboard: 'dashboard',
  /** A connected site. */
  Site: 'site',
} as const;

/** Union of the {@link AppSource} strings. */
export type AppSource = (typeof AppSource)[keyof typeof AppSource];

/** Union of the {@link AppItemKind} strings. */
export type AppItemKind = (typeof AppItemKind)[keyof typeof AppItemKind];

/** Whether an app is on (`active`) or off (`inactive`). Siren sends an off app nothing. */
export const AppStatus = {
  Active: 'active',
  Inactive: 'inactive',
} as const;

/** Union of the {@link AppStatus} strings. */
export type AppStatus = (typeof AppStatus)[keyof typeof AppStatus];

/**
 * The statuses of a request Siren sent an app (lib/Apps/Core/Models/AppRequest.php).
 * A tell ends at `delivered`. An ask ends at `applied`, once its answer has
 * done its work. `needs_attention` waits for a person or a late answer. An
 * ask that holds a reward ends at `dropped` when the app didn't answer within
 * 24 hours, and Siren went on without it.
 */
export const AppRequestStatus = {
  Pending: 'pending',
  Sent: 'sent',
  Delivered: 'delivered',
  Answered: 'answered',
  Applied: 'applied',
  NeedsAttention: 'needs_attention',
  Dropped: 'dropped',
} as const;

/** Union of the {@link AppRequestStatus} strings. */
export type AppRequestStatus = (typeof AppRequestStatus)[keyof typeof AppRequestStatus];

/** A `tell` needs no answer. An `ask` waits for the app to post one. */
export const AppRequestMode = {
  Tell: 'tell',
  Ask: 'ask',
} as const;

/** Union of the {@link AppRequestMode} strings. */
export type AppRequestMode = (typeof AppRequestMode)[keyof typeof AppRequestMode];
