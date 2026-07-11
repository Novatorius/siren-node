/**
 * Every event type Siren can deliver to a webhook subscription, plus `All`
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
  CollaboratorCreated: 'collaborator.created',
  CollaboratorRegistered: 'collaborator.registered',
  ConversionApproved: 'conversion.approved',
  ConversionCreated: 'conversion.created',
  ConversionRejected: 'conversion.rejected',
  ConversionRenewed: 'conversion.renewed',
  CouponApplied: 'coupon.applied',
  DistributionCompleted: 'distribution.completed',
  EngagementAwarded: 'engagement.awarded',
  EngagementCompleted: 'engagement.completed',
  EngagementCreated: 'engagement.created',
  FulfillmentCreated: 'fulfillment.created',
  FulfillmentUpdated: 'fulfillment.updated',
  LeadCreated: 'lead.created',
  MetricsUpdated: 'metrics.updated',
  ObligationCompleted: 'obligation.completed',
  ObligationCreated: 'obligation.created',
  OpportunityCreated: 'opportunity.created',
  OpportunityInvalidated: 'opportunity.invalidated',
  PayoutCreated: 'payout.created',
  PayoutPaid: 'payout.paid',
  RefundCreated: 'refund.created',
  RenewalCreated: 'renewal.created',
  SaleCreated: 'sale.created',
  TransactionCompleted: 'transaction.completed',
  TransactionCreated: 'transaction.created',
} as const;

/** Union of all subscribable event-type strings (including `"*"`). */
export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];
