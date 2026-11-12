import { describe, expect, it } from 'vitest';
import { ApiError, BadRequestError, RateLimitError } from '../src/index';
import { OAuthClient, OAuthError } from '../src/connect/index';
import type { HttpResponse } from '../src/http';
import { shown } from './error-text';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Unit tests for the scrub on OAuthClient's error answers, added by the
 * slice 5 review. The class comment says no error it builds carries a
 * secret the call sent, or a token from Cloud's answer, in any field. The
 * acceptance suite proves that for a lost connection. These rows prove it
 * for an answer that quotes a secret back: an OAuth envelope, the app's
 * error envelope, a 429, a 5xx with a status text, and a 5xx body that
 * carries token fields. Every row's answer holds the secret, so each
 * absence assertion could fail.
 */

const REDIRECT = 'https://store.example/siren/callback';
const REFRESH = 'rt_QSECRETREFRESHQ_0001';
const ATTEMPT = 'att_QSECRETATTEMPTQ_0002';
const CODE = 'code_QSECRETCODEQ_0003';
const VERIFIER = 'v'.repeat(20) + 'QSECRETVERIFIERQ' + 'w'.repeat(20);

function oauthAnswering(answer: HttpResponse) {
  const http = new FakeHttpClient([answer]);
  return { http, oauth: new OAuthClient({ httpClient: http }) };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

function refreshFailing(answer: HttpResponse): Promise<Error> {
  const { oauth } = oauthAnswering(answer);
  return failure(oauth.refresh({ clientId: 'sc_1', refreshToken: REFRESH, attemptId: ATTEMPT }));
}

function exchangeFailing(answer: HttpResponse): Promise<Error> {
  const { oauth } = oauthAnswering(answer);
  return failure(oauth.exchangeCode({ clientId: 'sc_1', code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT }));
}

describe('OAuthClient review fix: errors built from an answer that quotes a secret', () => {
  it('removes the refresh token and attemptId from an OAuth error_description, and keeps the code and status', async () => {
    const error = await refreshFailing(
      reply(400, { error: 'invalid_grant', error_description: `Refresh token ${REFRESH} (attempt ${ATTEMPT}) was revoked.` }),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(error.message).toBe('Refresh token [redacted] (attempt [redacted]) was revoked.');
    expect((error as OAuthError).code).toBe('invalid_grant');
    expect((error as OAuthError).statusCode).toBe(400);
    expect(shown(error)).not.toContain(REFRESH);
    expect(shown(error)).not.toContain(ATTEMPT);
  });

  it('removes the authorization code from an OAuth error code that quotes it', async () => {
    const error = await exchangeFailing(reply(401, { error: `invalid_grant:${CODE}` }));

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe('invalid_grant:[redacted]');
    expect(shown(error)).not.toContain(CODE);
  });

  it("removes the verifier from the app's error envelope, in the message and in data", async () => {
    const error = await exchangeFailing(
      reply(400, { error: { message: `Verifier ${VERIFIER} does not match.`, data: { verifier: VERIFIER } } }),
    );

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error.message).toBe('Verifier [redacted] does not match.');
    expect(shown(error)).not.toContain(VERIFIER);
  });

  it('removes the attemptId from a list in a 429 and keeps its Retry-After', async () => {
    const error = await refreshFailing(
      reply(429, { error: { message: 'slow down', data: { attempts: [ATTEMPT] } } }, { 'Retry-After': '7' }),
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(7);
    expect(shown(error)).not.toContain(ATTEMPT);
  });

  it('removes the refresh token from the status text of a 5xx with no JSON body', async () => {
    const error = await refreshFailing({ status: 502, headers: {}, body: '<html>bad gateway</html>', statusText: `Bad Gateway ${REFRESH}` });

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Bad Gateway [redacted]');
    expect(shown(error)).not.toContain(REFRESH);
  });

  it("replaces the value of each token field in a failed answer's data", async () => {
    const error = await refreshFailing(
      reply(500, {
        error: {
          message: 'rotation failed',
          data: { issued: { access_token: 'at_QNEWACCESSQ_9', refresh_token: 'rt_QNEWREFRESHQ_9', id_token: 'id_QNEWIDQ_9' } },
        },
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).data).toEqual({
      issued: { access_token: '[redacted]', refresh_token: '[redacted]', id_token: '[redacted]' },
    });
    expect(shown(error)).not.toMatch(/QNEW/);
  });

  it('removes a secret used as a key in the data of a failed answer', async () => {
    const error = await refreshFailing(reply(400, { error: { message: 'refresh failed', data: { attempts: { [ATTEMPT]: 'failed' } } } }));

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).data).toEqual({ attempts: { '[redacted]': 'failed' } });
    expect(shown(error)).not.toContain(ATTEMPT);
  });

  it('replaces token fields named in camel case too', async () => {
    const error = await refreshFailing(
      reply(503, { error: { message: 'down', data: { refreshToken: 'rt_QNEWREFRESHQ_8', accessToken: 'at_QNEWACCESSQ_8', 'id-token': 'id_QNEWIDQ_8' } } }),
    );

    expect((error as ApiError).data).toEqual({ refreshToken: '[redacted]', accessToken: '[redacted]', 'id-token': '[redacted]' });
    expect(shown(error)).not.toMatch(/QNEW/);
  });

  it('keeps a __proto__ key in the data as an own field, not a prototype', async () => {
    const error = await refreshFailing({
      status: 500,
      headers: {},
      body: `{"error":{"message":"odd","data":{"__proto__":{"note":"${ATTEMPT}"}}}}`,
    });

    const data = (error as ApiError).data as Record<string, unknown>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
    expect(shown(error)).not.toContain(ATTEMPT);
  });

  it('raises the usual SirenError for an answer nested far deeper than any real one, with the deep part replaced', async () => {
    const depth = 100_000;
    const error = await refreshFailing({
      status: 500,
      headers: {},
      body: `{"error":{"message":"deep","data":${'['.repeat(depth)}"${ATTEMPT}"${']'.repeat(depth)}}}`,
    });

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('deep');
    expect(JSON.stringify((error as ApiError).data)).toContain('[redacted]');
    expect(JSON.stringify((error as ApiError).data)).not.toContain(ATTEMPT);
  });

  it('leaves an answer that quotes no secret as Cloud sent it', async () => {
    const error = await refreshFailing(
      reply(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid, expired or revoked.' }),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(error.message).toBe('The refresh token is invalid, expired or revoked.');
    expect((error as OAuthError).code).toBe('invalid_grant');
  });
});
