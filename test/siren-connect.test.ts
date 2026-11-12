import { describe, expect, it } from 'vitest';
import { CallbackAccessTokenSource, Siren, SirenError } from '../src/index';
import { ConnectResource, SirenConnect } from '../src/connect/index';
import type { HttpRequest } from '../src/http';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, ConnectAnswers } from './connect-fakes';

/*
 * Slice 5 acceptance tests for packet P5: SirenConnect, the client a
 * connected site holds once it has an OAuth grant.
 *
 * SirenConnect resolves its options through the same code as `new Siren()`,
 * so the parity table below sends each option set to both and expects the
 * same outcome. The table compares the two clients rather than pinning
 * either one.
 *
 * Integration shape (KB 568): the real clients over a FakeHttpClient.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`. The packet that removes the last
 * `.skip` in this file deletes this paragraph too. Nothing else here changes.
 */

const KEY = 'sk_live_APIKEYSECRET_123';


function header(request: HttpRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** `ok`, or the error's class, plus its message when `withMessage` is set. */
function outcome(build: () => unknown, withMessage: boolean): string {
  try {
    build();
    return 'ok';
  } catch (error) {
    if (!(error instanceof SirenError)) return `other: ${String(error)}`;
    return withMessage ? `${error.name}: ${error.message}` : error.name;
  }
}

function caught(build: () => unknown): Error {
  try {
    build();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the constructor to throw');
}

describe('P5: SirenConnect sends with the site token', () => {
  it.skip('sends connect routes to the default base URL with the access token, the default timeout and the SDK headers', async () => {
    const http = new FakeHttpClient([reply(200, ConnectAnswers.ping)]);
    const siren = new SirenConnect({ accessToken: 'tok-site', httpClient: http });

    await expect(siren.connect.ping()).resolves.toEqual(ConnectAnswers.ping);

    expect(siren.connect).toBeInstanceOf(ConnectResource);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe(`${BASE}/ping`);
    expect(header(http.requests[0]!, 'authorization')).toBe('Bearer tok-site');
    expect(header(http.requests[0]!, 'user-agent')).toMatch(/^siren-sdk-typescript\//);
    expect(http.requests[0]!.timeout).toBe(30_000);
  });

  it.skip('honours baseUrl, timeout and maxRetries', async () => {
    const http = new FakeHttpClient([
      reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }),
      reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }),
      reply(200, ConnectAnswers.ping),
    ]);
    const siren = new SirenConnect({ accessToken: 'tok-site', httpClient: http, baseUrl: 'http://localhost:8080/siren/v1/', timeout: 5000, maxRetries: 1 });

    await expect(siren.connect.ping()).rejects.toBeInstanceOf(SirenError);

    expect(http.requests.map((request) => request.url)).toEqual(['http://localhost:8080/siren/v1/ping', 'http://localhost:8080/siren/v1/ping']);
    expect(http.requests[0]!.timeout).toBe(5000);
  });

  it.skip('refreshes an AccessTokenSource once after a 401 and resends', async () => {
    const http = new FakeHttpClient([reply(401, ConnectAnswers.invalidToken), reply(200, ConnectAnswers.plan)]);
    const refused: string[] = [];
    const source = new CallbackAccessTokenSource(
      () => 'tok-old',
      (rejected) => {
        refused.push(rejected);
        return 'tok-new';
      },
    );
    const siren = new SirenConnect({ accessToken: source, httpClient: http });

    await expect(siren.connect.plan()).resolves.toEqual(ConnectAnswers.plan);

    expect(http.bearers()).toEqual(['Bearer tok-old', 'Bearer tok-new']);
    expect(refused).toEqual(['tok-old']);
  });

  it.skip('forwards events with the same token, through events.forward', async () => {
    const http = new FakeHttpClient([reply(200, { status: 'accepted', event: 'product-deleted', message: 'Event accepted.' })]);
    const siren = new SirenConnect({ accessToken: 'tok-site', httpClient: http });

    await siren.events.forward('product-deleted', {
      version: 1,
      eventId: '5f0c2b1e-9d8a-4c3f-8e7d-6c5b4a392817',
      origin: 'site',
      occurredAt: null,
      data: { integration: 'medusa', platformId: 'prod_01' },
    });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe(`${BASE}/event/product-deleted`);
    expect(header(http.requests[0]!, 'authorization')).toBe('Bearer tok-site');
  });
});

describe('P5: SirenConnect options', () => {
  const source = new CallbackAccessTokenSource(
    () => 'tok',
    () => null,
  );
  const http = new FakeHttpClient([reply(200, {})]);

  /**
   * Each row holds an accessToken, so `new Siren()` sees the same credential.
   * The last two rows compare the outcome but not the message: there an
   * option reaches the constructor only through a prototype, and SirenConnect
   * words its own refusal of a missing accessToken or of an apiKey.
   */
  const PARITY: Array<[string, Record<string, unknown>]> = [
    ['a string token', { accessToken: 'tok', httpClient: http }],
    ['a token source', { accessToken: source, httpClient: http }],
    ['an empty token', { accessToken: '' }],
    ['a token that is a number', { accessToken: 42 }],
    ['an object with one token method', { accessToken: { getAccessToken: () => 'tok' } }],
    ['a null token', { accessToken: null }],
    ['an httpClient of null', { accessToken: 'tok', httpClient: null }],
    ['an httpClient without send', { accessToken: 'tok', httpClient: {} }],
    ['an httpClient whose send is not a function', { accessToken: 'tok', httpClient: { send: 'x' } }],
    ['an apiKey given as undefined', { apiKey: undefined, accessToken: 'tok', httpClient: http }],
    ['a baseUrl with a trailing slash', { accessToken: 'tok', baseUrl: 'http://localhost:8080/siren/v1/', httpClient: http }],
    ['a token inherited from the prototype', Object.create({ accessToken: 'tok' }, { httpClient: { value: http, enumerable: true } })],
    ['a polluted Object.prototype', { accessToken: 'tok', httpClient: http, polluted: true }],
  ];

  it.skip.each(PARITY)('resolves %s exactly as new Siren() does', (_name, options) => {
    const polluted = options.polluted === true;
    if (polluted) (Object.prototype as Record<string, unknown>).apiKey = KEY;
    try {
      const { polluted: _flag, ...given } = options;
      const asGiven = Object.getPrototypeOf(options) === Object.prototype ? given : options;
      const withMessage = asGiven === given && !polluted;
      expect(outcome(() => new SirenConnect(asGiven as never), withMessage)).toBe(outcome(() => new Siren(asGiven as never), withMessage));
    } finally {
      if (polluted) delete (Object.prototype as Record<string, unknown>).apiKey;
    }
  });

  it.skip('sends the same request new Siren() sends for the same options', async () => {
    const options = { accessToken: 'tok', baseUrl: 'http://localhost:8080/siren/v1/', timeout: 1234, maxRetries: 0 };
    const viaConnect = new FakeHttpClient([reply(200, {})]);
    const viaSiren = new FakeHttpClient([reply(200, {})]);

    await new SirenConnect({ ...options, httpClient: viaConnect }).events.ingest('custom-thing', { a: 1 });
    await new Siren({ ...options, httpClient: viaSiren }).events.ingest('custom-thing', { a: 1 });

    expect(viaConnect.requests).toEqual(viaSiren.requests);
  });

  it.skip.each([
    ['an apiKey alone', { apiKey: KEY }],
    ['an apiKey beside an accessToken', { apiKey: KEY, accessToken: 'tok' }],
    ['an empty apiKey beside an accessToken', { apiKey: '', accessToken: 'tok' }],
  ])('refuses %s with its own SirenError naming apiKey and accessToken, quoting no key', (_name, options) => {
    const error = caught(() => new SirenConnect(options as never));

    expect(error).toBeInstanceOf(SirenError);
    expect(error.message).toMatch(/^SirenConnect: /);
    expect(error.message).toContain('apiKey');
    expect(error.message).toContain('accessToken');
    expect(error.message).not.toContain('APIKEYSECRET');
  });

  it.skip.each([
    ['no options', undefined],
    ['empty options', {}],
    ['an accessToken given as undefined', { accessToken: undefined }],
  ])('refuses %s with SirenError that says an accessToken is required', (_name, options) => {
    const error = caught(() => new SirenConnect(options as never));

    expect(error).toBeInstanceOf(SirenError);
    expect(error.message).toMatch(/^SirenConnect: /);
    expect(error.message).toMatch(/accessToken is required/);
    expect(error.message).not.toMatch(/apiKey is required/);
  });
});
