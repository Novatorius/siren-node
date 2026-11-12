import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ConnectionError, HttpClientError, RecordsResource, SirenError } from '../src/index';
import { HttpTransport } from '../src/http';
import { CloudAnswers, FakeHttpClient, reply, spySource } from './http-fakes';

/*
 * Unit tests for the HttpTransport internals the P4 acceptance tests do not
 * pin: the token check on control characters past the ones the contract
 * lists, the token scrub on tokens that hold regex characters or each other,
 * and the reply wrapper's status text and header lookup.
 */

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('the request went to the global fetch, not the HttpClient');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function records(client: FakeHttpClient, tokens = spySource()): RecordsResource {
  const http = new HttpTransport({
    tokens,
    client,
    baseUrl: 'https://cloud.test/siren/v1',
    timeout: 1000,
    maxRetries: 0,
  });
  return new RecordsResource(http, '/conversions');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('HttpTransport token check', () => {
  it.each([
    ['a unit separator (U+001F)', 'tok\u001fX'],
    ['a DEL (U+007F)', 'tok\u007fX'],
    ['a tab', 'tok\tX'],
  ])('refuses a token from getAccessToken that holds %s', async (_name, token) => {
    const tokens = spySource();
    tokens.getAccessToken.mockResolvedValueOnce(token);
    const client = new FakeHttpClient([reply(200, [])]);

    const error = await rejection(records(client, tokens).list());

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toMatch(/getAccessToken/);
    expect(client.requests).toHaveLength(0);
  });

  it.each([
    ['a unit separator (U+001F)', 'tok-2\u001fX'],
    ['a DEL (U+007F)', 'tok-2\u007fX'],
  ])('reads a refresh answer that holds %s as no token', async (_name, refreshed) => {
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    const error = await rejection(records(client, spySource(['tok-1'], refreshed)).list());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(client.requests).toHaveLength(1);
  });

  it('sends a token that holds printable characters only, spaces and symbols included', async () => {
    const client = new FakeHttpClient([reply(200, [])]);

    await records(client, spySource(['tok ~!@#$%^&*()_+'])).list();

    expect(client.bearers()).toEqual(['Bearer tok ~!@#$%^&*()_+']);
  });
});

describe('HttpTransport token scrub', () => {
  it('removes a token that holds regex characters from the ConnectionError message', async () => {
    const token = 'sk_(a+b)*[c].$';
    const client = new FakeHttpClient([new HttpClientError(`failed with Bearer ${token} sent`)]);

    const error = await rejection(records(client, spySource([token])).list());

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).message).not.toContain(token);
    expect((error as ConnectionError).message).toContain('failed with Bearer');
    expect((error as ConnectionError).message).toContain('sent');
  });

  it('removes a fresh token whole when it starts with the refused one', async () => {
    const client = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
      new HttpClientError('tried sk_one then sk_one_tail'),
    ]);

    const error = await rejection(records(client, spySource(['sk_one'], 'sk_one_tail')).list());

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).message).not.toContain('sk_one');
    expect((error as ConnectionError).message).not.toContain('_tail');
  });

  it('removes every occurrence of a token, not only the first', async () => {
    const client = new FakeHttpClient([new HttpClientError('sk_twice and again sk_twice')]);

    const error = await rejection(records(client, spySource(['sk_twice'])).list());

    expect((error as ConnectionError).message).not.toContain('sk_twice');
    expect((error as ConnectionError).message).toContain('and again');
  });
});

describe('HttpTransport reply wrapper', () => {
  it('falls back to the status when the reply has no status text and no error body', async () => {
    const client = new FakeHttpClient([reply(418)]);

    const error = await rejection(records(client).list());

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe('Request failed with status 418');
    expect((error as SirenError).statusCode).toBe(418);
  });

  it('looks a header up in any case, whatever case the client wrote it in', async () => {
    const client = new FakeHttpClient([reply(200, { ok: true }, { 'x-siren-oid': '77', 'RETRY-AFTER': '3' })]);
    const http = new HttpTransport({
      tokens: spySource(),
      client,
      baseUrl: 'https://cloud.test/siren/v1',
      timeout: 1000,
      maxRetries: 0,
    });

    const response = await http.request({ method: 'GET', path: '/ping', retriable: true });

    expect(response.headers.get('X-Siren-OID')).toBe('77');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('x-absent')).toBeNull();
    expect(await response.text()).toBe('{"ok":true}');
  });
});
