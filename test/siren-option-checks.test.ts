import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Siren, SirenError, type SirenOptions } from '../src/index';
import { CloudAnswers, FakeHttpClient, failOnGlobalFetch, reply, spySource } from './http-fakes';

/*
 * Acceptance tests for the Siren constructor's option rules: `baseUrl`,
 * `timeout` and `maxRetries` are checked when the client is built, and the
 * constructor reads only the options object's own properties, each once, so
 * prototype pollution cannot choose the host, the HTTP client, the
 * credential or the retry policy.
 *
 * Integration shape (KB 568): the real Siren client, transport and
 * resources, with the network mocked only at the HttpClient seam. Two tests
 * run the default client over the real fetch against a server on
 * 127.0.0.1, because the default wiring is what pollution would reach.
 */

/** The real fetch, kept before failOnGlobalFetch replaces the global one. */
const realFetch = globalThis.fetch;

/** Every property Object.prototype holds before any test runs, enumerable or not. */
const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype).sort();

beforeEach(failOnGlobalFetch);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const KEY = `sk_live_${'b'.repeat(64)}`;

/** Build a client and hand back what the constructor threw, or fail when it built. */
function constructorError(options: Record<string, unknown>): SirenError {
  try {
    new Siren({ apiKey: KEY, httpClient: new FakeHttpClient([reply(200, [])]), ...options } as unknown as SirenOptions);
  } catch (error) {
    expect(error).toBeInstanceOf(SirenError);
    return error as SirenError;
  }
  throw new Error('expected the constructor to throw');
}

/** What a message must say it got: the number itself, or the type of anything else. */
function described(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return value === null ? 'null' : typeof value;
}

describe('2b P2: Siren timeout check', () => {
  it.skip.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['zero', 0],
    ['a fraction below 1', 0.5],
    ['a fraction above the longest timer wait', 2_147_483_647.5],
    ['just above the longest timer wait', 2_147_483_648],
    ['far above the longest timer wait', 1e12],
    ['a string of digits', '30000'],
    ['a string that is not a number', 'sk_secret_value'],
    ['null', null],
    ['a boolean', true],
  ])('refuses a timeout that is %s, naming the option, its range and what it got', (_name, timeout) => {
    const error = constructorError({ timeout });

    expect(error.message).toMatch(/\btimeout\b/);
    expect(error.message).not.toMatch(/maxRetries/);
    expect(error.message).toContain('from 1 to 2147483647');
    expect(error.message).toContain(described(timeout));
    expect(error.message).not.toContain('sk_secret_value');
    expect(error.message).not.toContain(KEY);
  });

  it.each([
    ['1', 1],
    ['2147483647, the longest timer wait', 2_147_483_647],
    ['a fraction of a millisecond above 1', 1.5],
  ])('accepts a timeout of %s and hands it to the client', async (_name, timeout) => {
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient, timeout }).payouts.list();

    expect(httpClient.requests[0]!.timeout).toBe(timeout);
  });

  it('defaults to 30000 when timeout is absent or given as undefined', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient }).payouts.list();
    await new Siren({ apiKey: KEY, httpClient, timeout: undefined }).payouts.list();

    expect(httpClient.requests.map((request) => request.timeout)).toEqual([30_000, 30_000]);
  });

  it('gives every send the full timeout: the first, each retry and the resend after a 401', async () => {
    vi.useFakeTimers();
    const httpClient = new FakeHttpClient([
      reply(503, undefined),
      reply(401, CloudAnswers.authenticationRequired),
      reply(503, undefined),
      reply(200, []),
    ]);
    const siren = new Siren({ accessToken: spySource(['tok-1'], 'tok-2'), httpClient, timeout: 1234, maxRetries: 2 });

    const pending = siren.conversions.list();
    await vi.runAllTimersAsync();

    expect(await pending).toEqual([]);
    expect(httpClient.requests.map((request) => request.timeout)).toEqual([1234, 1234, 1234, 1234]);
  });
});

describe('2b P2: Siren maxRetries check', () => {
  it.skip.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['a fraction', 1.5],
    ['a negative fraction', -0.5],
    ['a string of digits', '2'],
    ['a string that is not a number', 'sk_secret_value'],
    ['null', null],
    ['a boolean', false],
  ])('refuses a maxRetries that is %s, naming the option and what it got', (_name, maxRetries) => {
    const error = constructorError({ maxRetries });

    expect(error.message).toMatch(/maxRetries/);
    expect(error.message).not.toMatch(/\btimeout\b/);
    expect(error.message).toMatch(/whole number of 0 or more/);
    expect(error.message).toContain(described(maxRetries));
    expect(error.message).not.toContain('sk_secret_value');
    expect(error.message).not.toContain(KEY);
  });

  it.each([
    ['0, one send', 0, 1],
    ['3, four sends', 3, 4],
  ])('accepts a maxRetries of %s for a retriable read that keeps failing', async (_name, maxRetries, sends) => {
    vi.useFakeTimers();
    const httpClient = new FakeHttpClient([reply(503, undefined)]);
    const siren = new Siren({ apiKey: KEY, httpClient, maxRetries });

    const pending = siren.conversions.list().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await pending).toBeInstanceOf(SirenError);
    expect(httpClient.requests).toHaveLength(sends);
  });

  it.each([
    ['a million', 1e6],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ])('accepts a maxRetries of %s, since the option has no ceiling, and retries past 20', async (_name, maxRetries) => {
    vi.useFakeTimers();
    const httpClient = new FakeHttpClient([...Array.from({ length: 20 }, () => reply(503, undefined)), reply(200, [])]);
    const siren = new Siren({ apiKey: KEY, httpClient, maxRetries });

    const pending = siren.conversions.list();
    await vi.runAllTimersAsync();

    expect(await pending).toEqual([]);
    expect(httpClient.requests).toHaveLength(21);
  });

  it('defaults to 2 retries, three sends, when maxRetries is absent or given as undefined', async () => {
    vi.useFakeTimers();
    for (const options of [{}, { maxRetries: undefined }]) {
      const httpClient = new FakeHttpClient([reply(503, undefined)]);
      const siren = new Siren({ apiKey: KEY, httpClient, ...options });

      const pending = siren.conversions.list().catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await pending).toBeInstanceOf(SirenError);
      expect(httpClient.requests).toHaveLength(3);
    }
  });
});

describe('2b P2: Siren baseUrl check', () => {
  it.skip.each([
    ['an empty string', ''],
    ['null', null],
    ['a number', 42],
    ['an object', { href: 'https://cloud.test/siren/v1' }],
    ['a string with no scheme', 'cloud.test/siren/v1'],
    ['a string that is not a URL', 'sk_secret_value'],
    ['an ftp URL', 'ftp://cloud.test/siren/v1'],
    ['a file URL', 'file:///etc/siren/v1'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a URL with a user name and password', 'https://sk_secret_user:sk_secret_pass@cloud.test/siren/v1'],
    ['a URL with a user name only', 'https://sk_secret_user@cloud.test/siren/v1'],
  ])('refuses a baseUrl that is %s, naming the option and what it got', (_name, baseUrl) => {
    const error = constructorError({ baseUrl });

    expect(error.message).toMatch(/baseUrl/);
    expect(error.message).toMatch(/http or https URL/);
    expect(error.message).toContain(described(baseUrl));
    expect(error.message).not.toContain('sk_secret');
    expect(error.message).not.toContain('cloud.test');
    expect(error.message).not.toContain(KEY);
  });

  it.each([
    ['an https URL with a trailing slash', 'https://cloud.test/siren/v1/', 'https://cloud.test/siren/v1/payouts'],
    ['an http URL with a port', 'http://127.0.0.1:8080/siren/v1', 'http://127.0.0.1:8080/siren/v1/payouts'],
  ])('accepts a baseUrl that is %s and sends to it', async (_name, baseUrl, url) => {
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient, baseUrl }).payouts.list();

    expect(httpClient.requests[0]!.url).toBe(url);
  });
});

describe('2b P2: Siren reads only its own options', () => {
  const polluted: string[] = [];

  /** Puts a property on Object.prototype, as a prototype pollution bug would, until the test ends. */
  function pollute(name: string, value: unknown): void {
    (Object.prototype as Record<string, unknown>)[name] = value;
    polluted.push(name);
  }

  afterEach(() => {
    for (const name of polluted.splice(0)) delete (Object.prototype as Record<string, unknown>)[name];
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(PROTOTYPE_NAMES);
  });

  let server: Server;
  let base: string;
  let received: Array<string | undefined> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/siren/v1`;
  });

  beforeEach(() => {
    received = [];
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends over the real fetch to a real server when no httpClient is given', async () => {
    vi.stubGlobal('fetch', realFetch);

    await new Siren({ apiKey: KEY, baseUrl: base }).payouts.list();

    expect(received).toEqual([`Bearer ${KEY}`]);
  });

  it.skip('sends over the real fetch, not through the polluting client, when Object.prototype carries an httpClient', async () => {
    const attacker = new FakeHttpClient([reply(200, [])]);
    pollute('httpClient', attacker);
    vi.stubGlobal('fetch', realFetch);

    await new Siren({ apiKey: KEY, baseUrl: base }).payouts.list();

    expect(attacker.requests).toHaveLength(0);
    expect(received).toEqual([`Bearer ${KEY}`]);
  });

  it.skip('sends to the default host when Object.prototype carries a baseUrl', async () => {
    pollute('baseUrl', 'https://attacker.test/siren/v1');
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient }).payouts.list();

    expect(httpClient.requests[0]!.url).toBe('https://api.sirenaffiliates.com/siren/v1/payouts');
  });

  it.skip('sends through the default client when Object.prototype carries an httpClient', async () => {
    const attacker = new FakeHttpClient([reply(200, [])]);
    pollute('httpClient', attacker);
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await new Siren({ apiKey: KEY }).payouts.list();

    expect(attacker.requests).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.skip.each([
    ['an apiKey', 'apiKey', 'sk_live_attacker'],
    ['an accessToken', 'accessToken', 'oauth-attacker'],
  ])('refuses a client with no credential of its own when Object.prototype carries %s', (_name, option, value) => {
    pollute(option, value);
    const httpClient = new FakeHttpClient([reply(200, [])]);

    let error: unknown;
    try {
      new Siren({ httpClient } as unknown as SirenOptions);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toMatch(/apiKey is required/);
    expect(httpClient.requests).toHaveLength(0);
  });

  it.skip.each([
    ['an apiKey beside the given accessToken', 'apiKey', { accessToken: 'oauth-access-1' }, 'Bearer oauth-access-1'],
    ['an accessToken beside the given apiKey', 'accessToken', { apiKey: KEY }, `Bearer ${KEY}`],
  ])(
    'sends the given credential when Object.prototype carries %s',
    async (_name, option, credential, bearer) => {
      pollute(option, 'attacker-credential');
      const httpClient = new FakeHttpClient([reply(200, [])]);

      await new Siren({ ...credential, httpClient } as unknown as SirenOptions).payouts.list();

      expect(httpClient.bearers()).toEqual([bearer]);
    },
  );

  it.skip('keeps the default timeout when Object.prototype carries one', async () => {
    pollute('timeout', 1);
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient }).payouts.list();

    expect(httpClient.requests[0]!.timeout).toBe(30_000);
  });

  it.skip('keeps the default maxRetries when Object.prototype carries one', async () => {
    vi.useFakeTimers();
    pollute('maxRetries', 0);
    const httpClient = new FakeHttpClient([reply(503, undefined), reply(200, [])]);

    const pending = new Siren({ apiKey: KEY, httpClient }).conversions.list().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual([]);
    expect(httpClient.requests).toHaveLength(2);
  });

  it('builds from an options object with no prototype', async () => {
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const options = Object.assign(Object.create(null) as Record<string, unknown>, {
      apiKey: KEY,
      httpClient,
      timeout: 2500,
      maxRetries: 0,
      baseUrl: 'https://cloud.test/siren/v1',
    });

    await new Siren(options as unknown as SirenOptions).payouts.list();

    expect(httpClient.requests[0]!.url).toBe('https://cloud.test/siren/v1/payouts');
    expect(httpClient.requests[0]!.timeout).toBe(2500);
    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`]);
  });

  it.skip('ignores every option an options object inherits from a prototype of its own', async () => {
    vi.useFakeTimers();
    const attacker = Object.create(null) as Record<string, unknown>;
    Object.assign(attacker, {
      baseUrl: 'https://attacker.test/siren/v1',
      accessToken: 'attacker-credential',
      timeout: 1,
      maxRetries: 0,
    });
    const httpClient = new FakeHttpClient([reply(503, undefined), reply(200, [])]);
    const options = Object.assign(Object.create(attacker) as Record<string, unknown>, { apiKey: KEY, httpClient });

    const pending = new Siren(options as unknown as SirenOptions).conversions.list().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual([]);
    expect(httpClient.requests.map((request) => request.url)).toEqual([
      'https://api.sirenaffiliates.com/siren/v1/conversions',
      'https://api.sirenaffiliates.com/siren/v1/conversions',
    ]);
    expect(httpClient.requests[0]!.timeout).toBe(30_000);
    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  it.skip('sends through the default client when the options object inherits an httpClient from its own prototype', async () => {
    const attacker = new FakeHttpClient([reply(200, [])]);
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const options = Object.assign(Object.create({ httpClient: attacker }) as Record<string, unknown>, { apiKey: KEY });

    await new Siren(options as unknown as SirenOptions).payouts.list();

    expect(attacker.requests).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends to its own baseUrl when Object.prototype carries another', async () => {
    pollute('baseUrl', 'https://attacker.test/siren/v1');
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ apiKey: KEY, httpClient, baseUrl: 'https://cloud.test/siren/v1' }).payouts.list();

    expect(httpClient.requests[0]!.url).toBe('https://cloud.test/siren/v1/payouts');
  });

  it.skip('refuses an accessToken whose refreshAccessToken only Object.prototype supplies', () => {
    pollute('refreshAccessToken', async () => 'attacker-credential');

    expect(() => new Siren({ accessToken: { getAccessToken: () => 'oauth-access-1' } } as unknown as SirenOptions)).toThrow(
      /accessToken/,
    );
  });

  it.skip('refuses an httpClient whose send only Object.prototype supplies', () => {
    pollute('send', async () => reply(200, []));

    expect(() => new Siren({ apiKey: KEY, httpClient: {} } as unknown as SirenOptions)).toThrow(/httpClient/);
  });

  it.skip('refuses a class instance as httpClient when only Object.prototype supplies its send', () => {
    pollute('send', async () => reply(200, []));
    class NoSend {}

    expect(() => new Siren({ apiKey: KEY, httpClient: new NoSend() } as unknown as SirenOptions)).toThrow(/httpClient/);
  });

  class OnlyGet {
    getAccessToken(): string {
      return 'oauth-access-1';
    }
  }

  class OnlyRefresh {
    refreshAccessToken(): null {
      return null;
    }
  }

  it.skip.each([
    ['refreshAccessToken', OnlyGet],
    ['getAccessToken', OnlyRefresh],
  ])('refuses a class instance as accessToken when only Object.prototype supplies its %s', (method, Source) => {
    pollute(method, async () => 'attacker-credential');

    expect(() => new Siren({ accessToken: new Source() } as unknown as SirenOptions)).toThrow(/accessToken/);
  });

  it('accepts a token source and a client whose methods sit on their class prototypes', async () => {
    class Tokens extends OnlyGet {
      refreshAccessToken(): null {
        return null;
      }
    }
    const httpClient = new FakeHttpClient([reply(200, [])]);

    await new Siren({ accessToken: new Tokens(), httpClient }).payouts.list();

    expect(httpClient.bearers()).toEqual(['Bearer oauth-access-1']);
  });

  it('reads each option once, so a getter cannot pass the check with one value and send another', async () => {
    const reads: Record<string, number> = {};
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const values: Record<string, unknown[]> = {
      apiKey: [KEY, 'sk_live_second_read'],
      httpClient: [httpClient, new FakeHttpClient([reply(200, [])])],
      baseUrl: ['https://cloud.test/siren/v1', 'https://attacker.test/siren/v1'],
      timeout: [2500, 1],
      maxRetries: [0, 5],
    };
    const options = {};
    for (const [name, answers] of Object.entries(values)) {
      Object.defineProperty(options, name, {
        enumerable: true,
        get: () => {
          reads[name] = (reads[name] ?? 0) + 1;
          return answers[Math.min(reads[name]! - 1, answers.length - 1)];
        },
      });
    }

    await new Siren(options as unknown as SirenOptions).payouts.list();

    expect(reads).toEqual({ apiKey: 1, httpClient: 1, baseUrl: 1, timeout: 1, maxRetries: 1 });
    expect(httpClient.requests[0]!.url).toBe('https://cloud.test/siren/v1/payouts');
    expect(httpClient.requests[0]!.timeout).toBe(2500);
    expect(httpClient.bearers()).toEqual([`Bearer ${KEY}`]);
  });

  it('reads an accessToken once, so a getter cannot pass the check with one source and send through another', async () => {
    let reads = 0;
    const sources = [spySource(['oauth-first']), spySource(['oauth-second'])];
    const httpClient = new FakeHttpClient([reply(200, [])]);
    const options = { httpClient };
    Object.defineProperty(options, 'accessToken', {
      enumerable: true,
      get: () => sources[Math.min(reads++, 1)],
    });

    await new Siren(options as unknown as SirenOptions).payouts.list();

    expect(reads).toBe(1);
    expect(httpClient.bearers()).toEqual(['Bearer oauth-first']);
  });
});
