import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  BadRequestError,
  ConnectionError,
  HttpClientError,
  RateLimitError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import {
  ConnectorScope,
  ConnectorSoftware,
  OAuthClient,
  OAuthError,
  OAuthErrorCode,
  codeChallengeS256,
} from '../src/connect/index';
import type { HttpRequest, HttpResponse } from '../src/http';
import { shown } from './error-text';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Slice 5 acceptance tests for packet P2: OAuthClient, the connected site's
 * calls to Siren Cloud's OAuth provider.
 *
 * Integration shape (KB 568): the real OAuthClient sending through a
 * FakeHttpClient at the HttpClient seam, answered with the bodies Siren
 * builds at b6f7140d0: saas/Rest/OAuth/RegisterOAuthClient.php (201, and
 * oauthError at line 183), saas/Rest/OAuth/IssueToken.php (the OAuth error
 * envelope, status 400 unless the exception names another) and
 * lib/OAuth/Core/Services/OAuthService.php (registerClient at line 111,
 * tokenResponse at line 264, the invalid_grant messages). The consent URL
 * order is lib/Connect/Service/Services/OAuthConnectService.php begin().
 *
 * Hand-read from the cited source, not captured from a running Cloud.
 * Slice 20 runs the connector golden path against a local Cloud and
 * replaces these bodies.
 */

const BASE = 'https://api.sirenaffiliates.com/siren/v1';
const REDIRECT = 'https://store.example/siren/callback';
const CLIENT_ID = 'sc_4b1f0e3a9d2c';
const CODE = 'code-AUTHCODE-77d1';
const VERIFIER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CHALLENGE = 'qK5ubukpq-o6_PxSWMjM1vhSc-DUYm0mxyefMlD3fI4';
const REFRESH = 'rt-REFRESHSECRET-9f2e';

const Cloud = {
  registered: {
    client_id: CLIENT_ID,
    client_name: 'Example Store',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    scope: ConnectorScope.CONNECTED_SITE,
    software_id: 'siren-medusa',
  },
  tokens: {
    access_token: 'at-ACCESSSECRET-1c0d',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: ConnectorScope.CONNECTED_SITE,
    refresh_token: 'rt-NEXTSECRET-55aa',
  },
  badMetadata: { error: 'invalid_client_metadata', error_description: 'client_name and redirect_uris are required.' },
  revoked: { error: 'invalid_grant', error_description: 'Refresh token has been revoked.' },
  unknownClient: { error: 'invalid_client', error_description: 'Unknown client_id.' },
  pkceFailed: { error: 'invalid_grant', error_description: 'PKCE verification failed.' },
} as const;

function client(replies: Array<HttpResponse | Error> = [reply(200, Cloud.tokens)]) {
  const http = new FakeHttpClient(replies);
  return { http, oauth: new OAuthClient({ httpClient: http }) };
}

function header(request: HttpRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function bodyOf(request: HttpRequest): unknown {
  return JSON.parse(request.body ?? 'null');
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}


const registerParams = {
  clientName: 'Example Store',
  redirectUris: [REDIRECT],
  softwareId: ConnectorSoftware.Medusa,
};

describe('P2: OAuthClient.register', () => {
  it('sends one JSON POST to /oauth/register with the RFC 7591 body and no Authorization, and answers the 201 body as sent', async () => {
    const answer = { ...Cloud.registered, added_later: 'kept' };
    const { http, oauth } = client([reply(201, answer)]);

    const registered = await oauth.register(registerParams);

    expect(registered).toEqual(answer);
    expect(http.requests).toHaveLength(1);
    const [request] = http.requests;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe(`${BASE}/oauth/register`);
    expect(bodyOf(request!)).toEqual({
      client_name: 'Example Store',
      redirect_uris: [REDIRECT],
      scope: ConnectorScope.CONNECTED_SITE,
      software_id: 'siren-medusa',
    });
    expect(header(request!, 'content-type')).toBe('application/json');
    expect(header(request!, 'accept')).toBe('application/json');
    expect(header(request!, 'user-agent')).toMatch(/^siren-sdk-typescript\//);
    expect(header(request!, 'authorization')).toBeUndefined();
    expect(request!.timeout).toBe(15_000);
  });

  it('leaves software_id out when none is given and sends the scope it is handed', async () => {
    const { http, oauth } = client([reply(201, { ...Cloud.registered, software_id: undefined })]);

    await oauth.register({ clientName: 'Example Store', redirectUris: [REDIRECT], scope: 'connect:*' });

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0]!)).toEqual({ client_name: 'Example Store', redirect_uris: [REDIRECT], scope: 'connect:*' });
  });

  it('sends to the baseUrl it is given, without a trailing slash, and waits the timeout it is given', async () => {
    const http = new FakeHttpClient([reply(201, Cloud.registered)]);
    const oauth = new OAuthClient({ httpClient: http, baseUrl: 'http://localhost:8080/siren/v1/', timeout: 4000 });

    await oauth.register(registerParams);

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe('http://localhost:8080/siren/v1/oauth/register');
    expect(http.requests[0]!.timeout).toBe(4000);
  });

  it.each([
    ['an empty clientName', { ...registerParams, clientName: '' }],
    ['a clientName of only white space', { ...registerParams, clientName: '  \t' }],
    ['no redirect URI', { ...registerParams, redirectUris: [] }],
    ['an empty redirect URI', { ...registerParams, redirectUris: [REDIRECT, ''] }],
    ['a redirect URI that is not text', { ...registerParams, redirectUris: [REDIRECT, 7] }],
    ['an unknown softwareId', { ...registerParams, softwareId: 'siren-shopify' }],
  ])('refuses %s with SirenError and sends nothing', async (_name, params) => {
    const { http, oauth } = client([reply(201, Cloud.registered)]);

    const error = await failure(oauth.register(params as never));

    expect(error).toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it("raises Cloud's invalid_client_metadata as OAuthError with its code, status and description, sent once", async () => {
    const { http, oauth } = client([reply(400, Cloud.badMetadata)]);

    const error = await failure(oauth.register(registerParams));

    expect(error).toBeInstanceOf(OAuthError);
    expect(error).toBeInstanceOf(SirenError);
    expect(error.name).toBe('OAuthError');
    expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidClientMetadata);
    expect((error as OAuthError).statusCode).toBe(400);
    expect(error.message).toBe('client_name and redirect_uris are required.');
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    ['a body without client_id', reply(201, { client_name: 'Example Store' })],
    ['a body that is not JSON', { status: 201, headers: {}, body: '<html>ok</html>' }],
    ['a JSON array', reply(201, [Cloud.registered])],
  ])('raises UnexpectedResponseError for a 2xx with %s', async (_name, answer) => {
    const { oauth } = client([answer]);

    await expect(oauth.register(registerParams)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

const authorizeParams = { clientId: CLIENT_ID, redirectUri: REDIRECT, state: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', codeChallenge: CHALLENGE };

describe('P2: OAuthClient.authorizeUrl', () => {
  it("builds the consent screen URL with Siren's six query parameters, in begin()'s order, and sends nothing", () => {
    const { http, oauth } = client();

    const url = new URL(oauth.authorizeUrl(authorizeParams));

    expect(`${url.origin}${url.pathname}`).toBe('https://api.sirenaffiliates.com/connect-site');
    expect([...url.searchParams]).toEqual([
      ['client_id', CLIENT_ID],
      ['redirect_uri', REDIRECT],
      ['code_challenge', CHALLENGE],
      ['code_challenge_method', 'S256'],
      ['state', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'],
      ['scope', ConnectorScope.CONNECTED_SITE],
    ]);
    expect(http.requests).toHaveLength(0);
  });

  it('uses the consentScreenUrl and scope it is given', () => {
    const oauth = new OAuthClient({ httpClient: new FakeHttpClient([]), consentScreenUrl: 'http://localhost:5173/connect-site' });

    const url = new URL(oauth.authorizeUrl({ ...authorizeParams, scope: 'connect:* connect:webhooks' }));

    expect(`${url.origin}${url.pathname}`).toBe('http://localhost:5173/connect-site');
    expect(url.searchParams.get('scope')).toBe('connect:* connect:webhooks');
  });

  it('takes the challenge codeChallengeS256 makes from a verifier', () => {
    const { oauth } = client();

    const url = new URL(oauth.authorizeUrl({ ...authorizeParams, codeChallenge: codeChallengeS256(VERIFIER) }));

    expect(url.searchParams.get('code_challenge')).toBe(CHALLENGE);
  });

  it.each([
    ['the verifier itself', { codeChallenge: VERIFIER }],
    ['a challenge with padding', { codeChallenge: `${CHALLENGE.slice(0, 42)}=` }],
    ['a standard base64 challenge', { codeChallenge: `${CHALLENGE.slice(0, 42)}+` }],
    ['a 42 character challenge', { codeChallenge: CHALLENGE.slice(0, 42) }],
    ['a 44 character challenge', { codeChallenge: `${CHALLENGE}A` }],
  ])('refuses %s with SirenError, quoting none of it', (_name, change) => {
    const { oauth } = client();

    let caught: unknown;
    try {
      oauth.authorizeUrl({ ...authorizeParams, ...change });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SirenError);
    expect(shown(caught)).not.toContain(change.codeChallenge.slice(0, 12));
  });

  it.each([['clientId'], ['redirectUri'], ['state']])('refuses an empty %s with SirenError', (field) => {
    const { oauth } = client();

    expect(() => oauth.authorizeUrl({ ...authorizeParams, [field]: '' })).toThrow(SirenError);
  });
});

const exchangeParams = { clientId: CLIENT_ID, code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER };
const refreshParams = { clientId: CLIENT_ID, refreshToken: REFRESH };

describe('P2: OAuthClient.exchangeCode', () => {
  it("sends one JSON POST to /oauth/token with the authorization_code grant, and answers Cloud's token body as sent", async () => {
    const { http, oauth } = client([reply(200, Cloud.tokens)]);

    const tokens = await oauth.exchangeCode(exchangeParams);

    expect(tokens).toEqual(Cloud.tokens);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('POST');
    expect(http.requests[0]!.url).toBe(`${BASE}/oauth/token`);
    expect(bodyOf(http.requests[0]!)).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: CODE,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(header(http.requests[0]!, 'content-type')).toBe('application/json');
    expect(header(http.requests[0]!, 'authorization')).toBeUndefined();
  });

  it.each([['clientId'], ['code'], ['redirectUri'], ['codeVerifier']])(
    'refuses an empty %s with SirenError and sends nothing',
    async (field) => {
      const { http, oauth } = client();

      await expect(oauth.exchangeCode({ ...exchangeParams, [field]: '' })).rejects.toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    },
  );

  it("raises Cloud's invalid_grant as OAuthError, sent once", async () => {
    const { http, oauth } = client([reply(400, Cloud.pkceFailed)]);

    const error = await failure(oauth.exchangeCode(exchangeParams));

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe('invalid_grant');
    expect(error.message).toBe('PKCE verification failed.');
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    ['without refresh_token', { ...Cloud.tokens, refresh_token: undefined }],
    ['without access_token', { ...Cloud.tokens, access_token: undefined }],
  ])('raises UnexpectedResponseError for a 2xx %s, showing no token from the body', async (_name, body) => {
    const { oauth } = client([reply(200, body)]);

    const error = await failure(oauth.exchangeCode(exchangeParams));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(shown(error)).not.toContain('ACCESSSECRET');
    expect(shown(error)).not.toContain('NEXTSECRET');
  });

  it('keeps the code and the verifier out of a ConnectionError, and keeps the client error cause', async () => {
    const cause = new Error('socket hang up');
    const { oauth } = client([new HttpClientError(`POST failed with code=${CODE}&code_verifier=${VERIFIER}`, { cause })]);

    const error = await failure(oauth.exchangeCode(exchangeParams));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.cause).toBe(cause);
    expect(shown(error)).not.toContain(CODE);
    expect(shown(error)).not.toContain(VERIFIER);
  });
});

describe('P2: OAuthClient.refresh', () => {
  it("sends the refresh_token grant without attempt_id when none is given, and answers Cloud's new pair as sent", async () => {
    const { http, oauth } = client([reply(200, Cloud.tokens)]);

    const tokens = await oauth.refresh(refreshParams);

    expect(tokens).toEqual(Cloud.tokens);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe(`${BASE}/oauth/token`);
    expect(bodyOf(http.requests[0]!)).toEqual({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: REFRESH });
  });

  it('sends attempt_id when one is given', async () => {
    const { http, oauth } = client([reply(200, Cloud.tokens)]);

    await oauth.refresh({ ...refreshParams, attemptId: 'attempt-1' });

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0]!)).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: REFRESH,
      attempt_id: 'attempt-1',
    });
  });

  it('raises a 302 as SirenError, not as an OAuth or API error, and never follows it', async () => {
    const { http, oauth } = client([reply(302, undefined, { Location: 'https://elsewhere.example/' })]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).not.toBeInstanceOf(OAuthError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as SirenError).statusCode).toBe(302);
    expect(http.requests.map((request) => request.url)).toEqual([`${BASE}/oauth/token`]);
  });

  // Cloud's IssueToken answers 400 for every refusal at b6f7140d0. The 401 row is
  // RFC 6749 section 5.2's form for invalid_client, which Cloud may send later.
  it.each([
    [400, Cloud.revoked, 'invalid_grant'],
    [400, Cloud.unknownClient, 'invalid_client'],
    [401, Cloud.unknownClient, 'invalid_client'],
  ])('raises a %i with %j as OAuthError with that code and status', async (status, body, code) => {
    const { oauth } = client([reply(status, body)]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe(code);
    expect((error as OAuthError).statusCode).toBe(status);
    expect(error.message).toBe(body.error_description);
  });

  it("falls back to the code as the message when Cloud sends no error_description", async () => {
    const { oauth } = client([reply(400, { error: 'invalid_grant' })]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(OAuthError);
    expect(error.message).toBe('invalid_grant');
  });

  // Cloud sends no OAuth envelope on 429 or 503 today. These rows pin what a
  // proxy or a later Cloud sending RFC 6749's temporarily_unavailable gets.
  it.each([
    [429, RateLimitError],
    [503, ApiError],
  ])('raises a %i as the usual error for its status even when its body is the OAuth envelope', async (status, type) => {
    const { oauth } = client([reply(status, { error: 'temporarily_unavailable', error_description: 'Try again later.' }, { 'Retry-After': '0' })]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(type);
    expect(error).not.toBeInstanceOf(OAuthError);
  });

  it("raises a 400 in the app's error envelope through errorFromResponse, not as OAuthError", async () => {
    const { oauth } = client([reply(400, { error: { message: 'Bad request', context: [] } })]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).not.toBeInstanceOf(OAuthError);
  });

  it('keeps the attemptId out of a ConnectionError', async () => {
    const attemptId = 'attempt-SECRETATTEMPT-77';
    const { oauth } = client([new HttpClientError(`timed out sending attempt_id=${attemptId}`)]);

    const error = await failure(oauth.refresh({ ...refreshParams, attemptId }));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(shown(error)).not.toContain(attemptId);
  });

  it('keeps the refresh token out of a ConnectionError, and keeps the client error cause', async () => {
    const cause = new Error('ETIMEDOUT');
    const { oauth } = client([new HttpClientError(`timed out sending refresh_token=${REFRESH}`, { cause })]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.cause).toBe(cause);
    expect(shown(error)).not.toContain(REFRESH);
  });

  it('gives the ConnectionError no cause when the client error has none, so its message cannot leak through', async () => {
    const { oauth } = client([new HttpClientError(`timed out sending refresh_token=${REFRESH}`)]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.cause).toBeUndefined();
    expect(shown(error)).not.toContain(REFRESH);
  });

  it('passes any other error from the client through unchanged', async () => {
    const thrown = new TypeError('the host stack broke');
    const { http, oauth } = client([thrown, reply(200, Cloud.tokens)]);

    await expect(oauth.refresh(refreshParams)).rejects.toBe(thrown);
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    ['without refresh_token', { ...Cloud.tokens, refresh_token: undefined }],
    ['without access_token', { ...Cloud.tokens, access_token: undefined }],
  ])('raises UnexpectedResponseError for a 2xx %s, showing no token from the body', async (_name, body) => {
    const { oauth } = client([reply(200, body)]);

    const error = await failure(oauth.refresh(refreshParams));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(shown(error)).not.toContain('ACCESSSECRET');
    expect(shown(error)).not.toContain('NEXTSECRET');
    expect(shown(error)).not.toContain(REFRESH);
  });

  it.each([
    ['an empty clientId', { ...refreshParams, clientId: '' }],
    ['an empty refreshToken', { ...refreshParams, refreshToken: '' }],
    ['an empty attemptId', { ...refreshParams, attemptId: '' }],
  ])('refuses %s with SirenError and sends nothing', async (_name, params) => {
    const { http, oauth } = client();

    await expect(oauth.refresh(params)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

type SendingCall = [string, (oauth: OAuthClient) => Promise<unknown>, string, HttpResponse];

const SENDING_CALLS: SendingCall[] = [
  ['register', (o) => o.register(registerParams), `${BASE}/oauth/register`, reply(201, Cloud.registered)],
  ['exchangeCode', (o) => o.exchangeCode(exchangeParams), `${BASE}/oauth/token`, reply(200, Cloud.tokens)],
  ['refresh', (o) => o.refresh({ ...refreshParams, attemptId: 'attempt-1' }), `${BASE}/oauth/token`, reply(200, Cloud.tokens)],
];

describe('P2: OAuthClient rules every sending call follows', () => {
  it.each(SENDING_CALLS)('%s sends the SDK headers, no Authorization, and waits 15 seconds by default', async (_name, call, url, success) => {
    const { http, oauth } = client([success]);

    await call(oauth);

    expect(http.requests).toHaveLength(1);
    const [request] = http.requests;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe(url);
    expect(header(request!, 'content-type')).toBe('application/json');
    expect(header(request!, 'accept')).toBe('application/json');
    expect(header(request!, 'user-agent')).toMatch(/^siren-sdk-typescript\//);
    expect(header(request!, 'authorization')).toBeUndefined();
    expect(request!.timeout).toBe(15_000);
  });

  it.each(SENDING_CALLS)('%s waits the timeout it is given', async (_name, call, _url, success) => {
    const http = new FakeHttpClient([success]);

    await call(new OAuthClient({ httpClient: http, timeout: 4000 }));

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.timeout).toBe(4000);
  });

  it.each(SENDING_CALLS)('%s is sent exactly once on any failure, and raises it', async (name, call, _url, success) => {
    const failures: Array<[string, HttpResponse | Error, new (...args: never[]) => Error]> = [
      ['a 503', reply(503, { error: { message: 'Service unavailable', context: [] } }), ApiError],
      ['a 500 with no body', reply(500), ApiError],
      ['a 429', reply(429, { error: { message: 'Too many requests', context: [] } }, { 'Retry-After': '0' }), RateLimitError],
      ['an HttpClientError', new HttpClientError('connect ECONNREFUSED'), ConnectionError],
      ['a 400 invalid_grant', reply(400, Cloud.revoked), OAuthError],
      ['a 302', reply(302, undefined, { Location: 'https://elsewhere.example/' }), SirenError],
    ];

    for (const [label, answer, type] of failures) {
      const { http, oauth } = client([answer, success]);

      const error = await failure(call(oauth));

      expect(error, `${name} on ${label}`).toBeInstanceOf(type);
      expect(http.requests, `${name} on ${label}`).toHaveLength(1);
    }
  });
});

describe('P2: OAuthClient construction', () => {
  it.each([[null], [{}], [{ send: 'not a function' }]])('refuses httpClient %j with SirenError', (httpClient) => {
    expect(() => new OAuthClient({ httpClient: httpClient as never })).toThrow(SirenError);
  });

  it('sends through the global fetch when no httpClient is given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(Cloud.tokens), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await new OAuthClient().refresh(refreshParams);

    expect(tokens).toEqual(Cloud.tokens);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${BASE}/oauth/token`);
  });
});
