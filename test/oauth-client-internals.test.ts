import { describe, expect, it } from 'vitest';
import { BadRequestError, ConnectionError, HttpClientError, RateLimitError, UnexpectedResponseError } from '../src/index';
import { OAuthClient, OAuthError } from '../src/connect/index';
import type { HttpResponse } from '../src/http';
import { shown } from './error-text';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Unit tests for the OAuthClient internals the P2 acceptance tests do not
 * pin: the secret scrub on secrets that hold regex characters or each
 * other, the scrub on a call that sent no secret, the reading of an OAuth
 * envelope whose fields are empty, the token fields a 2xx must fill, the
 * consent screen URL that already carries a query, and the Retry-After
 * lookup in any case.
 */

const REDIRECT = 'https://store.example/siren/callback';
const TOKENS = {
  access_token: 'at-1',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'connect:*',
  refresh_token: 'rt-2',
};

function oauthAnswering(answer: HttpResponse | Error, options: { consentScreenUrl?: string } = {}) {
  const http = new FakeHttpClient([answer]);
  return { http, oauth: new OAuthClient({ httpClient: http, ...options }) };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

describe('OAuthClient internals: the secret scrub', () => {
  it('removes a secret that starts with another whole, longest first', async () => {
    const refreshToken = 'rt-INNER-tail9';
    const attemptId = 'rt-INNER';
    const { oauth } = oauthAnswering(new HttpClientError(`timed out sending ${refreshToken} as ${attemptId}`));

    const error = await failure(oauth.refresh({ clientId: 'sc_1', refreshToken, attemptId }));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain('timed out sending [redacted] as [redacted]');
    expect(error.message).not.toContain('tail9');
  });

  it('removes a secret that holds regex characters, every time it appears', async () => {
    const refreshToken = 'rt.+*?^$(x)[y]{2}|\\z';
    const { oauth } = oauthAnswering(new HttpClientError(`first ${refreshToken} then ${refreshToken}`));

    const error = await failure(oauth.refresh({ clientId: 'sc_1', refreshToken }));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain('first [redacted] then [redacted]');
    expect(shown(error)).not.toContain('(x)[y]');
  });

  it("keeps the client error's message whole when the call sent no secret", async () => {
    const { oauth } = oauthAnswering(new HttpClientError('connect ECONNREFUSED 127.0.0.1:443'));

    const error = await failure(oauth.register({ clientName: 'Example Store', redirectUris: [REDIRECT] }));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain('connect ECONNREFUSED 127.0.0.1:443');
    expect(error.message).not.toContain('[redacted]');
  });
});

describe('OAuthClient internals: reading the answer', () => {
  it('reads a 400 whose error is an empty string through errorFromResponse, not as OAuthError', async () => {
    const { oauth } = oauthAnswering(reply(400, { error: '', error_description: 'Something failed.' }));

    const error = await failure(oauth.refresh({ clientId: 'sc_1', refreshToken: 'rt-1' }));

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).not.toBeInstanceOf(OAuthError);
  });

  it('falls back to the code when error_description is an empty string', async () => {
    const { oauth } = oauthAnswering(reply(400, { error: 'invalid_grant', error_description: '' }));

    const error = await failure(oauth.refresh({ clientId: 'sc_1', refreshToken: 'rt-1' }));

    expect(error).toBeInstanceOf(OAuthError);
    expect(error.message).toBe('invalid_grant');
  });

  it.each([
    ['an empty access_token', { ...TOKENS, access_token: '' }],
    ['a refresh_token that is not text', { ...TOKENS, refresh_token: 42 }],
  ])('raises UnexpectedResponseError for a 2xx token body with %s', async (_name, body) => {
    const { oauth } = oauthAnswering(reply(200, body));

    const error = await failure(oauth.refresh({ clientId: 'sc_1', refreshToken: 'rt-1' }));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
  });

  it.each([['retry-after'], ['RETRY-AFTER']])('reads a 429 header named %s for retryAfter', async (name) => {
    const { oauth } = oauthAnswering(reply(429, { error: { message: 'Too many requests', context: [] } }, { [name]: '7' }));

    const error = await failure(oauth.refresh({ clientId: 'sc_1', refreshToken: 'rt-1' }));

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(7);
  });
});

describe('OAuthClient internals: the consent screen URL', () => {
  it('adds its query after one the consentScreenUrl already carries', () => {
    const { oauth } = oauthAnswering(reply(200, TOKENS), { consentScreenUrl: 'http://localhost:5173/connect-site?lang=en' });

    const url = new URL(
      oauth.authorizeUrl({
        clientId: 'sc_1',
        redirectUri: REDIRECT,
        state: 'state-1',
        codeChallenge: 'qK5ubukpq-o6_PxSWMjM1vhSc-DUYm0mxyefMlD3fI4',
      }),
    );

    expect([...url.searchParams.keys()]).toEqual([
      'lang',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'state',
      'scope',
    ]);
  });
});
