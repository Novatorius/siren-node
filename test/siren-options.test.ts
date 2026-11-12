import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  CallbackAccessTokenSource,
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
 * with the network mocked only at the HttpClient seam. The last describe
 * block proves the slice's done condition through the whole public stack.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else here.
 */


/**
 * Fails any test whose request reaches the global fetch, so a transport that
 * ignores its client fails on that, not on a real network call.
 */
function tripwireFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('tripwire: the request went to the global fetch, not the HttpClient');
    }),
  );
}

beforeEach(tripwireFetch);

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = `sk_live_${'b'.repeat(64)}`;

describe('P5: Siren credentials', () => {
  it.skip('sends an apiKey as a fixed bearer token and surfaces a 401 without refreshing', async () => {
    const httpClient = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired)]);
    const siren = new Siren({ apiKey: KEY, httpClient, maxRetries: 2 });

    await expect(siren.conversions.list()).rejects.toBeInstanceOf(AuthenticationError);
    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`]);
  });

  it.skip('sends a string accessToken as a fixed bearer token and surfaces a 401 without refreshing', async () => {
    const httpClient = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired)]);
    const siren = new Siren({ accessToken: 'oauth-access-1', httpClient });

    await expect(siren.conversions.list()).rejects.toBeInstanceOf(AuthenticationError);
    expect(httpClient.bearers()).toEqual(['Bearer oauth-access-1']);
  });

  it.skip('uses an AccessTokenSource as given', async () => {
    const tokens = spySource(['from-source']);
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const siren = new Siren({ accessToken: tokens, httpClient });

    await siren.payouts.list();

    expect(tokens.getAccessToken).toHaveBeenCalledTimes(1);
    expect(httpClient.bearers()).toEqual(['Bearer from-source']);
  });

  it.skip('refuses both apiKey and accessToken', () => {
    const both = { apiKey: KEY, accessToken: 'oauth-access-1' } as unknown as SirenOptions;

    expect(() => new Siren(both)).toThrow(SirenError);
    expect(() => new Siren(both)).toThrow(/either apiKey or accessToken/i);
  });

  it.skip('refuses neither, naming both choices', () => {
    const neither = {} as unknown as SirenOptions;

    expect(() => new Siren(neither)).toThrow(SirenError);
    expect(() => new Siren(neither)).toThrow(/apiKey is required/);
    expect(() => new Siren(neither)).toThrow(/accessToken/);
  });

  it.skip.each([
    ['an empty string', ''],
    ['a number', 42],
    ['an object with no methods', {}],
    ['an object with only getAccessToken', { getAccessToken: () => 'x' }],
  ])('refuses an accessToken that is %s', (_name, accessToken) => {
    expect(() => new Siren({ accessToken } as unknown as SirenOptions)).toThrow(SirenError);
  });

  it.skip('still refuses an empty apiKey', () => {
    expect(() => new Siren({ apiKey: '' })).toThrow(/apiKey is required/);
  });
});

describe('P5: Siren httpClient', () => {
  it.skip('sends every request through the given client and never through the global fetch', async () => {
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

  it.skip.each([
    ['an object with no send', {}],
    ['a function', () => undefined],
    ['a string', 'fetch'],
  ])('refuses an httpClient that is %s', (_name, httpClient) => {
    expect(() => new Siren({ apiKey: KEY, httpClient } as unknown as SirenOptions)).toThrow(SirenError);
  });

  it.skip('defaults to the global fetch when no client is given', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await new Siren({ accessToken: 'oauth-access-1' }).transactions.list();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oauth-access-1');
  });
});

describe('P5: done condition through the whole stack', () => {
  it.skip('refreshes once and resends a send-once write, then answers', async () => {
    const refresh = vi.fn(async (_rejected: string) => 'oauth-access-2');
    const httpClient = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
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

  it.skip('surfaces SiteDisconnectedError when the resend gets a second 401, after one refresh and two sends', async () => {
    const refresh = vi.fn(async (_rejected: string) => 'oauth-access-2');
    const httpClient = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
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
