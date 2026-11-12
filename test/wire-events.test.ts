import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefundKind } from '../src/index';
import { emptyResponse, jsonResponse, makeClient } from './helpers';

/*
 * Slice 1 acceptance tests: the event fields Siren reads that the SDK did not
 * type before. Each test sends one call and asserts the exact JSON body that
 * reaches the network, which is where Siren reads the field.
 *
 * Field rules come from Siren bb49b7d:
 * - lib/Events/Core/Factories/SaleEventFactory.php (items[].lineId, test)
 * - lib/Events/Core/Factories/RefundEventFactory.php (refundId, amount,
 *   currency, lines, whole, kind)
 * - lib/Collaborators/Service/Middlewares/CollaboratorAliasResolverMiddleware.php
 *   (collaboratorId as tracking:{code})
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('events.sale wire fields', () => {
  it('sends each line item lineId unchanged, beside the defaulted quantity', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '7' })]);
    await ctx.client.events.sale({
      source: 'woocommerce',
      externalId: 'order-88',
      total: 59.98,
      trackingId: 99,
      items: [
        { externalId: 'sku-1', lineId: 'line-501', amount: 49.99 },
        { externalId: 'sku-2', lineId: 502, quantity: 1, amount: 9.99 },
      ],
    });

    expect(ctx.lastCall().body).toEqual({
      source: 'woocommerce',
      externalId: 'order-88',
      total: 59.98,
      trackingId: 99,
      items: [
        { externalId: 'sku-1', lineId: 'line-501', amount: 49.99, quantity: 1 },
        { externalId: 'sku-2', lineId: 502, quantity: 1, amount: 9.99 },
      ],
    });
  });

  it('sends a test sale with test: true and no other field', async () => {
    const ctx = makeClient([
      jsonResponse(200, { status: 'created', created: true, transactionId: 12, conversions: [], test: true }),
    ]);
    const result = await ctx.client.events.sale({ test: true });

    const call = ctx.lastCall();
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/event/sale');
    expect(call.body).toEqual({ test: true });
    expect(result.body).toMatchObject({ test: true });
  });

  it('sends a test sale with its optional fields and no trackingId', async () => {
    const ctx = makeClient([jsonResponse(200, { status: 'created', test: true })]);
    await ctx.client.events.sale({ test: true, source: 'medusa', externalId: 'order_01J', total: 10 });

    expect(ctx.lastCall().body).toEqual({ test: true, source: 'medusa', externalId: 'order_01J', total: 10 });
  });
});

describe('events.refund wire fields', () => {
  it('sends a partial refund with amount, currency and named lines', async () => {
    const ctx = makeClient([emptyResponse(200)]);
    await ctx.client.events.refund({
      source: 'woocommerce',
      externalId: 1001,
      refundId: 2201,
      amount: 12.5,
      currency: 'EUR',
      lines: [
        { lineId: 'line-501', quantity: 1, amount: 10 },
        { sku: 'HAT-RED', quantity: 1, amount: 2.5 },
      ],
    });

    const call = ctx.lastCall();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/event/refund');
    expect(call.body).toEqual({
      source: 'woocommerce',
      externalId: 1001,
      refundId: 2201,
      amount: 12.5,
      currency: 'EUR',
      lines: [
        { lineId: 'line-501', quantity: 1, amount: 10 },
        { sku: 'HAT-RED', quantity: 1, amount: 2.5 },
      ],
    });
  });

  it('sends a whole cancellation with whole: true and kind cancelled', async () => {
    const ctx = makeClient([emptyResponse(200)]);
    await ctx.client.events.refund({
      source: 'medusa',
      externalId: 'order_01J',
      refundId: 'cancel:order_01J',
      whole: true,
      kind: RefundKind.Cancelled,
    });

    expect(ctx.lastCall().body).toEqual({
      source: 'medusa',
      externalId: 'order_01J',
      refundId: 'cancel:order_01J',
      whole: true,
      kind: 'cancelled',
    });
  });
});

describe('events.siteVisited wire fields', () => {
  it('sends a tracking code reference as collaboratorId', async () => {
    const ctx = makeClient([
      jsonResponse(200, { status: 'attributed', attributed: true, opportunityId: 318 }),
    ]);
    const result = await ctx.client.events.siteVisited({ collaboratorId: 'tracking:summer-sale' });

    const call = ctx.lastCall();
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/event/site-visited');
    expect(call.body).toEqual({ collaboratorId: 'tracking:summer-sale' });
    expect(result.opportunityId).toBe(318);
  });

  it('still sends a numeric collaboratorId as a number', async () => {
    const ctx = makeClient([emptyResponse(200, { 'X-Siren-OID': '5' })]);
    await ctx.client.events.siteVisited({ collaboratorId: 42, userId: 7 });

    expect(ctx.lastCall().body).toEqual({ collaboratorId: 42, userId: 7 });
  });
});
