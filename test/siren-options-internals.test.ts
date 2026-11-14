import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Siren, SirenError, type SirenOptions } from '../src/index';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Unit tests for the option resolvers behind the Siren constructor that the
 * P5 acceptance tests do not pin: values a JavaScript caller can pass past
 * the type, a token source missing its refresh method, and a client whose
 * send sits on its prototype.
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

function build(options: unknown): () => Siren {
  return () => new Siren(options as SirenOptions);
}

describe('Siren option resolvers', () => {
  it('refuses missing options with the apiKey message instead of a TypeError', () => {
    expect(build(undefined)).toThrow(SirenError);
    expect(build(undefined)).toThrow(/apiKey is required/);
    expect(build(null)).toThrow(/apiKey is required/);
  });

  it.each([
    ['a number', 42],
    ['null', null],
  ])('refuses an apiKey that is %s', (_name, apiKey) => {
    expect(build({ apiKey })).toThrow(SirenError);
    expect(build({ apiKey })).toThrow(/apiKey is required/);
  });

  it('reads an accessToken given as null as given, so it is refused beside an apiKey', () => {
    expect(build({ apiKey: 'sk_live_x', accessToken: null })).toThrow(/either apiKey or accessToken/i);
  });

  it.each([
    ['null', null],
    ['an object with only refreshAccessToken', { refreshAccessToken: () => null }],
    ['an object whose methods are not functions', { getAccessToken: 'x', refreshAccessToken: 'y' }],
    ['a function', () => 'x'],
  ])('refuses an accessToken that is %s', (_name, accessToken) => {
    expect(build({ accessToken })).toThrow(SirenError);
    expect(build({ accessToken })).toThrow(/accessToken/);
  });

  it('accepts a client whose send sits on its prototype', async () => {
    class PrototypeClient extends FakeHttpClient {}
    const httpClient = new PrototypeClient([reply(200, [])]);

    await new Siren({ apiKey: 'sk_live_x', httpClient }).payouts.list();

    expect(httpClient.requests).toHaveLength(1);
  });

  it('refuses an httpClient whose send is not a function', () => {
    expect(build({ apiKey: 'sk_live_x', httpClient: { send: 'POST' } })).toThrow(/httpClient/);
  });
});
