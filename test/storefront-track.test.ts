import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOKEN_URL, createTracker } from '../src/storefront';
import { jsonResponse } from './helpers';

/*
 * Slice C13 (apps-event-tokens): `track` in the browser-safe storefront
 * module asks the app's own server for a browser token, keeps it, and sends
 * the event to Siren with it in the query.
 */

const SEND_URL = 'https://api.example.test/siren/v1/event/signup';

function fakeFetch(options: { token?: (count: number) => Response; send?: (count: number) => Response } = {}) {
  let tokens = 0;
  let sends = 0;
  const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
    if (url === DEFAULT_TOKEN_URL || url === '/custom/token') {
      tokens += 1;
      return options.token?.(tokens) ?? jsonResponse(200, { token: `jwt-${tokens}`, expiresIn: 600, url: SEND_URL });
    }
    sends += 1;
    return options.send?.(sends) ?? jsonResponse(200, { status: 'recorded' });
  });
  const urls = () => fetchMock.mock.calls.map(([url]) => url);
  const inits = () => fetchMock.mock.calls.map(([, init]) => init);
  return { fetchMock, urls, inits };
}

describe('track', () => {
  it('gets a browser token from the app server, then posts the data to Siren with it in the query', async () => {
    const fake = fakeFetch();
    const track = createTracker({ fetch: fake.fetchMock });

    const answer = await track('signup', { collaboratorId: 12 });

    expect(answer).toEqual({ status: 'recorded' });
    expect(fake.urls()).toEqual([DEFAULT_TOKEN_URL, `${SEND_URL}?access_token=jwt-1`]);
    const [tokenInit, sendInit] = fake.inits();
    expect(JSON.parse(tokenInit?.body as string)).toEqual({ event: 'signup' });
    expect(tokenInit?.credentials).toBe('same-origin');
    expect(sendInit?.credentials).toBe('omit');
    expect(JSON.parse(sendInit?.body as string)).toEqual({ collaboratorId: 12 });
  });

  it('keeps the token until 30 seconds before it ends, and shares one request', async () => {
    let now = Date.parse('2026-11-18T12:00:00Z');
    const fake = fakeFetch();
    const track = createTracker({ fetch: fake.fetchMock, tokenUrl: '/custom/token', now: () => now });

    await Promise.all([track('signup'), track('signup')]);
    now += 569_000;
    await track('signup');
    expect(fake.urls().filter((url) => url === '/custom/token')).toHaveLength(1);

    now += 2_000;
    await track('signup');
    expect(fake.urls().filter((url) => url === '/custom/token')).toHaveLength(2);
  });

  it('after a 401 gets a new token and sends once more', async () => {
    const fake = fakeFetch({ send: (count) => (count === 1 ? jsonResponse(401, {}) : jsonResponse(200, { status: 'recorded' })) });
    const track = createTracker({ fetch: fake.fetchMock });

    expect(await track('signup')).toEqual({ status: 'recorded' });
    expect(fake.urls()).toEqual([DEFAULT_TOKEN_URL, `${SEND_URL}?access_token=jwt-1`, DEFAULT_TOKEN_URL, `${SEND_URL}?access_token=jwt-2`]);
  });

  it('resolves null when the server gives no token or Siren refuses the send, and rejects on a network failure', async () => {
    expect(await createTracker({ fetch: fakeFetch({ token: () => jsonResponse(400, { error: 'no' }) }).fetchMock })('signup')).toBeNull();
    expect(await createTracker({ fetch: fakeFetch({ send: () => jsonResponse(403, {}) }).fetchMock })('signup')).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(createTracker({ fetch: down })('signup')).rejects.toThrow('Failed to fetch');
  });
});
