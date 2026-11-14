import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CallbackAccessTokenSource, ConnectionError, HttpClientError, RateLimitError, Siren, SirenError } from '../src/index';
import type { HttpRequest } from '../src/http';
import { shown } from './error-text';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';

/*
 * events.ingest takes an optional third argument, `{ headers, timeout }`,
 * so a connected site can send a referral visit with the tracking value the
 * shopper already holds and a short wait of its own.
 *
 * Siren reads that value from the visit's request headers: a signed token in
 * `X-Siren-Token`, or a bare opportunity id in `X-Siren-Oid`
 * (lib/Events/Service/Rest/IngestEvent.php, requestOpportunityId). A
 * WordPress site sends both on `POST /event/site-visited` with a two second
 * timeout (lib/Connect/Service/Services/VisitCaptureService.php).
 *
 * Every client here gets a FakeHttpClient and the reserved base URL
 * https://example.invalid, and the global fetch fails the test when called,
 * so nothing leaves the machine.
 */

const BASE = 'https://example.invalid/siren/v1';

beforeEach(failOnGlobalFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function siren(replies: ConstructorParameters<typeof FakeHttpClient>[0], options: { maxRetries?: number; timeout?: number } = {}) {
  const http = new FakeHttpClient(replies);
  return { http, client: new Siren({ apiKey: TEST_API_KEY, httpClient: http, baseUrl: BASE, ...options }) };
}

function header(request: HttpRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

const visit = { collaboratorId: 'tracking:summer-sale' };

describe('events.ingest headers', () => {
  it('sends the caller headers on the one send, beside the SDK headers, with the payload as given', async () => {
    const { http, client } = siren([reply(200, { status: 'attributed' }, { 'X-Siren-OID': '318' })]);

    const result = await client.events.ingest('site-visited', visit, { headers: { 'X-Siren-Token': '318.4f2a9c' } });

    expect(http.requests).toHaveLength(1);
    const request = http.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${BASE}/event/site-visited`);
    expect(JSON.parse(request.body!)).toEqual(visit);
    expect(header(request, 'x-siren-token')).toBe('318.4f2a9c');
    expect(header(request, 'authorization')).toBe(`Bearer ${TEST_API_KEY}`);
    expect(header(request, 'accept')).toBe('application/json');
    expect(header(request, 'content-type')).toBe('application/json');
    expect(header(request, 'user-agent')).toMatch(/^siren-sdk-typescript\//);
    expect(result).toEqual({ opportunityId: 318, status: 'attributed', body: { status: 'attributed' } });
  });

  it('sends X-Siren-Oid as given', async () => {
    const { http, client } = siren([reply(200, {})]);

    await client.events.ingest('site-visited', visit, { headers: { 'X-Siren-Oid': '4021' } });

    expect(header(http.requests[0]!, 'x-siren-oid')).toBe('4021');
  });

  it('never lets a caller header replace one the SDK sets, in any case', async () => {
    const { http, client } = siren([reply(200, {})]);

    await client.events.ingest('site-visited', visit, {
      headers: { authorization: 'Bearer stolen', ACCEPT: 'text/html', 'User-Agent': 'other', 'content-TYPE': 'text/plain' },
    });

    const request = http.requests[0]!;
    expect(header(request, 'authorization')).toBe(`Bearer ${TEST_API_KEY}`);
    expect(header(request, 'accept')).toBe('application/json');
    expect(header(request, 'user-agent')).toMatch(/^siren-sdk-typescript\//);
    expect(header(request, 'content-type')).toBe('application/json');
    expect(Object.keys(request.headers)).toHaveLength(4);
  });

  it("sends no extra header without options, and keeps one call's headers off the next call", async () => {
    const { http, client } = siren([reply(200, {})]);

    await client.events.ingest('site-visited', visit, { headers: { 'X-Siren-Token': '318.4f2a9c' } });
    await client.events.ingest('site-visited', visit);
    await client.events.ingest('site-visited', visit, {});

    expect(http.requests.map((request) => header(request, 'x-siren-token'))).toEqual(['318.4f2a9c', undefined, undefined]);
    expect(http.requests.slice(1).map((request) => Object.keys(request.headers).length)).toEqual([4, 4]);
  });

  it("reads only the options object's own headers and timeout", async () => {
    const { http, client } = siren([reply(200, {})], { timeout: 5000 });
    const inherited = Object.create({ headers: { 'X-Siren-Token': '318.4f2a9c' }, timeout: 2000 }) as object;

    await client.events.ingest('site-visited', visit, inherited);

    expect(header(http.requests[0]!, 'x-siren-token')).toBeUndefined();
    expect(http.requests[0]!.timeout).toBe(5000);
  });
});

describe('events.ingest timeout', () => {
  it('gives each send of the call the caller timeout in place of the client one', async () => {
    const { http, client } = siren([reply(200, {})], { timeout: 30000 });

    await client.events.ingest('site-visited', visit, { timeout: 2000 });
    await client.events.ingest('site-visited', visit);

    expect(http.requests.map((request) => request.timeout)).toEqual([2000, 30000]);
  });

  it('keeps the headers and the timeout on the resend after a 401, and only then', async () => {
    const http = new FakeHttpClient([reply(401, { error: { message: 'Invalid access token.', context: [] } }), reply(200, {})]);
    const refreshed = vi.fn(async () => 'tok-2');
    const client = new Siren({
      accessToken: new CallbackAccessTokenSource(() => 'tok-1', refreshed),
      httpClient: http,
      baseUrl: BASE,
      maxRetries: 3,
    });

    await client.events.ingest('site-visited', visit, { headers: { 'X-Siren-Oid': '4021' }, timeout: 2000 });

    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(http.requests.map((request) => header(request, 'authorization'))).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(http.requests.map((request) => header(request, 'x-siren-oid'))).toEqual(['4021', '4021']);
    expect(http.requests.map((request) => request.timeout)).toEqual([2000, 2000]);
  });
});

describe('events.ingest with options is sent once', () => {
  it.each([
    ['a 503', reply(503, { error: { message: 'Unavailable.', context: [] } }, { 'Retry-After': '0' }), ApiError],
    ['a 429', reply(429, { error: { message: 'Slow down.', context: [] } }, { 'Retry-After': '0' }), RateLimitError],
    ['a network error', new HttpClientError('socket hang up'), ConnectionError],
  ])('sends once on %s, with the client allowing retries', async (_name, first, type) => {
    const { http, client } = siren([first, reply(200, {})], { maxRetries: 3 });

    await expect(
      client.events.ingest('site-visited', visit, { headers: { 'X-Siren-Token': '318.4f2a9c' }, timeout: 2000 }),
    ).rejects.toBeInstanceOf(type);
    expect(http.requests).toHaveLength(1);
  });
});

describe('events.ingest refuses options it cannot send', () => {
  const secret = 'shopper-secret-value';

  it.each([
    ['options that are not an object', 'x-siren'],
    ['options that are an array', []],
    ['options that are null', null],
  ])('refuses %s and sends nothing', async (_name, options) => {
    const { http, client } = siren([reply(200, {})]);

    await expect(client.events.ingest('site-visited', visit, options as never)).rejects.toThrow(
      new SirenError('Siren: events.ingest takes its options as an object.'),
    );
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['headers that are not an object', secret],
    ['headers that are an array', [secret]],
    ['headers that are null', null],
  ])('refuses %s and sends nothing', async (_name, headers) => {
    const { http, client } = siren([reply(200, {})]);

    await expect(client.events.ingest('site-visited', visit, { headers } as never)).rejects.toThrow(
      new SirenError('Siren: events.ingest takes headers as an object of header names to text values.'),
    );
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['a value that is not text', { 'X-Siren-Oid': 4021 }],
    ['a value with a line feed', { 'X-Siren-Token': `${secret}\nX-Evil: 1` }],
    ['a value with a carriage return', { 'X-Siren-Token': `${secret}\r` }],
    ['a value with a NUL', { 'X-Siren-Token': `${secret}\u0000` }],
    ['a value with DEL', { 'X-Siren-Token': `${secret}\u007f` }],
    ['a value with a C1 next line', { 'X-Siren-Token': `${secret}\u0085` }],
    ['a value above U+00FF', { 'X-Siren-Token': `${secret}Ċ` }],
    ['a name with a space', { 'X Siren Token': secret }],
    ['a name with a colon', { 'X-Siren-Token:': secret }],
    ['an empty name', { '': secret }],
  ])('refuses %s, never quoting it, and sends nothing', async (_name, headers) => {
    const { http, client } = siren([reply(200, {})]);

    let caught: unknown;
    try {
      await client.events.ingest('site-visited', visit, { headers: headers as never });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SirenError);
    expect((caught as SirenError).message).toBe(
      'Siren: events.ingest takes each header name as an HTTP token and each value as text with no control character and no character above U+00FF.',
    );
    expect(shown(caught)).not.toContain(secret);
    expect(http.requests).toHaveLength(0);
  });

  it('sends an empty header value as given', async () => {
    const { http, client } = siren([reply(200, {})]);

    await client.events.ingest('site-visited', visit, { headers: { 'X-Siren-Oid': '' } });

    expect(header(http.requests[0]!, 'x-siren-oid')).toBe('');
  });

  it.each([
    ['0', 0, '0'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['2147483648', 2147483648, '2147483648'],
    ['a string', '2000', 'string'],
    ['null', null, 'null'],
  ])('refuses a timeout of %s and sends nothing', async (_name, timeout, described) => {
    const { http, client } = siren([reply(200, {})]);

    await expect(client.events.ingest('site-visited', visit, { timeout } as never)).rejects.toThrow(
      new SirenError(`Siren: timeout must be a number of milliseconds from 1 to 2147483647. It got ${described}.`),
    );
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['1', 1],
    ['2147483647', 2147483647],
  ])('takes a timeout of %s', async (_name, timeout) => {
    const { http, client } = siren([reply(200, {})]);

    await client.events.ingest('site-visited', visit, { timeout });

    expect(http.requests[0]!.timeout).toBe(timeout);
  });
});
