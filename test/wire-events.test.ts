import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RefundKind } from '../src/index';
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
 * - lib/Events/Core/Factories/SiteVisitedFactory.php (every visit received is
 *   recorded, so a visit is sent once)
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else in this file.
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
    expect(result.status).toBe('created');
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

describe('event sends on a 503', () => {
  const unavailable = () => jsonResponse(503, { error: 'unavailable' }, { 'Retry-After': '0' });

  it('retries a sale, since Siren answers a replay of the same source and externalId with the first result', async () => {
    const ctx = makeClient([unavailable(), emptyResponse(200)], { maxRetries: 1 });
    await ctx.client.events.sale({ source: 'woocommerce', externalId: 'order-88', total: 10, trackingId: 9 });
    expect(ctx.calls()).toHaveLength(2);
  });

  it('retries a refund, since Siren records each refundId once per order', async () => {
    const ctx = makeClient([unavailable(), emptyResponse(200)], { maxRetries: 1 });
    await ctx.client.events.refund({ source: 'woocommerce', externalId: 'order-88', refundId: 2201 });
    expect(ctx.calls()).toHaveLength(2);
  });
});

describe('P9: events.siteVisited is sent once', () => {
  it.skip('sends a visit once on a 503, even with retries on, because Siren records every visit it receives', async () => {
    const ctx = makeClient(
      [
        jsonResponse(503, { error: 'unavailable' }, { 'Retry-After': '0' }),
        jsonResponse(200, { status: 'attributed', attributed: true, opportunityId: 318 }),
      ],
      { maxRetries: 2 },
    );
    const error = await ctx.client.events.siteVisited({ collaboratorId: 42 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(503);
    expect(ctx.calls()).toHaveLength(1);
  });

  it.skip('sends a visit once when the connection fails, even with retries on', async () => {
    const ctx = makeClient(
      [new TypeError('fetch failed'), jsonResponse(200, { status: 'recorded', attributed: false, opportunityId: 5 })],
      { maxRetries: 2 },
    );
    await ctx.client.events.siteVisited({ collaboratorId: 42 }).catch(() => undefined);
    expect(ctx.calls()).toHaveLength(1);
  });
});
