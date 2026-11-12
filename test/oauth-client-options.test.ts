import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren, SirenError, type SirenOptions } from '../src/index';
import { OAuthClient, SirenConnect } from '../src/connect/index';
import type { OAuthClientOptions } from '../src/connect/index';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Slice 5 fix acceptance tests for packet F1: OAuthClient reads and checks
 * its options as `new Siren()` does. The slice 5 review (Journal 32315,
 * finding K2) found that OAuthClient took `baseUrl`, `consentScreenUrl`,
 * `timeout` and `httpClient` without the checks slices 2b and 2c gave
 * Siren, so `https://api.sirenaffiliates.com@evil.invalid/siren/v1` sent a
 * refresh grant to evil.invalid.
 *
 * Each refusing row first proves that Siren and SirenConnect refuse the
 * value, then expects OAuthClient to refuse it with Siren's own message.
 * `consentScreenUrl` follows the `baseUrl` rule, and its message is Siren's
 * `baseUrl` message with the option's name in place of `baseUrl`.
 *
 * Integration shape (KB 568): the real clients over a FakeHttpClient at the
 * HttpClient seam. Nothing here sends through the network.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * packet F1, named in its describe block. The F1 implementer deletes the
 * `.skip` from each of them, so `it.skip(` becomes `it(` and `it.skip.each(`
 * becomes `it.each(`, and deletes the one-line comment above each, and this
 * paragraph. Nothing else here changes. The tests with no `.skip` pass now
 * and guard against a check that refuses too much.
 */

const KEY = `sk_live_${'b'.repeat(64)}`;
const BASE = 'https://api.sirenaffiliates.com/siren/v1';
const CONSENT = 'https://api.sirenaffiliates.com/connect-site';
const REFRESH = 'rt-REFRESHSECRET-9f2e';
const TOKENS = { access_token: 'at-ACCESSSECRET-1c0d', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-NEXT-55aa' };
const CHALLENGE = 'qK5ubukpq-o6_PxSWMjM1vhSc-DUYm0mxyefMlD3fI4';
const AUTHORIZE = { clientId: 'sc_4b1f0e3a9d2c', redirectUri: 'https://store.example/cb', state: 'a1b2c3d4', codeChallenge: CHALLENGE };

/** What a constructor threw, or `undefined` when it built. */
function thrown(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Siren's refusal of `options`, which every refusing row first requires. */
function sirenRefusal(options: Record<string, unknown>): SirenError {
  const error = thrown(() => new Siren({ apiKey: KEY, httpClient: new FakeHttpClient([]), ...options } as unknown as SirenOptions));
  expect(error, 'Siren refuses the value').toBeInstanceOf(SirenError);
  const connect = thrown(
    () => new SirenConnect({ accessToken: 'oauth-access-1', httpClient: new FakeHttpClient([]), ...options } as never),
  );
  expect(connect, 'SirenConnect refuses the value').toBeInstanceOf(SirenError);
  expect((connect as SirenError).message, 'SirenConnect refuses it as Siren does').toBe((error as SirenError).message);
  return error as SirenError;
}

/** OAuthClient's refusal of `options`, or a failed expectation when it built. */
function oauthRefusal(options: Record<string, unknown>): SirenError {
  const error = thrown(() => new OAuthClient({ httpClient: new FakeHttpClient([]), ...options } as OAuthClientOptions));
  expect(error, 'OAuthClient refuses the value').toBeInstanceOf(SirenError);
  return error as SirenError;
}

/** Everything an error shows a caller or a log: message, stack, fields, getters and hidden properties. */
function shown(error: SirenError): string {
  return [error.message, error.stack, JSON.stringify(error), inspect(error, { depth: 10, showHidden: true, getters: true })].join(' ');
}

/**
 * The parts of a URL a leak would show, in lower case, as the 2c tests read
 * them: each run of letters and digits four or more long that holds a
 * letter, other than the scheme, and each code unit outside U+0021 to
 * U+007E with its escaped forms. The made-up words (qhostq, qpathq,
 * QSECRETQ) stay out of stack frame paths.
 */
function urlParts(url: string): string[] {
  const words = url
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length >= 4 && /[A-Za-z]/.test(part) && !/^https?$/i.test(part));
  const unprintable = url.split('').filter((unit) => unit < '!' || unit > '~');
  const forms = unprintable.flatMap((unit) => {
    const hex = unit.charCodeAt(0).toString(16).padStart(4, '0');
    const escaped = [`\\u${hex}`, `u+${hex}`];
    if (unit.charCodeAt(0) <= 0xff) escaped.push(`\\x${hex.slice(2)}`);
    return [unit, ...escaped];
  });
  return [...words, ...forms].map((part) => part.toLowerCase());
}

/** Values Siren refuses as a `baseUrl`: the slice 2b and 2c rows, and the review's probe. */
const REFUSED_URLS: Array<[string, unknown]> = [
  ['an empty string', ''],
  ['null', null],
  ['a number', 42],
  ['an object', { href: 'https://qhostq.example/qpathq/v1' }],
  ['a string with no scheme', 'qhostq.example/qpathq/v1'],
  ['a string that is not a URL', 'QSECRETQ'],
  ['an ftp URL', 'ftp://qhostq.example/qpathq/v1'],
  ['a file URL', 'file:///qpathq/v1'],
  ['a javascript URL', 'javascript:alert(1)'],
  ['a URL with a user name and password', 'https://quserq:QSECRETQ@qhostq.example/qpathq/v1'],
  ['a URL with a user name only', 'https://quserq@qhostq.example/qpathq/v1'],
  ['a URL with a password and no user name', 'https://:QSECRETQ@qhostq.example/qpathq/v1'],
  ['the review probe, a Siren host before an @', 'https://api.sirenaffiliates.com@evil.invalid/siren/v1'],
  ['a scheme with no host', 'https://'],
  ['a URL whose port is out of range', 'https://qhostq.example:99999/qpathq/v1'],
  ['a URL with a leading space', ' https://qhostq.example/qpathq/v1'],
  ['a URL with a line feed inside the host', 'https://qhostq.exam\nple/qpathq/v1'],
  ['a URL that ends in CR LF', 'https://qhostq.example/qpathq/v1\r\n'],
  ['a URL with a query', 'https://qhostq.example/qpathq/v1?x=1'],
  ['a URL with an empty fragment', 'https://qhostq.example/qpathq/v1#'],
  ['U+0085, next line, in the path', 'https://qhostq.example/qpathq/\u0085v1'],
  ['U+00A0, a no-break space, in the path', 'https://qhostq.example/qpathq/ v1'],
  ['U+00FC in a host not given in punycode', 'https://bücherq.example/qpathq/v1'],
  ['U+010A in the path', 'https://qhostq.example/qpathq/Ċv1'],
  ['U+2028, line separator, in the path', 'https://qhostq.example/qpathq/ v1'],
  ['an emoji as the host', 'https://\u{1f99c}.example/qpathq/v1'],
  ['a backslash in the path', 'https://qhostq.example/qpathq\\v1'],
  ['the backslash form that hides a user name and password', 'http://localhost:1\\:QSECRETQ@127.0.0.1:8080/qpathq/v1'],
  ['an @ in the path', 'https://qhostq.example/qpathq/v1/@qmemberq'],
  ['an @ with an empty user name before the host', 'https://@qhostq.example/qpathq/v1'],
  ['no slashes after the scheme', 'https:qhostq.example/qpathq/v1'],
  ['one slash after the scheme', 'http:/127.0.0.1:8080/qpathq/v1'],
  ['three slashes after the scheme', 'http:///qhostq.example/qpathq/v1'],
  ['a percent-encoded full stop in the host', 'https://qhostq%E3%80%82example/qpathq/v1'],
];

/** Values Siren accepts as a `baseUrl`, with the URL OAuthClient's register then sends to. */
const ACCEPTED_URLS: Array<[string, string, string]> = [
  ['a plain https URL', 'https://qhostq.example/qpathq/v1', 'https://qhostq.example/qpathq/v1/oauth/register'],
  ['an https URL with a trailing slash', 'https://qhostq.example/qpathq/v1/', 'https://qhostq.example/qpathq/v1/oauth/register'],
  ['an http URL with a port', 'http://127.0.0.1:8080/qpathq/v1', 'http://127.0.0.1:8080/qpathq/v1/oauth/register'],
  ['a localhost URL with a port', 'http://localhost:8888/qpathq/v1', 'http://localhost:8888/qpathq/v1/oauth/register'],
  ['an IPv6 loopback URL', 'http://[::1]:8080/qpathq/v1', 'http://[::1]:8080/qpathq/v1/oauth/register'],
  ['a URL with a punycode host', 'https://xn--bcher-kva.example/qpathq/v1', 'https://xn--bcher-kva.example/qpathq/v1/oauth/register'],
  ['a URL with a percent-encoded character in the path', 'https://qhostq.example/q%C3%BC/v1', 'https://qhostq.example/q%C3%BC/v1/oauth/register'],
  ['a URL with a capital host and the default port', 'https://QHOSTQ.example:443/qpathq/v1', 'https://QHOSTQ.example:443/qpathq/v1/oauth/register'],
];

const REGISTER = { clientName: 'Example Store', redirectUris: ['https://store.example/cb'] };

describe('5 fix F1: OAuthClient baseUrl check', () => {
  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip.each(REFUSED_URLS)('refuses a baseUrl that is %s, with the message Siren gives and no part of the URL', (_name, baseUrl) => {
    const expected = sirenRefusal({ baseUrl });

    const error = oauthRefusal({ baseUrl });

    expect(error.message).toBe(expected.message);
    expect(error.cause).toBeUndefined();
    if (typeof baseUrl === 'string') {
      const text = shown(error).toLowerCase();
      expect(urlParts(baseUrl).filter((part) => text.includes(part))).toEqual([]);
    }
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('never sends a refresh grant to the host after an @, the review probe', async () => {
    const http = new FakeHttpClient([reply(200, TOKENS)]);

    let outcome: unknown;
    try {
      const oauth = new OAuthClient({ httpClient: http, baseUrl: 'https://api.sirenaffiliates.com@evil.invalid/siren/v1' });
      outcome = await oauth.refresh({ clientId: 'sc_4b1f0e3a9d2c', refreshToken: REFRESH });
    } catch (error) {
      outcome = error;
    }

    expect(outcome).toBeInstanceOf(SirenError);
    expect(http.requests.map((request) => request.url)).toEqual([]);
  });

  it.each(ACCEPTED_URLS)('accepts a baseUrl that is %s, as Siren does, and sends to it as given', async (_name, baseUrl, url) => {
    expect(thrown(() => new Siren({ apiKey: KEY, httpClient: new FakeHttpClient([]), baseUrl })), 'Siren accepts it').toBeUndefined();
    const http = new FakeHttpClient([reply(201, { client_id: 'sc_1' })]);

    await new OAuthClient({ httpClient: http, baseUrl }).register(REGISTER);

    expect(http.requests.map((request) => request.url)).toEqual([url]);
  });

  it('sends to the default host when baseUrl is given as undefined', async () => {
    const http = new FakeHttpClient([reply(201, { client_id: 'sc_1' })]);

    await new OAuthClient({ httpClient: http, baseUrl: undefined }).register(REGISTER);

    expect(http.requests.map((request) => request.url)).toEqual([`${BASE}/oauth/register`]);
  });
});

describe('5 fix F1: OAuthClient consentScreenUrl check', () => {
  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip.each(REFUSED_URLS)(
    'refuses a consentScreenUrl that is %s, with the baseUrl message under its own name and no part of the URL',
    (_name, consentScreenUrl) => {
      const expected = sirenRefusal({ baseUrl: consentScreenUrl });

      const error = oauthRefusal({ consentScreenUrl });

      expect(error.message).toBe(expected.message.replace(/\bbaseUrl\b/g, 'consentScreenUrl'));
      expect(error.message).not.toMatch(/\bbaseUrl\b/);
      expect(error.cause).toBeUndefined();
      if (typeof consentScreenUrl === 'string') {
        const text = shown(error).toLowerCase();
        expect(urlParts(consentScreenUrl).filter((part) => text.includes(part))).toEqual([]);
      }
    },
  );

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('never builds a consent link to the host after an @', () => {
    let outcome: unknown;
    try {
      outcome = new OAuthClient({
        httpClient: new FakeHttpClient([]),
        consentScreenUrl: 'https://api.sirenaffiliates.com@evil.invalid/connect-site',
      }).authorizeUrl(AUTHORIZE);
    } catch (error) {
      outcome = error;
    }

    expect(outcome).toBeInstanceOf(SirenError);
  });

  it.each(ACCEPTED_URLS)('accepts a consentScreenUrl that is %s and builds the link on it as given', (_name, consentScreenUrl) => {
    const link = new OAuthClient({ httpClient: new FakeHttpClient([]), consentScreenUrl }).authorizeUrl(AUTHORIZE);

    expect(link.startsWith(`${consentScreenUrl}?client_id=`)).toBe(true);
  });

  it('builds the link on the default consent screen when consentScreenUrl is given as undefined', () => {
    const link = new OAuthClient({ httpClient: new FakeHttpClient([]), consentScreenUrl: undefined }).authorizeUrl(AUTHORIZE);

    expect(link.startsWith(`${CONSENT}?client_id=`)).toBe(true);
  });
});

describe('5 fix F1: OAuthClient timeout check', () => {
  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['zero', 0],
    ['a fraction below 1', 0.5],
    ['just above the longest timer wait', 2_147_483_648],
    ['a string of digits', '15000'],
    ['a string that is not a number', 'sk_secret_value'],
    ['null', null],
    ['a boolean', true],
  ])('refuses a timeout that is %s, with the message Siren gives', (_name, timeout) => {
    const expected = sirenRefusal({ timeout });

    const error = oauthRefusal({ timeout });

    expect(error.message).toBe(expected.message);
    expect(error.message).not.toContain('sk_secret_value');
  });

  it.each([
    ['1', 1],
    ['2147483647, the longest timer wait', 2_147_483_647],
    ['a fraction of a millisecond above 1', 1.5],
  ])('accepts a timeout of %s and sends with it', async (_name, timeout) => {
    const http = new FakeHttpClient([reply(201, { client_id: 'sc_1' })]);

    await new OAuthClient({ httpClient: http, timeout }).register(REGISTER);

    expect(http.requests.map((request) => request.timeout)).toEqual([timeout]);
  });

  it('waits 15 seconds when timeout is given as undefined', async () => {
    const http = new FakeHttpClient([reply(201, { client_id: 'sc_1' })]);

    await new OAuthClient({ httpClient: http, timeout: undefined }).register(REGISTER);

    expect(http.requests.map((request) => request.timeout)).toEqual([15_000]);
  });
});

describe('5 fix F1: OAuthClient httpClient check', () => {
  const polluted: string[] = [];

  /** Puts a property on Object.prototype, as a prototype pollution bug would, until the test ends. */
  function pollute(name: string, value: unknown): void {
    (Object.prototype as Record<string, unknown>)[name] = value;
    polluted.push(name);
  }

  afterEach(() => {
    for (const name of polluted.splice(0)) delete (Object.prototype as Record<string, unknown>)[name];
  });

  it.each([
    ['null', null],
    ['an object with no send', {}],
    ['an object whose send is not a function', { send: 'not a function' }],
  ])('refuses an httpClient that is %s, with the message Siren gives', (_name, httpClient) => {
    const expected = sirenRefusal({ httpClient });

    expect(oauthRefusal({ httpClient }).message).toBe(expected.message);
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('refuses an httpClient whose send only Object.prototype supplies, as Siren does', () => {
    const attacker = vi.fn(async () => reply(200, TOKENS));
    pollute('send', attacker);
    const expected = sirenRefusal({ httpClient: {} });

    expect(oauthRefusal({ httpClient: {} }).message).toBe(expected.message);
    expect(attacker).not.toHaveBeenCalled();
  });
});

describe('5 fix F1: OAuthClient reads only its own options', () => {
  const polluted: string[] = [];

  /** Puts a property on Object.prototype, as a prototype pollution bug would, until the test ends. */
  function pollute(name: string, value: unknown): void {
    (Object.prototype as Record<string, unknown>)[name] = value;
    polluted.push(name);
  }

  afterEach(() => {
    for (const name of polluted.splice(0)) delete (Object.prototype as Record<string, unknown>)[name];
    vi.unstubAllGlobals();
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('sends a refresh to the default host when Object.prototype carries a baseUrl', async () => {
    pollute('baseUrl', 'https://attacker.example.invalid/siren/v1');
    const http = new FakeHttpClient([reply(200, TOKENS)]);

    await new OAuthClient({ httpClient: http }).refresh({ clientId: 'sc_1', refreshToken: REFRESH });

    expect(http.requests.map((request) => request.url)).toEqual([`${BASE}/oauth/token`]);
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('builds the consent link on the default screen when Object.prototype carries a consentScreenUrl', () => {
    pollute('consentScreenUrl', 'https://attacker.example.invalid/connect-site');

    const link = new OAuthClient({ httpClient: new FakeHttpClient([]) }).authorizeUrl(AUTHORIZE);

    expect(link.startsWith(`${CONSENT}?client_id=`)).toBe(true);
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('waits 15 seconds when Object.prototype carries a timeout', async () => {
    pollute('timeout', 1);
    const http = new FakeHttpClient([reply(200, TOKENS)]);

    await new OAuthClient({ httpClient: http }).refresh({ clientId: 'sc_1', refreshToken: REFRESH });

    expect(http.requests.map((request) => request.timeout)).toEqual([15_000]);
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('sends through the global fetch, not the polluting client, when Object.prototype carries an httpClient', async () => {
    const attacker = new FakeHttpClient([reply(200, TOKENS)]);
    pollute('httpClient', attacker);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(TOKENS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new OAuthClient().refresh({ clientId: 'sc_1', refreshToken: REFRESH });

    expect(attacker.requests).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Skipped until fix packet F1 (OAuthClient option checks) lands.
  it.skip('ignores every option the options object inherits from a prototype of its own', async () => {
    const inherited = new FakeHttpClient([reply(200, TOKENS)]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(TOKENS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const options = Object.create({
      baseUrl: 'https://attacker.example.invalid/siren/v1',
      consentScreenUrl: 'https://attacker.example.invalid/connect-site',
      httpClient: inherited,
      timeout: 1,
    }) as OAuthClientOptions;
    const oauth = new OAuthClient(options);

    await oauth.refresh({ clientId: 'sc_1', refreshToken: REFRESH });

    expect(inherited.requests).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/oauth/token`);
    expect(init.method).toBe('POST');
    expect(oauth.authorizeUrl(AUTHORIZE).startsWith(`${CONSENT}?client_id=`)).toBe(true);
  });

  it('builds from an options object with no prototype', async () => {
    const http = new FakeHttpClient([reply(200, TOKENS)]);
    const options = Object.assign(Object.create(null) as Record<string, unknown>, {
      httpClient: http,
      baseUrl: 'https://qhostq.example/qpathq/v1',
      timeout: 2500,
    });

    await new OAuthClient(options as OAuthClientOptions).refresh({ clientId: 'sc_1', refreshToken: REFRESH });

    expect(http.requests.map((request) => [request.url, request.timeout])).toEqual([['https://qhostq.example/qpathq/v1/oauth/token', 2500]]);
  });

  it('reads baseUrl once, so a getter cannot pass the check with one host and send to another', async () => {
    const http = new FakeHttpClient([reply(200, TOKENS)]);
    const hosts = ['https://qhostq.example/qpathq/v1', 'https://attacker.example.invalid/siren/v1'];
    let reads = 0;
    const options = {
      httpClient: http,
      get baseUrl() {
        const host = hosts[Math.min(reads, hosts.length - 1)];
        reads += 1;
        return host;
      },
    };

    await new OAuthClient(options).refresh({ clientId: 'sc_1', refreshToken: REFRESH });

    expect(http.requests.map((request) => request.url)).toEqual(['https://qhostq.example/qpathq/v1/oauth/token']);
    expect(reads).toBe(1);
  });
});
