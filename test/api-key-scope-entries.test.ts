import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnexpectedResponseError } from '../src/index';
import { jsonResponse, makeClient } from './helpers';

/*
 * Unit tests for the entry check in apiKeys.scopes(). Each entry in a scope
 * group must be an object, so a null or a list inside a group is refused.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiKeys.scopes() entry check', () => {
  it('throws UnexpectedResponseError for a group holding null or a list', async () => {
    for (const entry of [null, ['event:sale']]) {
      const body = { events: [entry] };
      const ctx = makeClient([jsonResponse(200, body)]);
      const error = await ctx.client.apiKeys.scopes().catch((e: unknown) => e);
      expect(error, JSON.stringify(entry)).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).data).toEqual(body);
    }
  });
});
