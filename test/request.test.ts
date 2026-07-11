import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/index';
import { SirenError, ConnectionError } from '../src/index';
import { emptyResponse, jsonResponse, makeClient, TEST_API_KEY } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('client construction', () => {
  it('requires an apiKey', () => {
    // @ts-expect-error intentionally missing apiKey
    expect(() => new Siren({})).toThrow(SirenError);
    expect(() => new Siren({ apiKey: '' })).toThrow(/apiKey is required/);
  });
});

describe('request construction', () => {
  it('sends the Authorization bearer header on every request', async () => {
    const ctx = makeClient([jsonResponse(200, [])]);
    await ctx.client.conversions.list();

    expect(ctx.lastCall().headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(ctx.lastCall().headers.Accept).toBe('application/json');
  });

  it('defaults the base URL to the production API', async () => {
    const ctx = makeClient([jsonResponse(200, [])]);
    await ctx.client.conversions.list();

    expect(ctx.lastCall().url).toBe('https://api.sirenaffiliates.com/siren/v1/conversions');
  });

  it('honors a custom baseUrl and strips trailing slashes', async () => {
    const ctx = makeClient([jsonResponse(200, [])], {
      baseUrl: 'http://localhost:8080/siren/v1/',
    });
    await ctx.client.payouts.list();

    expect(ctx.lastCall().url).toBe('http://localhost:8080/siren/v1/payouts');
  });

  it('serializes pagination and passthrough filters as query params', async () => {
    const ctx = makeClient([jsonResponse(200, [])]);
    await ctx.client.transactions.list({ page: 2, perPage: 50, status: 'completed' });

    const url = new URL(ctx.lastCall().url);
    expect(url.pathname).toBe('/siren/v1/transactions');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('perPage')).toBe('50');
    expect(url.searchParams.get('status')).toBe('completed');
  });

  it('omits undefined query params', async () => {
    const ctx = makeClient([jsonResponse(200, [])]);
    await ctx.client.obligations.list({ page: 1, status: undefined });

    const url = new URL(ctx.lastCall().url);
    expect(url.searchParams.has('status')).toBe(false);
  });

  it('sends JSON bodies with the JSON content type', async () => {
    const ctx = makeClient([emptyResponse(200)]);
    await ctx.client.events.refund({ source: 'stripe', externalId: 'ord_1' });

    const call = ctx.lastCall();
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({ source: 'stripe', externalId: 'ord_1' });
  });

  it('returns a list endpoint body as a bare array (no data envelope)', async () => {
    const ctx = makeClient([
      jsonResponse(200, [{ id: 1 }, { id: 2 }], {
        'x-siren-estimated-count': '2',
      }),
    ]);
    const conversions = await ctx.client.conversions.list();

    expect(Array.isArray(conversions)).toBe(true);
    expect(conversions).toEqual([{ id: 1 }, { id: 2 }]);
    expect(conversions.estimatedCount).toBe(2);
  });

  it('derives estimatedCount from the x-siren-estimated-count header only', async () => {
    const ctx = makeClient([
      jsonResponse(200, [{ id: 9 }], { 'x-siren-estimated-count': '4210' }),
    ]);
    const page = await ctx.client.payouts.list();

    expect(page).toHaveLength(1);
    expect(page.estimatedCount).toBe(4210);
  });

  it('leaves estimatedCount undefined when the header is absent', async () => {
    const ctx = makeClient([jsonResponse(200, [{ id: 1 }])]);
    const page = await ctx.client.transactions.list();

    expect(page.estimatedCount).toBeUndefined();
  });

  it('wraps network failures in ConnectionError', async () => {
    const ctx = makeClient([new TypeError('fetch failed')], { maxRetries: 0 });

    const err = await ctx.client.conversions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).message).toContain('fetch failed');
  });
});
