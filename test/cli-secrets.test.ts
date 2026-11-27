import { describe, expect, it } from 'vitest';
import { SirenError } from '../src/errors';
import { HttpClientError, SANDBOX_BASE_URL } from '../src/http';
import { SessionAuthClient } from '../src/cli/session-auth';
import { FakeHttpClient, reply } from './http-fakes';
import { ACCESS_1, AuthAnswers, EMAIL, PASSWORD, REFRESH_1, harness } from './cli-fakes';

/*
 * The session client's promise that no error carries a password or a token
 * (src/cli/session-auth.ts, `redact` and `scrub`). Each case reads the whole
 * error, its message, its data and its stack, and what the command prints.
 */

const MADE_TOKEN = 'confirm-token-made-by-siren';

/** The error a call rejects with. */
async function failureOf(call: Promise<unknown>): Promise<SirenError> {
  try {
    await call;
  } catch (error) {
    return error as SirenError;
  }
  throw new Error('the call did not fail');
}

/** Everything an error shows: its message, its data and its stack. */
function shown(error: SirenError): string {
  return `${error.message}\n${JSON.stringify(error.data ?? null)}\n${error.stack ?? ''}`;
}

function client(replies: Array<ReturnType<typeof reply> | Error>) {
  const http = new FakeHttpClient(replies);
  return { http, auth: new SessionAuthClient({ baseUrl: SANDBOX_BASE_URL, httpClient: http }) };
}

describe('apps-cli internals: no secret in an error', () => {
  it('keeps a password Siren echoes back out of the error and out of what the command prints', async () => {
    const echo = () =>
      reply(400, { error: { message: `Bad input ${PASSWORD}`, code: 'invalid', context: { password: PASSWORD, note: `you sent ${PASSWORD}` } } }, {}, `Bad ${PASSWORD}`);
    const { auth } = client([echo()]);
    const login = await failureOf(auth.login(EMAIL, PASSWORD));
    expect(login.message).toContain('[redacted]');
    expect(shown(login)).not.toContain(PASSWORD);

    const signup = await failureOf(client([echo()]).auth.registerOrg({ orgName: 'Acme', email: EMAIL, password: PASSWORD, acceptTerms: true }));
    expect(shown(signup)).not.toContain(PASSWORD);

    const h = harness([echo()], { stdin: PASSWORD });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(h.printed()).toContain('[redacted]');
    expect(h.printed()).not.toContain(PASSWORD);
  });

  it('keeps a token out of a refused answer, in the message and in every token field of its data', async () => {
    const refused = await failureOf(
      client([
        reply(401, {
          error: {
            message: `Refresh token ${REFRESH_1} is spent.`,
            code: 'refresh_refused',
            context: { refreshToken: REFRESH_1, confirmation_token: MADE_TOKEN, nested: { accessToken: ACCESS_1 } },
          },
        }),
      ]).auth.refresh(REFRESH_1),
    );
    expect(refused.message).toContain('[redacted]');
    for (const secret of [REFRESH_1, MADE_TOKEN, ACCESS_1]) expect(shown(refused)).not.toContain(secret);

    const unconfirmed = await failureOf(
      client([
        reply(403, {
          error: { message: 'Confirm your email address first.', code: 'email_unconfirmed', email: EMAIL, confirmationToken: MADE_TOKEN, context: { confirmationToken: MADE_TOKEN } },
        }),
      ]).auth.login(EMAIL, PASSWORD),
    );
    expect(unconfirmed.code).toBe('email_unconfirmed');
    expect(shown(unconfirmed)).not.toContain(MADE_TOKEN);
  });

  it('keeps a password and a bearer token out of an error the transport throws', async () => {
    const login = await failureOf(client([new HttpClientError(`socket hang up while sending {"password":"${PASSWORD}"}`)]).auth.login(EMAIL, PASSWORD));
    expect(login.name).toBe('ConnectionError');
    expect(shown(login)).not.toContain(PASSWORD);

    const logout = await failureOf(client([new HttpClientError(`socket hang up after Authorization: Bearer ${ACCESS_1}`)]).auth.logout(ACCESS_1, REFRESH_1));
    expect(shown(logout)).not.toContain(ACCESS_1);

    const refresh = await failureOf(client([new HttpClientError(`reset while sending ${REFRESH_1}`)]).auth.refresh(REFRESH_1));
    expect(shown(refresh)).not.toContain(REFRESH_1);
  });
});
