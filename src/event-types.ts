/**
 * Every event type Siren can deliver to a webhook subscription, matching the
 * list Siren serves at `GET /webhooks/events`, plus `All`
 * (`"*"`) to subscribe to everything. Use these constants instead of raw
 * strings for autocomplete and typo protection:
 *
 * ```ts
 * await siren.webhooks.subscriptions.create({
 *   targetUrl: 'https://example.com/webhooks/siren',
 *   events: [WebhookEventType.ConversionApproved, WebhookEventType.PayoutPaid],
 * });
 * ```
 */
export const WebhookEventType = {
  /** Subscribe to all event types. */
  All: '*',
  AllocationCompleted: 'allocation.completed',
  CollaboratorApplied: 'collaborator.applied',
  CollaboratorCreated: 'collaborator.created',
  CollaboratorDeactivated: 'collaborator.deactivated',
  CollaboratorDeclined: 'collaborator.declined',
  CollaboratorDeleted: 'collaborator.deleted',
  CollaboratorGroupCreated: 'collaborator_group.created',
  CollaboratorGroupDeleted: 'collaborator_group.deleted',
  CollaboratorGroupMemberAdded: 'collaborator_group.member_added',
  CollaboratorGroupMemberRemoved: 'collaborator_group.member_removed',
  CollaboratorGroupUpdated: 'collaborator_group.updated',
  CollaboratorJoined: 'collaborator.joined',
  CollaboratorRegistered: 'collaborator.registered',
  CollaboratorUpdated: 'collaborator.updated',
  ConversionApproved: 'conversion.approved',
  ConversionCreated: 'conversion.created',
  ConversionRejected: 'conversion.rejected',
  ConversionRenewed: 'conversion.renewed',
  CouponApplied: 'coupon.applied',
  CouponLinked: 'coupon.linked',
  CouponMerged: 'coupon.merged',
  CouponUnlinked: 'coupon.unlinked',
  CreditIssued: 'credit.issued',
  CreditRedeemed: 'credit.redeemed',
  CurrencyCreated: 'currency.created',
  CurrencyDeleted: 'currency.deleted',
  DistributionCompleted: 'distribution.completed',
  DistributorCreated: 'distributor.created',
  DistributorDeleted: 'distributor.deleted',
  DistributorUpdated: 'distributor.updated',
  EngagementAwarded: 'engagement.awarded',
  EngagementCompleted: 'engagement.completed',
  EngagementCreated: 'engagement.created',
  FulfillmentCreated: 'fulfillment.created',
  FulfillmentUpdated: 'fulfillment.updated',
  LeadCreated: 'lead.created',
  MetricsUpdated: 'metrics.updated',
  ObligationApproved: 'obligation.approved',
  ObligationCompleted: 'obligation.completed',
  ObligationCreated: 'obligation.created',
  ObligationRejected: 'obligation.rejected',
  ObligationSuperseded: 'obligation.superseded',
  OpportunityCreated: 'opportunity.created',
  OpportunityInvalidated: 'opportunity.invalidated',
  PayoutCreated: 'payout.created',
  PayoutFailed: 'payout.failed',
  PayoutPaid: 'payout.paid',
  PayoutWaiting: 'payout.waiting',
  ProductMerged: 'product.merged',
  ProgramCreated: 'program.created',
  ProgramDeleted: 'program.deleted',
  ProgramGroupCreated: 'program_group.created',
  ProgramGroupDeleted: 'program_group.deleted',
  ProgramGroupUpdated: 'program_group.updated',
  ProgramStatusChanged: 'program.status_changed',
  ProgramUpdated: 'program.updated',
  RefundCreated: 'refund.created',
  RefundRecorded: 'refund.recorded',
  RenewalCreated: 'renewal.created',
  SaleCreated: 'sale.created',
  StoreConnected: 'store.connected',
  StoreDisconnected: 'store.disconnected',
  TransactionCompleted: 'transaction.completed',
  TransactionCreated: 'transaction.created',
} as const;

/** Union of all subscribable event-type strings (including `"*"`). */
export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];
