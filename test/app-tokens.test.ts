import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, BadRequestError, Siren, SirenError } from '../src/index';
import { AppAccessTokens } from '../src/auth/app-access-tokens';
import { TEST_API_KEY, jsonResponse } from './helpers';

/*
 * Slice C13 (apps-event-tokens, Siren's docs/architecture/apps-event-tokens.md
 * section 4): the SDK trades the app's key for short-lived tokens, so a
 * caller of events.ingest never handles one. These pin the cache, the early
 * refresh, the shared request, the 401 retry, the fallback for a key of no
 * app, browserToken and browserTokenHandler.
 */

const BASE = 'https://api.sirenaffiliates.com/siren/v1';
const TOKEN_URL = `${BASE}/oauth/token`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/**
 * A fetch that answers the token route with `grant` and every send with
 * `send`, each called with the request, and records every call.
 */
function fakeSiren(options: {
  grant?: (body: Record<string, unknown>, count: number) => Response;
  send?: (call: Call, count: number) => Response;
}) {
  const calls: Call[] = [];
  let grants = 0;
  let sends = 0;
  let issued = 0;
  const grant =
    options.grant ??
    ((body: Record<string, unknown>) => {
      issued += 1;
      const browser = typeof body.scope === 'string';
      return jsonResponse(200, { access_token: `jwt-${issued}`, token_type: 'Bearer', expires_in: browser ? 600 : 1200, ...(browser ? { scope: body.scope } : {}) });
    });
  const send = options.send ?? (() => jsonResponse(200, { status: 'recorded' }));
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call = { url, headers: (init.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    if (url === TOKEN_URL) return grant(body ?? {}, ++grants);
    return send(call, ++sends);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    grants: () => calls.filter((call) => call.url === TOKEN_URL),
    sends: () => calls.filter((call) => call.url !== TOKEN_URL),
  };
}

describe('events.ingest for a custom event', () => {
  it('trades the key for a server token and sends the event with it', async () => {
    const siren = fakeSiren({});
    const client = new Siren({ apiKey: TEST_API_KEY });

    const result = await client.events.ingest('newsletter-signup', { collaborator: { trackingId: 4021 } });

    expect(result.status).toBe('recorded');
    const [grant] = siren.grants();
    expect(grant?.body).toEqual({ grant_type: 'client_credentials', client_secret: TEST_API_KEY });
    expect(grant?.headers.Authorization).toBeUndefined();
    const [send] = siren.sends();
    expect(send?.url).toBe(`${BASE}/event/newsletter-signup`);
    expect(send?.headers.Authorization).toBe('Bearer jwt-1');
  });

  it('keeps the token across sends and asks again only when fewer than two minutes are left', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z') });
    const siren = fakeSiren({});
    const client = new Siren({ apiKey: TEST_API_KEY });

    await client.events.ingest('signup', {});
    vi.setSystemTime(new Date('2026-11-18T12:17:59Z'));
    await client.events.ingest('signup', {});
    expect(siren.grants()).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-18T12:18:01Z'));
    await client.events.ingest('signup', {});
    expect(siren.grants()).toHaveLength(2);
    expect(siren.sends().map((call) => call.headers.Authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-1', 'Bearer jwt-2']);
  });

  it('shares one grant between sends that need a token at the same moment', async () => {
    const siren = fakeSiren({});
    const client = new Siren({ apiKey: TEST_API_KEY });

    await Promise.all([client.events.ingest('signup', {}), client.events.ingest('signup', {}), client.events.ingest('demo-booked', {})]);

    expect(siren.grants()).toHaveLength(1);
    expect(siren.sends()).toHaveLength(3);
  });

  it('after a 401 drops the token, gets a new one and sends once more', async () => {
    const siren = fakeSiren({
      send: (_call, count) => (count === 1 ? jsonResponse(401, { error: { message: 'This access token has expired.' } }) : jsonResponse(200, { status: 'recorded' })),
    });
    const client = new Siren({ apiKey: TEST_API_KEY });

    const result = await client.events.ingest('signup', {});

    expect(result.status).toBe('recorded');
    expect(siren.grants()).toHaveLength(2);
    expect(siren.sends().map((call) => call.headers.Authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
  });

  it('raises a second 401 as the usual authentication error, sending no third time', async () => {
    const siren = fakeSiren({ send: () => jsonResponse(401, { error: { message: "This access token's key was revoked." } }) });
    const client = new Siren({ apiKey: TEST_API_KEY });

    await expect(client.events.ingest('signup', {})).rejects.toBeInstanceOf(AuthenticationError);
    expect(siren.sends()).toHaveLength(2);
  });

  it('sends with the key as before when the key belongs to no app, and asks only once', async () => {
    const siren = fakeSiren({
      grant: () => jsonResponse(400, { error: 'unauthorized_client', error_description: "Only an app's key can get an access token." }),
    });
    const client = new Siren({ apiKey: TEST_API_KEY });

    await client.events.ingest('signup', {});
    await client.events.ingest('signup', {});

    expect(siren.grants()).toHaveLength(1);
    expect(siren.sends().map((call) => call.headers.Authorization)).toEqual([`Bearer ${TEST_API_KEY}`, `Bearer ${TEST_API_KEY}`]);
  });

  it('raises a refused key from the token route with OAuth error as the code and its description as the message', async () => {
    fakeSiren({ grant: () => jsonResponse(401, { error: 'invalid_client', error_description: "Siren doesn't know this key, or it was revoked." }) });
    const client = new Siren({ apiKey: TEST_API_KEY });

    const error = await client.events.ingest('signup', {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as SirenError).code).toBe('invalid_client');
    expect((error as SirenError).message).toBe("Siren doesn't know this key, or it was revoked.");
  });

  it('keeps sending sales, refunds and site visits with the key', async () => {
    const siren = fakeSiren({});
    const client = new Siren({ apiKey: TEST_API_KEY });

    await client.events.sale({ source: 'stripe', externalId: 'cs_1', total: 10, trackingId: 1 });
    await client.events.siteVisited({ trackingId: 1 } as never);
    await client.events.ingest('sale', { source: 'stripe', externalId: 'cs_2', total: 10 });

    expect(siren.grants()).toHaveLength(0);
    expect(siren.sends().every((call) => call.headers.Authorization === `Bearer ${TEST_API_KEY}`)).toBe(true);
  });

  it('never asks for an app token on a client built with accessToken', async () => {
    const siren = fakeSiren({});
    const client = new Siren({ accessToken: 'connected-site-token' });

    await client.events.ingest('signup', {});

    expect(siren.grants()).toHaveLength(0);
    expect(siren.sends()[0]?.headers.Authorization).toBe('Bearer connected-site-token');
  });
});

describe('events.browserToken', () => {
  it('answers a browser token for one event with the seconds it has left and the send address', async () => {
    const siren = fakeSiren({});
    const client = new Siren({ apiKey: TEST_API_KEY });

    const token = await client.events.browserToken('newsletter-signup');

    expect(token).toEqual({ token: 'jwt-1', expiresIn: 600, url: `${BASE}/event/newsletter-signup` });
    expect(siren.grants()[0]?.body).toEqual({ grant_type: 'client_credentials', client_secret: TEST_API_KEY, scope: 'browser:newsletter-signup' });
  });

  it('keeps one token per event until fewer than 60 seconds are left', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z') });
    const siren = fakeSiren({});
    const client = new Siren({ apiKey: TEST_API_KEY });

    await client.events.browserToken('signup');
    await client.events.browserToken('demo-booked');
    vi.setSystemTime(new Date('2026-11-18T12:08:59Z'));
    const kept = await client.events.browserToken('signup');
    expect(kept.token).toBe('jwt-1');
    expect(kept.expiresIn).toBe(61);
    expect(siren.grants()).toHaveLength(2);

    vi.setSystemTime(new Date('2026-11-18T12:09:01Z'));
    expect((await client.events.browserToken('signup')).token).toBe('jwt-3');
  });

  it('raises Siren refusing the event as BadRequestError invalid_scope', async () => {
    fakeSiren({ grant: () => jsonResponse(400, { error: 'invalid_scope', error_description: 'The event "signup" allows no domain, so no browser may send it.' }) });
    const client = new Siren({ apiKey: TEST_API_KEY });

    const error = await client.events.browserToken('signup').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as SirenError).code).toBe('invalid_scope');
  });

  it('refuses a client built with accessToken, and an event key that is not one, sending nothing', async () => {
    const siren = fakeSiren({});

    await expect(new Siren({ accessToken: 'site' }).events.browserToken('signup')).rejects.toThrow(/apiKey/);
    await expect(new Siren({ apiKey: TEST_API_KEY }).events.browserToken('../oauth')).rejects.toThrow(SirenError);
    expect(siren.calls).toHaveLength(0);
  });
});

describe('events.browserTokenHandler', () => {
  it('answers a Web Request with the browser token, as a Next.js app route calls it', async () => {
    fakeSiren({});
    const handler = new Siren({ apiKey: TEST_API_KEY }).events.browserTokenHandler();

    const response = await handler(new Request('https://shop.example.com/siren/token', { method: 'POST', body: JSON.stringify({ event: 'signup' }) }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: 'jwt-1', expiresIn: 600, url: `${BASE}/event/signup` });
  });

  it("writes to Node's response, reading an Express body or the query", async () => {
    fakeSiren({});
    const handler = new Siren({ apiKey: TEST_API_KEY }).events.browserTokenHandler();
    const res = () => {
      const out = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      return Object.assign(out, {
        setHeader: (name: string, value: string) => (out.headers[name] = value),
        end: (body: string) => (out.body = body),
      });
    };

    const fromBody = res();
    await handler({ url: '/siren/token', body: { event: 'signup' } }, fromBody);
    const fromQuery = res();
    await handler({ url: '/siren/token?event=signup', body: {} }, fromQuery);

    for (const answer of [fromBody, fromQuery]) {
      expect(answer.statusCode).toBe(200);
      expect(answer.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(answer.body)).toMatchObject({ token: 'jwt-1', url: `${BASE}/event/signup` });
    }
  });

  it('reads a raw Node body stream', async () => {
    fakeSiren({});
    const handler = new Siren({ apiKey: TEST_API_KEY }).events.browserTokenHandler();
    const req = {
      url: '/siren/token',
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode('{"event":');
        yield new TextEncoder().encode('"signup"}');
      },
    };
    const out = { statusCode: 0, body: '', setHeader: () => undefined, end: (body: string) => (out.body = body) };

    await handler(req, out);

    expect(out.statusCode).toBe(200);
  });

  it('answers 400 for a missing event, one outside the list, and one Siren refuses, and 502 when Siren is down', async () => {
    fakeSiren({
      grant: (body) =>
        body.scope === 'browser:archived'
          ? jsonResponse(400, { error: 'invalid_scope', error_description: 'This app has no active custom event "archived".' })
          : jsonResponse(503, { error: 'temporarily_unavailable' }),
    });
    const client = new Siren({ apiKey: TEST_API_KEY, maxRetries: 0 });
    const open = client.events.browserTokenHandler();
    const listed = client.events.browserTokenHandler({ events: ['signup'] });
    const ask = async (handler: typeof open, event?: string) => {
      const response = await handler(new Request('https://shop.example.com/siren/token', { method: 'POST', body: JSON.stringify(event === undefined ? {} : { event }) }));
      return { status: response.status, body: (await response.json()) as { error?: string } };
    };

    expect((await ask(open)).status).toBe(400);
    expect((await ask(listed, 'demo-booked')).status).toBe(400);
    const refused = await ask(open, 'archived');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('This app has no active custom event "archived".');
    expect((await ask(listed, 'signup')).status).toBe(502);
  });
});

describe('AppAccessTokens', () => {
  it('answers null to a refresh of the key itself, so a refused key surfaces', async () => {
    const tokens = new AppAccessTokens('sk_live_x', async () => ({ accessToken: 'jwt', expiresIn: 1200 }));

    expect(await tokens.refreshAccessToken('sk_live_x')).toBeNull();
  });
});
