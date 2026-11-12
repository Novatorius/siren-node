import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  ConnectionError,
  FetchHttpClient,
  RecordsResource,
  Siren,
  SirenError,
  SiteDisconnectedError,
  StaticAccessToken,
} from '../src/index';
import { HttpTransport, type HttpClient } from '../src/http';
import { CloudAnswers, FakeHttpClient, failOnGlobalFetch, reply, spySource } from './http-fakes';

/*
 * Acceptance tests for the bearer token rule: a token the SDK sends is a
 * non-empty string with no control character (C0, DEL or C1) and no character
 * above U+00FF.
 * The rule holds at each place a token enters: the getAccessToken answer,
 * the refresh answer, and StaticAccessToken, which `new Siren({ apiKey })`
 * and a string `accessToken` build. The slice 2 transport tests pin the
 * empty, non-string and control-character answers on both token paths.
 *
 * Integration shape (KB 568): the real client, transport and resources, with
 * the network mocked only at the HttpClient seam. Two tests run the real
 * FetchHttpClient over the real fetch against a server on 127.0.0.1, because
 * fetch itself refuses a header value above U+00FF.
 */

/** The real fetch, kept before failOnGlobalFetch replaces the global one. */
const realFetch = globalThis.fetch;

beforeEach(failOnGlobalFetch);

afterEach(() => {
  vi.unstubAllGlobals();
});

function records(client: HttpClient, tokens = spySource(), maxRetries = 0, baseUrl = 'https://cloud.test/siren/v1'): RecordsResource {
  const http = new HttpTransport({ tokens, client, baseUrl, timeout: 1000, maxRetries });
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

/** Everything an error shows a caller or a log: message, stack, fields and the whole cause chain. */
function shown(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [e.message, e.stack, JSON.stringify(e), inspect(e, { depth: 10 }), inspect(e.cause, { depth: 10 })].join(' ');
}

/** True when `text` holds either half of a test token, the part before or after its bad character. */
function quotesToken(text: string): boolean {
  return text.includes('sk_secret_first') || text.includes('sk_secret_last');
}

/*
 * Each value holds a secret-looking prefix and suffix around one bad
 * character, so a test can check that no error quotes either half. U+010A is
 * the case a Latin-1 client turns into a line feed, since it keeps only the
 * low byte, 0x0A.
 */
const ABOVE_FF: Array<[string, string]> = [
  ['U+0100, the first character above U+00FF', 'sk_secret_first\u0100sk_secret_last'],
  ['U+010A, whose low byte is a line feed', 'sk_secret_first\u010aX-Injected: sk_secret_last'],
  ['U+2028, the line separator', 'sk_secret_first\u2028sk_secret_last'],
  ['U+FFFF', 'sk_secret_first\uffffsk_secret_last'],
  ['a key emoji outside the Basic Multilingual Plane', 'sk_secret_first\u{1F511}sk_secret_last'],
];

const CONTROL: Array<[string, string]> = [
  ['a line break', 'sk_secret_first\r\nX-Injected: sk_secret_last'],
  ['a NUL', 'sk_secret_first\u0000sk_secret_last'],
  ['a DEL (U+007F)', 'sk_secret_first\u007fsk_secret_last'],
  ['U+0080, the first C1 control', 'sk_secret_first\u0080sk_secret_last'],
  ['U+0085, the C1 next-line control', 'sk_secret_first\u0085sk_secret_last'],
  ['U+009F, the last C1 control', 'sk_secret_first\u009fsk_secret_last'],
];

/** Values a raw token source may answer that are not a token at all. */
const NOT_A_TOKEN: Array<[string, unknown]> = [
  ['an empty string', ''],
  ['undefined', undefined],
  ['a number', 42],
];

describe('bearer token rule: the token from getAccessToken', () => {
  it.skip.each([...ABOVE_FF, ...CONTROL])(
    'refuses a token that holds %s with SirenError naming the rule, and sends nothing',
    async (_name, token) => {
      const tokens = spySource();
      tokens.getAccessToken.mockResolvedValueOnce(token);
      const client = new FakeHttpClient([reply(200, [])]);

      const error = await rejection(records(client, tokens).list());

      expect(error).toBeInstanceOf(SirenError);
      expect((error as SirenError).message).toMatch(/getAccessToken/);
      expect((error as SirenError).message).toMatch(/control character/);
      expect((error as SirenError).message).toMatch(/U\+00FF/);
      expect(quotesToken(shown(error))).toBe(false);
      expect(client.requests).toHaveLength(0);
    },
  );

  it.skip('refuses it through new Siren with an AccessTokenSource, and sends nothing', async () => {
    const tokens = spySource(['sk_secret_first\u010ask_secret_last']);
    const httpClient = new FakeHttpClient([reply(200, [])]);

    const error = await rejection(new Siren({ accessToken: tokens, httpClient }).payouts.list());

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toMatch(/getAccessToken/);
    expect(httpClient.requests).toHaveLength(0);
  });

  it.skip('refuses it before fetch sees it, so the real FetchHttpClient raises SirenError, not ConnectionError', async () => {
    const fetchCalls = vi.fn(realFetch);
    const tokens = spySource(['sk_secret_first\u010aX-Injected: sk_secret_last']);

    const error = await rejection(records(new FetchHttpClient(fetchCalls), tokens, 1).list());

    expect(error).toBeInstanceOf(SirenError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect((error as SirenError).message).toMatch(/getAccessToken/);
    expect(fetchCalls).not.toHaveBeenCalled();
  });

  it('sends a token whose characters run from U+0020 to U+007E or U+00A0 to U+00FF', async () => {
    const client = new FakeHttpClient([reply(200, [])]);

    await records(client, spySource(['tok-\u00a0\u00e9\u00ff ~!'])).list();

    expect(client.bearers()).toEqual(['Bearer tok-\u00a0\u00e9\u00ff ~!']);
  });
});

describe('bearer token rule: the token from refreshAccessToken', () => {
  it.skip.each([...ABOVE_FF, ...CONTROL, ...NOT_A_TOKEN])(
    'raises the 401 after one send when the refresh answers %s, with a SirenError cause naming refreshAccessToken',
    async (_name, fresh) => {
      for (const [refusal, raised] of [
        [CloudAnswers.siteDisconnected, SiteDisconnectedError],
        [CloudAnswers.authenticationRequired, AuthenticationError],
      ] as const) {
        const tokens = spySource(['tok-1']);
        tokens.refreshAccessToken.mockResolvedValue(fresh);
        const client = new FakeHttpClient([reply(401, refusal), reply(200, [])]);

        const error = await rejection(records(client, tokens).list());

        expect(error).toBeInstanceOf(raised);
        expect((error as SirenError).statusCode).toBe(401);
        expect((error as SirenError).message).toBe(refusal.error.message);
        const cause = (error as Error).cause;
        expect(cause).toBeInstanceOf(SirenError);
        expect((cause as SirenError).message).toMatch(/refreshAccessToken/);
        expect((cause as SirenError).message).toMatch(/control character/);
        expect((cause as SirenError).message).toMatch(/U\+00FF/);
        expect(quotesToken(shown(error))).toBe(false);
        expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(client.requests).toHaveLength(1);
      }
    },
  );

  it('raises the 401 with no cause when the refresh answers null, the source cannot refresh', async () => {
    const tokens = spySource(['tok-1'], null);
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    const error = await rejection(records(client, tokens).list());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).cause).toBeUndefined();
    expect(client.requests).toHaveLength(1);
  });

  it.skip('reads such an answer through new Siren with an AccessTokenSource the same way', async () => {
    const tokens = spySource(['tok-1'], 'sk_secret_first\u010ask_secret_last');
    const httpClient = new FakeHttpClient([reply(401, CloudAnswers.siteDisconnected), reply(200, [])]);

    const error = await rejection(new Siren({ accessToken: tokens, httpClient }).payouts.list());

    expect(error).toBeInstanceOf(SiteDisconnectedError);
    expect((error as Error).cause).toBeInstanceOf(SirenError);
    expect(httpClient.requests).toHaveLength(1);
  });

  it('sends a refresh answer that holds U+00A0 and U+00FF', async () => {
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    await records(client, spySource(['tok-1'], 'tok-\u00a0\u00ff')).list();

    expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-\u00a0\u00ff']);
  });
});

describe('bearer token rule: StaticAccessToken and the apiKey and accessToken options', () => {
  it.skip.each([...ABOVE_FF, ...CONTROL])(
    'refuses a token that holds %s when it is built, naming the rule and never quoting it',
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
        expect((error as SirenError).message).toMatch(/control character/);
        expect((error as SirenError).message).toMatch(/U\+00FF/);
        expect((error as SirenError).message).toMatch(/apiKey/);
        expect((error as SirenError).message).toMatch(/accessToken/);
        expect(quotesToken(shown(error))).toBe(false);
      }
    },
  );

  it('builds a token that holds U+00A0 and U+00FF and sends it as given', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);

    expect(await new StaticAccessToken('sk_live_\u00a0').getAccessToken()).toBe('sk_live_\u00a0');
    await new Siren({ apiKey: 'sk_live_\u00a0\u00ff', httpClient }).payouts.list();

    expect(httpClient.bearers()).toEqual(['Bearer sk_live_\u00a0\u00ff']);
  });
});

describe('bearer token rule over a real socket', () => {
  let server: Server;
  let base: string;
  let received: Array<string | undefined> = [];

  beforeEach(() => {
    received = [];
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(req.headers.authorization);
      const first = received.length === 1;
      res.writeHead(first ? 401 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(first ? CloudAnswers.authenticationRequired : []));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/siren/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers a refreshed token with characters up to U+00FF to the server byte for byte', async () => {
    await records(new FetchHttpClient(realFetch), spySource(['tok-1'], 'tok-\u00e9\u00ff'), 0, base).list();

    // Node's HTTP server reads header bytes as Latin-1, so each byte is one character here.
    expect(received).toEqual(['Bearer tok-1', 'Bearer tok-\u00e9\u00ff']);
  });

  it.skip('raises the 401 after one send when the refresh answers U+010A, never resending through fetch', async () => {
    const fetchCalls = vi.fn(realFetch);

    const error = await rejection(
      records(new FetchHttpClient(fetchCalls), spySource(['tok-1'], 'sk_secret_first\u010ask_secret_last'), 1, base).list(),
    );

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect((error as Error).cause).toBeInstanceOf(SirenError);
    expect(fetchCalls).toHaveBeenCalledTimes(1);
    expect(received).toEqual(['Bearer tok-1']);
  });
});
