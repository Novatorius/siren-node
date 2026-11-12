import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, makeClient } from './helpers';

/*
 * events.ingest retries a 503 up to maxRetries, unlike events.siteVisited,
 * which is sent once.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('events.ingest retry rule', () => {
  it('retries a custom event on a 503 up to maxRetries', async () => {
    const ctx = makeClient(
      [jsonResponse(503, { error: 'unavailable' }, { 'Retry-After': '0' }), emptyResponse(200)],
      { maxRetries: 1 },
    );
    await ctx.client.events.ingest('loyalty-points-earned', { userId: 42, points: 100 });
    expect(ctx.calls()).toHaveLength(2);
    expect(ctx.lastCall().url).toBe('https://api.sirenaffiliates.com/siren/v1/event/loyalty-points-earned');
  });
});
