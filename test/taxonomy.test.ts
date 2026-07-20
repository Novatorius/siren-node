import { describe, expect, it } from 'vitest';

import {
  ApiKeyStatus,
  ConversionStatus,
  EventSlug,
  FulfillmentStatus,
  ObligationStatus,
  OpportunityStatus,
  PayoutStatus,
  TransactionStatus,
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../src/index';

/**
 * These tests pin the SDK's taxonomy to Siren's canonical vocabulary. If one
 * fails, either the SDK drifted or the Siren service changed its domain
 * language — reconcile against the service (the taxonomy owner), not by
 * editing the expectation to match the code.
 */

describe('WebhookEventType', () => {
  it('matches the canonical set of subscribable events', () => {
    expect(Object.values(WebhookEventType).sort()).toEqual(
      [
        '*',
        'allocation.completed',
        'collaborator.created',
        'collaborator.registered',
        'conversion.approved',
        'conversion.created',
        'conversion.rejected',
        'conversion.renewed',
        'coupon.applied',
        'credit.issued',
        'credit.redeemed',
        'currency.created',
        'currency.deleted',
        'distribution.completed',
        'engagement.awarded',
        'engagement.completed',
        'engagement.created',
        'fulfillment.created',
        'fulfillment.updated',
        'lead.created',
        'metrics.updated',
        'obligation.completed',
        'obligation.created',
        'opportunity.created',
        'opportunity.invalidated',
        'payout.created',
        'payout.paid',
        'refund.created',
        'renewal.created',
        'sale.created',
        'transaction.completed',
        'transaction.created',
      ].sort(),
    );
  });

  it('has no duplicate values', () => {
    const values = Object.values(WebhookEventType);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('EventSlug', () => {
  it('matches the built-in ingestion slugs', () => {
    expect(Object.values(EventSlug).sort()).toEqual(['refund', 'sale', 'site-visited']);
  });
});

describe('status vocabularies', () => {
  it('ConversionStatus matches the canonical set', () => {
    expect(Object.values(ConversionStatus).sort()).toEqual([
      'approved',
      'deleted',
      'expired',
      'pending',
      'rejected',
    ]);
  });

  it('TransactionStatus matches the canonical set', () => {
    expect(Object.values(TransactionStatus).sort()).toEqual([
      'cancelled',
      'complete',
      'refunded',
    ]);
  });

  it('ObligationStatus matches the canonical set', () => {
    expect(Object.values(ObligationStatus).sort()).toEqual([
      'cancelled',
      'complete',
      'fulfilled',
      'pending',
    ]);
  });

  it('PayoutStatus matches the canonical set', () => {
    expect(Object.values(PayoutStatus).sort()).toEqual([
      'failed',
      'paid',
      'processing',
      'unpaid',
    ]);
  });

  it('FulfillmentStatus matches the canonical set', () => {
    expect(Object.values(FulfillmentStatus).sort()).toEqual([
      'complete',
      'failed',
      'pending',
      'processing',
    ]);
  });

  it('OpportunityStatus matches the canonical set', () => {
    expect(Object.values(OpportunityStatus).sort()).toEqual(['active', 'inactive', 'invalid']);
  });

  it('ApiKeyStatus matches the canonical set', () => {
    expect(Object.values(ApiKeyStatus).sort()).toEqual(['active', 'revoked']);
  });

  it('WebhookSubscriptionStatus matches the canonical set', () => {
    expect(Object.values(WebhookSubscriptionStatus).sort()).toEqual(['active', 'paused']);
  });
});
