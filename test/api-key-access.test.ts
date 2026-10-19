import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyNotAcceptedError,
  ApiKeyScope,
  AuthenticationError,
  ErrorCode,
  LEDGER_READ_SCOPES,
  MissingScopeError,
  PermissionError,
  StoreKeyNotAllowedError,
  eventScope,
} from '../src/index';
import { TEST_API_KEY, jsonResponse, makeClient } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

function coded(message: string, code: string, context: unknown = []) {
  return { error: { message, code, context } };
}

describe('API key scopes', () => {
  // Siren grants these only by their exact names, so the values are a
  // contract. Changing one would mint keys that open nothing.
  it('pins the scope strings', () => {
    expect(ApiKeyScope).toEqual({
      AllEvents: 'event:*',
      FullAccess: '*',
      Sale: 'event:sale',
      Refund: 'event:refund',
      SiteVisited: 'event:site-visited',
      LedgerConversionsRead: 'ledger:conversions:read',
      LedgerTransactionsRead: 'ledger:transactions:read',
      LedgerObligationsRead: 'ledger:obligations:read',
      LedgerPayoutsRead: 'ledger:payouts:read',
      WebhookSubscriptionsRead: 'webhook-subscriptions:read',
      WebhookSubscriptionsManage: 'webhook-subscriptions:manage',
    });
    expect(LEDGER_READ_SCOPES).toEqual([
      'ledger:conversions:read',
      'ledger:transactions:read',
      'ledger:obligations:read',
      'ledger:payouts:read',
    ]);
  });

  it('builds one event scope and refuses an empty slug', () => {
    expect(eventScope('loyalty-points-earned')).toBe('event:loyalty-points-earned');
    expect(() => eventScope('')).toThrow(TypeError);
  });

  it('sends the ledger and webhook scopes when creating a key', async () => {
    const ctx = makeClient([jsonResponse(201, { id: 5, label: '', rawKey: 'sk_live_x' })]);

    await ctx.client.apiKeys.create({
      label: 'Accounting export',
      scopes: [
        ...LEDGER_READ_SCOPES,
        ApiKeyScope.WebhookSubscriptionsRead,
        ApiKeyScope.WebhookSubscriptionsManage,
      ],
    });

    expect(ctx.lastCall().body).toEqual({
      label: 'Accounting export',
      scopes: [
        'ledger:conversions:read',
        'ledger:transactions:read',
        'ledger:obligations:read',
        'ledger:payouts:read',
        'webhook-subscriptions:read',
        'webhook-subscriptions:manage',
      ],
    });
  });
});

describe('ledger reads and webhook subscriptions with an API key', () => {
  it('reads conversions with the key and narrows to one store', async () => {
    const ctx = makeClient([jsonResponse(200, { items: [{ id: 9 }], total: 1 })]);

    const page = await ctx.client.conversions.list({ propertyId: 5, status: 'approved' });

    const call = ctx.lastCall();
    expect(call.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    const url = new URL(call.url);
    expect(url.pathname).toBe('/siren/v1/conversions');
    expect(Object.fromEntries(url.searchParams)).toEqual({ propertyId: '5', status: 'approved' });
    expect([...page]).toEqual([{ id: 9 }]);
  });

  it('reads payouts, obligations and transactions with the key', async () => {
    const ctx = makeClient([jsonResponse(200, { items: [], total: 0 })]);

    for (const resource of [ctx.client.payouts, ctx.client.obligations, ctx.client.transactions]) {
      await resource.list();
      expect(ctx.lastCall().headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    }
    expect(ctx.calls().map((call) => new URL(call.url).pathname)).toEqual([
      '/siren/v1/payouts',
      '/siren/v1/obligations',
      '/siren/v1/transactions',
    ]);
  });

  it('manages webhook subscriptions with the key', async () => {
    const ctx = makeClient([
      jsonResponse(201, { id: 4, signingSecret: 'whsec_x' }),
      jsonResponse(200, [{ id: 4 }]),
    ]);

    await ctx.client.webhooks.subscriptions.create({ targetUrl: 'https://example.com/hook', events: ['*'] });
    expect(ctx.lastCall().method).toBe('POST');
    expect(ctx.lastCall().headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);

    expect(await ctx.client.webhooks.subscriptions.list()).toEqual([{ id: 4 }]);
  });
});

describe('API key refusals', () => {
  it('names every scope that opens the route on missing_scope', async () => {
    const ctx = makeClient([
      jsonResponse(
        403,
        coded("This API key does not have the 'webhook-subscriptions:read' scope.", 'missing_scope', {
          scope: 'webhook-subscriptions:read',
          anyOf: ['webhook-subscriptions:read', 'webhook-subscriptions:manage'],
        }),
      ),
    ]);

    const err = await ctx.client.webhooks.subscriptions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingScopeError);
    expect(err).toBeInstanceOf(PermissionError);
    const missing = err as MissingScopeError;
    expect(missing.code).toBe(ErrorCode.MissingScope);
    expect(missing.statusCode).toBe(403);
    expect(missing.scope).toBe('webhook-subscriptions:read');
    expect(missing.anyOf).toEqual(['webhook-subscriptions:read', 'webhook-subscriptions:manage']);
  });

  it('leaves anyOf empty when Siren lists no scopes', async () => {
    const ctx = makeClient([
      jsonResponse(403, coded('This older organization key sends events only.', 'missing_scope')),
    ]);

    const err = (await ctx.client.conversions.list().catch((e: unknown) => e)) as MissingScopeError;
    expect(err).toBeInstanceOf(MissingScopeError);
    expect(err.anyOf).toEqual([]);
    expect(err.scope).toBeUndefined();
  });

  it('raises StoreKeyNotAllowedError for a store-bound key on payouts', async () => {
    const ctx = makeClient([
      jsonResponse(
        403,
        coded('This API key is bound to one store, and these records are not kept by store.', 'store_key_not_allowed', {
          propertyId: 5,
        }),
      ),
    ]);

    const err = (await ctx.client.payouts.list().catch((e: unknown) => e)) as StoreKeyNotAllowedError;
    expect(err).toBeInstanceOf(StoreKeyNotAllowedError);
    expect(err).toBeInstanceOf(PermissionError);
    expect(err.code).toBe(ErrorCode.StoreKeyNotAllowed);
    expect(err.propertyId).toBe(5);
  });

  it('raises ApiKeyNotAcceptedError on a route that takes a session, without retrying', async () => {
    const ctx = makeClient([
      jsonResponse(401, coded('This route does not accept API keys.', 'api_key_not_accepted')),
    ]);

    const err = await ctx.client.apiKeys.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiKeyNotAcceptedError);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as ApiKeyNotAcceptedError).code).toBe(ErrorCode.ApiKeyNotAccepted);
    expect((err as ApiKeyNotAcceptedError).statusCode).toBe(401);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a plain 401 an AuthenticationError', async () => {
    const ctx = makeClient([jsonResponse(401, { error: { message: 'Invalid API key.', context: [] } })]);

    const err = await ctx.client.conversions.list().catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(AuthenticationError);
  });
});
