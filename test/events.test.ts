import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, makeClient } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('events.sale', () => {
  it('POSTs to /event/sale with the exact payload, total in major units', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '4021' })]);
    await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'cs_test_a1b2c3',
      total: 49.99,
      trackingId: 4021,
      currency: 'EUR',
    });

    const call = ctx.lastCall();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/event/sale');
    expect(call.body).toEqual({
      source: 'stripe',
      externalId: 'cs_test_a1b2c3',
      total: 49.99,
      trackingId: 4021,
      currency: 'EUR',
    });
  });

  it('defaults a missing line-item quantity to 1 and preserves explicit quantities', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '7' })]);
    await ctx.client.events.sale({
      source: 'woocommerce',
      externalId: 'order-88',
      total: 159.97,
      trackingId: 99,
      items: [
        { name: 'Pro Plan (annual)', amount: 49.99 },
        { externalId: 'sku-2', name: 'Add-on seat', quantity: 3, amount: 36.66 },
      ],
    });

    const body = ctx.lastCall().body as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      { name: 'Pro Plan (annual)', amount: 49.99, quantity: 1 },
      { externalId: 'sku-2', name: 'Add-on seat', quantity: 3, amount: 36.66 },
    ]);
  });

  it('omits items entirely when not provided (total becomes a single line server-side)', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '7' })]);
    await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 1,
    });

    expect(ctx.lastCall().body).not.toHaveProperty('items');
  });

  it('reads opportunityId from the X-Siren-OID response header', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '4021' })]);
    const result = await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 1,
    });

    expect(result).toEqual({ opportunityId: 4021 });
  });

  it('returns an empty result when the header is absent', async () => {
    const ctx = makeClient([emptyResponse(200)]);
    const result = await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 1,
    });

    expect(result.opportunityId).toBeUndefined();
  });
});

describe('events.refund', () => {
  it('POSTs source and externalId to /event/refund', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '12' })]);
    const result = await ctx.client.events.refund({
      source: 'stripe',
      externalId: 'cs_test_a1b2c3',
    });

    const call = ctx.lastCall();
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/event/refund');
    expect(call.body).toEqual({ source: 'stripe', externalId: 'cs_test_a1b2c3' });
    expect(result).toEqual({ opportunityId: 12 });
  });
});

describe('events.siteVisited', () => {
  it('POSTs to /event/site-visited with collaboratorId and optional userId', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '555' })]);
    const result = await ctx.client.events.siteVisited({ collaboratorId: 88, userId: 12345 });

    const call = ctx.lastCall();
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/event/site-visited');
    expect(call.body).toEqual({ collaboratorId: 88, userId: 12345 });
    expect(result).toEqual({ opportunityId: 555 });
  });
});

describe('events.ingest', () => {
  it('POSTs the payload through unchanged to /event/{slug}', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '9' })]);
    const payload = { userId: 42, points: 100, reason: 'review' };
    const result = await ctx.client.events.ingest('loyalty-points-earned', payload);

    const call = ctx.lastCall();
    expect(call.url).toBe(
      'https://api.sirenaffiliates.com/siren/v1/event/loyalty-points-earned',
    );
    expect(call.body).toEqual(payload);
    expect(result).toEqual({ opportunityId: 9 });
  });
});
