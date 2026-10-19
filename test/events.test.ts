import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, makeClient } from './helpers';

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

// Siren returns a body for sales and site visits that says what happened
// (SaleEventFactory and SiteVisitedFactory in the Siren repo), and queues an
// event with a 202 while the organization's engine is paused
// (IngestEvent::queue()). The SDK used to drop the body.
describe('event outcomes', () => {
  it('exposes the sale outcome body and its status', async () => {
    const outcome = {
      status: 'created',
      created: true,
      transactionId: 77,
      conversions: [{ id: 301, status: 'pending' }],
      message: 'The sale was recorded.',
    };
    const ctx = makeClient([jsonResponse(200, outcome, { 'X-Siren-OID': '4021' })]);
    const result = await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 4021,
    });

    expect(result.opportunityId).toBe(4021);
    expect(result.status).toBe('created');
    expect(result.queued).toBeUndefined();
    expect(result.body).toEqual(outcome);
  });

  it('reports a duplicate sale without treating it as an error', async () => {
    const ctx = makeClient([
      jsonResponse(200, { status: 'duplicate', created: false, transactionId: 77, conversions: [], message: 'Seen.' }),
    ]);
    const result = await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 1,
    });

    expect(result.status).toBe('duplicate');
  });

  it('marks a queued event and keeps it a success', async () => {
    const ctx = makeClient([
      jsonResponse(202, { status: 'queued', queued: true, message: 'Engine activity is paused.' }),
    ]);
    const result = await ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 1,
    });

    expect(result.queued).toBe(true);
    expect(result.status).toBe('queued');
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a queued visit opportunityId from the body when the header is absent', async () => {
    const ctx = makeClient([
      jsonResponse(202, {
        status: 'queued',
        queued: true,
        attributed: false,
        opportunityId: 9001,
        message: 'Queued.',
      }),
    ]);
    const result = await ctx.client.events.siteVisited({ collaboratorId: 88 });

    expect(result.opportunityId).toBe(9001);
    expect(result.queued).toBe(true);
  });

  it('prefers the X-Siren-OID header over the body', async () => {
    const ctx = makeClient([
      jsonResponse(200, { status: 'attributed', attributed: true, opportunityId: 5 }, { 'X-Siren-OID': '6' }),
    ]);
    const result = await ctx.client.events.siteVisited({ collaboratorId: 88 });

    expect(result.opportunityId).toBe(6);
    expect(result.status).toBe('attributed');
  });

  it('reports a visit Siren did not attribute', async () => {
    const ctx = makeClient([
      jsonResponse(200, {
        status: 'not_attributed',
        attributed: false,
        opportunityId: null,
        reason: 'collaborator_not_found',
        message: 'No collaborator with that id.',
      }),
    ]);
    const result = await ctx.client.events.siteVisited({ collaboratorId: 404 });

    expect(result.status).toBe('not_attributed');
    expect(result.opportunityId).toBeUndefined();
    expect(result.body?.reason).toBe('collaborator_not_found');
  });
});
