import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Siren, SirenError, type SirenOptions } from '../src/index';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';

/*
 * Unit tests for the private option resolvers behind the Siren constructor
 * (2b P2) that the acceptance tests in test/siren-option-checks.test.ts do
 * not pin: where the method walk stops, option reads that are not
 * enumerable, options that are not an object, and the edges of the baseUrl
 * and number checks.
 */

beforeEach(failOnGlobalFetch);

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = `sk_live_${'c'.repeat(64)}`;

function build(options: unknown): () => Siren {
  return () => new Siren(options as SirenOptions);
}

describe('Siren method walk', () => {
  it('refuses an httpClient whose own send is not a function, though its prototype holds one', () => {
    const client = new FakeHttpClient([reply(200, [])]);
    Object.defineProperty(client, 'send', { value: 'not a function' });

    expect(build({ apiKey: KEY, httpClient: client })).toThrow(/httpClient/);
  });

  it('accepts an httpClient whose send sits on a prototype that has no prototype itself', async () => {
    const requests: unknown[] = [];
    const base = Object.assign(Object.create(null) as Record<string, unknown>, {
      send: async (request: unknown) => {
        requests.push(request);
        return reply(200, []);
      },
    });
    const httpClient = Object.create(base) as object;

    await new Siren({ apiKey: KEY, httpClient } as unknown as SirenOptions).payouts.list();

    expect(requests).toHaveLength(1);
  });

  it('refuses a function as httpClient, even one that carries a send', () => {
    const httpClient = Object.assign(() => undefined, { send: async () => reply(200, []) });

    expect(build({ apiKey: KEY, httpClient })).toThrow(/httpClient/);
  });

  it('refuses an accessToken whose own refreshAccessToken is not a function', () => {
    const accessToken = { getAccessToken: () => 'oauth-1', refreshAccessToken: null };

    expect(build({ accessToken })).toThrow(/accessToken/);
  });
});

describe('Siren own-option reads', () => {
  it('reads an option the object holds as a property that is not enumerable', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const options = { httpClient };
    Object.defineProperty(options, 'apiKey', { value: KEY, enumerable: false });

    await new Siren(options as unknown as SirenOptions).payouts.list();

    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`]);
  });

  it.each([
    ['a string', KEY],
    ['a number', 42],
  ])('refuses options that are %s with the apiKey message, not a TypeError', (_name, options) => {
    expect(build(options)).toThrow(SirenError);
    expect(build(options)).toThrow(/apiKey is required/);
  });
});

describe('Siren baseUrl edges', () => {
  it.each([
    ['a tab', 'https://cloud.test/siren/\tv1'],
    ['a DEL', 'https://cloud.test/siren/\u007fv1'],
    ['a space inside the path', 'https://cloud.test/siren v1'],
  ])('refuses a baseUrl that holds %s', (_name, baseUrl) => {
    expect(build({ apiKey: KEY, httpClient: new FakeHttpClient([reply(200, [])]), baseUrl })).toThrow(/baseUrl/);
  });

  it('accepts a scheme in upper case, which new URL reads as https', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient, baseUrl: 'HTTPS://cloud.test/siren/v1' }).payouts.list();

    expect(httpClient.requests[0]!.url).toBe('HTTPS://cloud.test/siren/v1/payouts');
  });
});

describe('Siren number checks and what a message says it got', () => {
  it('names the type of a bigint maxRetries, which is a whole number but not a number', () => {
    const run = build({ apiKey: KEY, httpClient: new FakeHttpClient([reply(200, [])]), maxRetries: 2n });

    expect(run).toThrow(SirenError);
    expect(run).toThrow(/It got bigint\.$/);
  });

  it('names a function timeout by its type', () => {
    const run = build({ apiKey: KEY, httpClient: new FakeHttpClient([reply(200, [])]), timeout: () => 1000 });

    expect(run).toThrow(/It got function\.$/);
  });
});
