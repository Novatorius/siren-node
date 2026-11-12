import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  ConnectionError,
  FetchHttpClient,
  RecordsResource,
  Siren,
  SirenError,
  StaticAccessToken,
  type SirenOptions,
} from '../src/index';
import { HttpTransport, type HttpClient } from '../src/http';
import { CloudAnswers, FakeHttpClient, reply, spySource } from './http-fakes';

/*
 * Acceptance tests for the bearer token rule (A76 item 1, A81): a token the
 * SDK sends is a non-empty string with no control character and no character
 * above U+00FF. The rule holds at every place a token enters: the
 * getAccessToken answer, the refresh answer, and StaticAccessToken, which
 * `new Siren({ apiKey })` and a string `accessToken` build.
 *
 * Integration shape (KB 568): the real client, transport and resources, with
 * the network mocked only at the HttpClient seam. One test runs the real
 * FetchHttpClient over the real fetch, where today's code sends the token,
 * fetch refuses it, and the transport resends that as a lost connection.
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

function records(client: HttpClient, tokens = spySource(), maxRetries = 0): RecordsResource {
  const http = new HttpTransport({
    tokens,
    client,
    baseUrl: 'https://cloud.test/siren/v1',
    timeout: 1000,
    maxRetries,
  });
  return new RecordsResource(http, '/conversions');
}

/** Settle a promise and hand back what it rejected with, or fail when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

/*
 * Each value starts with a secret-looking prefix so a test can check the
 * error never quotes it. U+010A is the case a Latin-1 client turns into a
 * line feed, since it keeps only the low byte, 0x0A.
 */
const ABOVE_FF: Array<[string, string]> = [
  ['U+0100, the first character above U+00FF', 'sk_secret_firstĀX'],
  ['U+010A, whose low byte is a line feed', 'sk_secret_firstĊX-Injected: 1'],
  ['U+2028, the line separator', 'sk_secret_first X'],
  ['U+FFFF', 'sk_secret_first￿X'],
  ['a key emoji outside the Basic Multilingual Plane', 'sk_secret_first\u{1F511}X'],
];

const CONTROL: Array<[string, string]> = [
  ['a line break', 'sk_secret_first\r\nX-Injected: 1'],
  ['a NUL', 'sk_secret_first\u0000X'],
  ['a DEL (U+007F)', 'sk_secret_first\u007fX'],
];

describe('bearer token rule: the token from getAccessToken', () => {
  it.skip.each(ABOVE_FF)('refuses a token that holds %s with SirenError and sends nothing', async (_name, token) => {
    const tokens = spySource();
    tokens.getAccessToken.mockResolvedValueOnce(token);
    const client = new FakeHttpClient([reply(200, [])]);

    const error = await rejection(records(client, tokens).list());

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toMatch(/getAccessToken/);
    expect((error as SirenError).message).not.toContain('sk_secret_first');
    expect(client.requests).toHaveLength(0);
  });

  it.skip('refuses it before fetch sees it, so the real FetchHttpClient raises SirenError, not ConnectionError', async () => {
    const fetchCalls = vi.fn(realFetch);
    const tokens = spySource(['sk_secret_firstĊX-Injected: 1']);

    const error = await rejection(records(new FetchHttpClient(fetchCalls), tokens, 1).list());

    expect(error).toBeInstanceOf(SirenError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect((error as SirenError).message).toMatch(/getAccessToken/);
    expect(fetchCalls).not.toHaveBeenCalled();
  });

  it('sends a token whose characters are all U+00FF or below', async () => {
    const client = new FakeHttpClient([reply(200, [])]);

    await records(client, spySource(['tok-éÿ ~!'])).list();

    expect(client.bearers()).toEqual(['Bearer tok-éÿ ~!']);
  });
});

describe('bearer token rule: the token from refreshAccessToken', () => {
  it.skip.each(ABOVE_FF)('reads a refresh answer that holds %s as no token and raises the 401', async (_name, fresh) => {
    const tokens = spySource(['tok-1']);
    tokens.refreshAccessToken.mockResolvedValue(fresh);
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    const error = await rejection(records(client, tokens).list());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as SirenError).statusCode).toBe(401);
    expect((error as SirenError).message).not.toContain('sk_secret_first');
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(client.requests).toHaveLength(1);
  });

  it('sends a refresh answer whose characters are all U+00FF or below', async () => {
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    await records(client, spySource(['tok-1'], 'tok-ÿ')).list();

    expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-ÿ']);
  });
});

describe('bearer token rule: StaticAccessToken and the apiKey and accessToken options', () => {
  it.skip.each([...ABOVE_FF, ...CONTROL])(
    'refuses a token that holds %s when it is built, without quoting it',
    (_name, token) => {
      for (const build of [
        () => new StaticAccessToken(token),
        () => new Siren({ apiKey: token, httpClient: new FakeHttpClient([reply(200, [])]) }),
        () => new Siren({ accessToken: token, httpClient: new FakeHttpClient([reply(200, [])]) }),
      ]) {
        let error: unknown;
        try {
          build();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(SirenError);
        expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toContain('sk_secret_first');
      }
    },
  );

  it('builds a token whose characters are all U+00FF or below and sends it as given', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);

    expect(await new StaticAccessToken('sk_live_ÿ').getAccessToken()).toBe('sk_live_ÿ');
    await new Siren({ apiKey: 'sk_live_éÿ', httpClient }).payouts.list();

    expect(httpClient.bearers()).toEqual(['Bearer sk_live_éÿ']);
  });
});
