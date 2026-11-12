import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyNotAcceptedError, MissingScopeError, UnexpectedResponseError } from '../src/index';
import { jsonResponse, makeClient } from './helpers';

/*
 * Slice 1 acceptance tests: the two catalog reads the Siren PHP SDK has and
 * this SDK lacked, `webhooks.subscriptions.events()` and `apiKeys.scopes()`.
 *
 * The fixtures hold Siren's answers as its controllers build them at
 * bb49b7d. `scripts/siren-fixtures.mjs` generates both from Siren's source
 * and, with `--check`, reports a fixture that no longer matches it. Each
 * fixture's `_source` names the files it came from.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else in this file.
 */

function fixture<T>(name: string): T {
  const parsed = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as {
    body: T;
  };
  return parsed.body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P6: webhooks.subscriptions.events()', () => {
  const catalog = fixture<Array<{ event: string; category: string; label: string }>>('webhook-events.json');

  it.skip('GETs /webhooks/events and returns every entry as Siren sent it', async () => {
    const ctx = makeClient([jsonResponse(200, catalog)]);
    const events = await ctx.client.webhooks.subscriptions.events();

    const call = ctx.lastCall();
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/webhooks/events');
    expect(call.rawBody).toBeUndefined();
    expect(events).toEqual(catalog);
    expect(events).toHaveLength(64);
    expect(events[0]).toEqual({ event: 'sale.created', category: 'Sales', label: 'A sale was recorded' });
  });

  it.skip('keeps an event this SDK does not know yet', async () => {
    const future = { event: 'loyalty.tier_changed', category: 'Loyalty', label: 'A tier changed' };
    const ctx = makeClient([jsonResponse(200, [future])]);
    expect(await ctx.client.webhooks.subscriptions.events()).toEqual([future]);
  });

  it.skip('throws UnexpectedResponseError when an entry is not an object', async () => {
    const entry = catalog[0]!;
    for (const bad of ['sale.created', null, 7, ['x']]) {
      const body = [entry, bad];
      const ctx = makeClient([jsonResponse(200, body)]);
      const error = await ctx.client.webhooks.subscriptions.events().catch((e: unknown) => e);
      expect(error, JSON.stringify(bad)).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).statusCode).toBe(200);
      expect((error as UnexpectedResponseError).data).toEqual(body);
      expect((error as UnexpectedResponseError).message).toContain('/webhooks/events');
    }
  });

  it.skip('throws UnexpectedResponseError when the body is not a list', async () => {
    for (const body of [{ events: catalog }, null, 'events']) {
      const ctx = makeClient([jsonResponse(200, body)]);
      const error = await ctx.client.webhooks.subscriptions.events().catch((e: unknown) => e);
      expect(error, JSON.stringify(body)).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).statusCode).toBe(200);
      expect((error as UnexpectedResponseError).data).toEqual(body);
      expect((error as UnexpectedResponseError).message).toContain('/webhooks/events');
    }
  });

  it.skip('goes through the shared transport retry for a 503, like list()', async () => {
    const ctx = makeClient(
      [jsonResponse(503, { error: 'unavailable' }, { 'Retry-After': '0' }), jsonResponse(200, catalog)],
      { maxRetries: 1 },
    );
    expect(await ctx.client.webhooks.subscriptions.events()).toHaveLength(64);
    expect(ctx.calls()).toHaveLength(2);
  });

  it.skip('throws MissingScopeError for a key without a webhook scope', async () => {
    const ctx = makeClient(
      [
        jsonResponse(403, {
          error: {
            message: 'This API key is missing a scope.',
            code: 'missing_scope',
            context: { anyOf: ['webhook-subscriptions:read', 'webhook-subscriptions:manage'] },
          },
        }),
      ],
      { maxRetries: 0 },
    );
    const error = await ctx.client.webhooks.subscriptions.events().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingScopeError);
    expect((error as MissingScopeError).anyOf).toEqual(['webhook-subscriptions:read', 'webhook-subscriptions:manage']);
  });
});

describe('P7: apiKeys.scopes()', () => {
  const groups = fixture<Record<string, Array<{ scope: string; resource: string; action: string; label: string }>>>(
    'api-key-scopes.json',
  );

  it.skip('GETs /api-keys/scopes and returns the groups as Siren sent them', async () => {
    const ctx = makeClient([jsonResponse(200, groups)]);
    const scopes = await ctx.client.apiKeys.scopes();

    const call = ctx.lastCall();
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/api-keys/scopes');
    expect(call.rawBody).toBeUndefined();
    expect(scopes).toEqual(groups);
    expect(scopes.events).toHaveLength(31);
    expect(scopes.events?.[1]).toEqual({
      scope: 'event:site-visited',
      resource: 'events',
      action: 'site-visited',
      label: 'Site Visited',
    });
    expect(scopes.ledger?.map((entry) => entry.scope)).toContain('ledger:conversions:read');
    expect(scopes['webhook-subscriptions']?.map((entry) => entry.scope)).toEqual([
      'webhook-subscriptions:read',
      'webhook-subscriptions:manage',
    ]);
    expect(scopes['records:programs']?.[0]).toEqual({
      scope: 'records:programs:read',
      resource: 'records:programs',
      action: 'read',
      label: 'Read programs',
    });
  });

  it.skip('throws UnexpectedResponseError when the body is not an object or a group is not a list', async () => {
    for (const body of [[], [groups], null, 'scopes', { ...groups, events: 'event:sale' }]) {
      const ctx = makeClient([jsonResponse(200, body)]);
      const error = await ctx.client.apiKeys.scopes().catch((e: unknown) => e);
      expect(error, JSON.stringify(body).slice(0, 40)).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).statusCode).toBe(200);
      expect((error as UnexpectedResponseError).data).toEqual(body);
      expect((error as UnexpectedResponseError).message).toContain('/api-keys/scopes');
    }
  });

  it.skip('goes through the shared transport retry for a 503, like list()', async () => {
    const ctx = makeClient(
      [jsonResponse(503, { error: 'unavailable' }, { 'Retry-After': '0' }), jsonResponse(200, groups)],
      { maxRetries: 1 },
    );
    expect(await ctx.client.apiKeys.scopes()).toEqual(groups);
    expect(ctx.calls()).toHaveLength(2);
  });

  it.skip('throws ApiKeyNotAcceptedError when called with an API key', async () => {
    const ctx = makeClient(
      [jsonResponse(401, { error: { message: 'This route does not accept API keys.', code: 'api_key_not_accepted' } })],
      { maxRetries: 0 },
    );
    const error = await ctx.client.apiKeys.scopes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiKeyNotAcceptedError);
  });
});
