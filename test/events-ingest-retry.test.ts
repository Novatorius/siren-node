import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, makeClient } from './helpers';

/*
 * Packet P9 makes events.siteVisited send once. events.ingest keeps the retry
 * rule it had before, so a custom event is still resent on a 503. This pins
 * that the change to send() did not reach ingest.
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
