import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  CallbackAccessTokenSource,
  FetchHttpClient,
  Siren,
  SirenError,
  SiteDisconnectedError,
  type SirenOptions,
} from '../src/index';
import { CloudAnswers, FakeHttpClient, reply, spySource } from './http-fakes';

/*
 * Slice 2 acceptance tests for packet P5: the Siren constructor's options.
 *
 * Integration shape (KB 568): the real Siren client, transport and resources,
 * with the network mocked only at the HttpClient seam. The last two describe
 * blocks prove the slice's done condition: once at the seam, and once through
 * the real FetchHttpClient against a real HTTP server on 127.0.0.1.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`, leaves none of them skipped, and
 * changes nothing else here.
 */


/** The real fetch, kept before failOnGlobalFetch replaces the global one. */
const realFetch = globalThis.fetch;

/**
 * Fails any test whose request reaches the global fetch, so a transport that
 * ignores its client fails on that, not on a real network call.
 */
function failOnGlobalFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('the request went to the global fetch, not the HttpClient');
    }),
  );
}

beforeEach(failOnGlobalFetch);

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = `sk_live_${'b'.repeat(64)}`;

describe('P5: Siren credentials', () => {
  it('sends an apiKey as a fixed bearer token and surfaces a 401 without refreshing', async () => {
    const httpClient = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired)]);
    const siren = new Siren({ apiKey: KEY, httpClient, maxRetries: 2 });

    await expect(siren.conversions.list()).rejects.toBeInstanceOf(AuthenticationError);
    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`]);
  });

  it('sends a string accessToken as a fixed bearer token and surfaces a 401 without refreshing', async () => {
    const httpClient = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired)]);
    const siren = new Siren({ accessToken: 'oauth-access-1', httpClient });

    await expect(siren.conversions.list()).rejects.toBeInstanceOf(AuthenticationError);
    expect(httpClient.bearers()).toEqual(['Bearer oauth-access-1']);
  });

  it('uses an AccessTokenSource as given', async () => {
    const tokens = spySource(['from-source']);
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const siren = new Siren({ accessToken: tokens, httpClient });

    await siren.payouts.list();

    expect(tokens.getAccessToken).toHaveBeenCalledTimes(1);
    expect(httpClient.bearers()).toEqual(['Bearer from-source']);
  });

  it('refuses both apiKey and accessToken', () => {
    const both = { apiKey: KEY, accessToken: 'oauth-access-1' } as unknown as SirenOptions;

    expect(() => new Siren(both)).toThrow(SirenError);
    expect(() => new Siren(both)).toThrow(/either apiKey or accessToken/i);
  });

  it('refuses neither, naming both choices', () => {
    const neither = {} as unknown as SirenOptions;

    expect(() => new Siren(neither)).toThrow(SirenError);
    expect(() => new Siren(neither)).toThrow(/apiKey is required/);
    expect(() => new Siren(neither)).toThrow(/accessToken/);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['an object with no methods', {}],
    ['an object with only getAccessToken', { getAccessToken: () => 'x' }],
  ])('refuses an accessToken that is %s', (_name, accessToken) => {
    expect(() => new Siren({ accessToken } as unknown as SirenOptions)).toThrow(SirenError);
  });

  it.each([
    ['an empty apiKey beside an accessToken', { apiKey: '', accessToken: 'oauth-access-1' }],
    ['an apiKey beside an empty accessToken', { apiKey: KEY, accessToken: '' }],
  ])('refuses %s as both', (_name, options) => {
    expect(() => new Siren(options as unknown as SirenOptions)).toThrow(/either apiKey or accessToken/i);
  });

  it('reads an option given as undefined as absent', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const withKey = new Siren({ apiKey: KEY, accessToken: undefined, httpClient } as unknown as SirenOptions);
    const withToken = new Siren({ apiKey: undefined, accessToken: 'oauth-access-1', httpClient } as unknown as SirenOptions);

    await withKey.payouts.list();
    await withToken.payouts.list();

    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`, 'Bearer oauth-access-1']);
    expect(() => new Siren({ apiKey: KEY, httpClient: undefined })).not.toThrow();
  });

  it('keeps the credentials out of the error it raises', () => {
    const secret = `sk_live_${'s'.repeat(64)}`;
    const errors = [
      { apiKey: secret, accessToken: 'oauth-secret-1' },
      { accessToken: { getAccessToken: () => 'oauth-secret-1' } },
    ].map((options) => {
      try {
        new Siren(options as unknown as SirenOptions);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('expected the constructor to throw');
    });

    for (const error of errors) {
      const seen = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
      expect(seen).not.toContain(secret);
      expect(seen).not.toContain('oauth-secret-1');
    }
  });

  it('still refuses an empty apiKey', () => {
    expect(() => new Siren({ apiKey: '' })).toThrow(/apiKey is required/);
  });
});

describe('P5: Siren httpClient', () => {
  it('sends every request through the given client and never through the global fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const siren = new Siren({ apiKey: KEY, httpClient, timeout: 2500, baseUrl: 'https://cloud.test/siren/v1/' });

    await siren.obligations.list();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpClient.requests).toHaveLength(1);
    expect(httpClient.requests[0]!.url).toBe('https://cloud.test/siren/v1/obligations');
    expect(httpClient.requests[0]!.timeout).toBe(2500);
  });

  it('passes maxRetries 0 through, so a retriable read gets one send on a 503', async () => {
    const httpClient = new FakeHttpClient([reply(503, undefined), reply(200, [])]);
    const siren = new Siren({ apiKey: KEY, httpClient, maxRetries: 0 });

    await expect(siren.conversions.list()).rejects.toBeInstanceOf(SirenError);
    expect(httpClient.requests).toHaveLength(1);
  });

  it.each([
    ['an object with no send', {}],
    ['a function', () => undefined],
    ['a string', 'fetch'],
    ['null', null],
  ])('refuses an httpClient that is %s', (_name, httpClient) => {
    expect(() => new Siren({ apiKey: KEY, httpClient } as unknown as SirenOptions)).toThrow(SirenError);
  });

  it('defaults to the global fetch when no client is given', async () => {
    const siren = new Siren({ accessToken: 'oauth-access-1' });
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await siren.transactions.list();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oauth-access-1');
    expect(init.redirect).toBe('manual');
  });
});

describe('P5: done condition at the HttpClient seam', () => {
  it('refreshes once and resends a send-once write, then answers', async () => {
    const refresh = vi.fn(async (_rejected: string) => 'oauth-access-2');
    const httpClient = new FakeHttpClient([
      reply(401, CloudAnswers.eventTokenRefused),
      reply(200, { status: 'recorded' }),
    ]);
    const siren = new Siren({
      accessToken: new CallbackAccessTokenSource(() => 'oauth-access-1', refresh),
      httpClient,
      maxRetries: 2,
    });

    const result = await siren.events.ingest('newsletter-signup', { email: 'a@b.test' });

    expect(result.status).toBe('recorded');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('oauth-access-1');
    expect(httpClient.bearers()).toEqual(['Bearer oauth-access-1', 'Bearer oauth-access-2']);
    expect(httpClient.requests[1]!.body).toBe(httpClient.requests[0]!.body);
  });

  it('surfaces SiteDisconnectedError when the resend gets a second 401, after one refresh and two sends', async () => {
    const refresh = vi.fn(async (_rejected: string) => 'oauth-access-2');
    const httpClient = new FakeHttpClient([
      reply(401, CloudAnswers.eventTokenRefused),
      reply(401, CloudAnswers.siteDisconnected),
    ]);
    const siren = new Siren({
      accessToken: new CallbackAccessTokenSource(() => 'oauth-access-1', refresh),
      httpClient,
      maxRetries: 2,
    });

    await expect(siren.events.siteVisited({ collaboratorId: 'tracking:abc' })).rejects.toBeInstanceOf(
      SiteDisconnectedError,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(httpClient.bearers()).toEqual(['Bearer oauth-access-1', 'Bearer oauth-access-2']);
  });
});

describe('P5: done condition over a real socket', () => {
  interface Received {
    authorization: string | undefined;
    body: string;
  }

  let server: Server;
  let base: string;
  let received: Received[] = [];

  beforeEach(() => {
    received = [];
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
        const first = received.length === 1;
        res.writeHead(first ? 401 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(first ? CloudAnswers.eventTokenRefused : { status: 'recorded' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/siren/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refreshes once and resends a send-once write with the same body through FetchHttpClient', async () => {
    const refresh = vi.fn(async (_rejected: string) => 'oauth-access-2');
    const siren = new Siren({
      accessToken: new CallbackAccessTokenSource(() => 'oauth-access-1', refresh),
      httpClient: new FetchHttpClient(realFetch),
      baseUrl: base,
      maxRetries: 2,
    });

    const result = await siren.events.ingest('newsletter-signup', { email: 'a@b.test' });

    expect(result.status).toBe('recorded');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(received.map((r) => r.authorization)).toEqual(['Bearer oauth-access-1', 'Bearer oauth-access-2']);
    expect(received[0]!.body).not.toBe('');
    expect(received[1]!.body).toBe(received[0]!.body);
  });
});
