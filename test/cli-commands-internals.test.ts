import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { ACCESS_2, AuthAnswers, EMAIL, NOW_S, PASSWORD, REFRESH_1, harness, membershipAcme, session } from './cli-fakes';

/*
 * Guards of packet cli-session that the acceptance tests in
 * test/cli-commands.test.ts do not reach. Each case has a mutation in
 * scripts/mutations/apps-cli.json.
 */

const apps = () => reply(200, []);

describe('apps-cli internals: the session', () => {
  it('refuses a credentials file of another shape, and never overwrites it with a sign-in', async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.oneOrg()], { stdin: PASSWORD });
    mkdirSync(h.configDir, { mode: 0o700 });
    writeFileSync(h.credentialsPath, '{"version":2,"sessions":{}}', { mode: 0o600 });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(h.err()).toContain(h.credentialsPath);
    expect(h.credentialsText()).toBe('{"version":2,"sessions":{}}');
  });

  it('asks for --email and --password-stdin before sending when there is no terminal', async () => {
    for (const argv of [['login', '--password-stdin'], ['login', '--email', EMAIL], ['signup', '--email', EMAIL, '--password-stdin', '--accept-terms']]) {
      const h = harness([AuthAnswers.sandbox()], { stdin: PASSWORD });
      expect(await h.run(argv), argv.join(' ')).toBe(2);
      expect(h.http.requests).toHaveLength(0);
    }
  });

  it('keeps the session and says to try again when Siren cannot renew it, and names the plan when Siren refuses it', async () => {
    const down = harness([reply(500, { error: { message: 'Something went wrong.', context: [] } })]);
    down.signedIn({ [SANDBOX_BASE_URL]: session({ accessExpiresAt: NOW_S - 10 }) });
    expect(await down.run(['apps', 'list'])).toBe(1);
    expect(down.paths()).toEqual(['POST /auth/refresh']);
    expect(down.err()).toMatch(/try again/i);
    expect(down.err()).not.toContain('siren login');
    expect(down.credentials().sessions[SANDBOX_BASE_URL]?.refreshToken).toBe(REFRESH_1);

    const plan = harness([reply(401, { error: { message: 'Raw entitlement text.', code: 'trial_ended' } })]);
    plan.signedIn({ [SANDBOX_BASE_URL]: session({ accessExpiresAt: NOW_S - 10 }) });
    expect(await plan.run(['apps', 'list'])).toBe(1);
    expect(plan.err()).toMatch(/plan/i);
    expect(plan.err()).not.toContain('Raw entitlement text.');
  });

  it('says what to do about a plan when choosing among several organizations', async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.severalOrgs(), reply(401, { error: { message: 'Raw entitlement text.', code: 'trial_ended' } })], {
      stdin: PASSWORD,
    });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin', '--org', 'acme-two'])).toBe(1);
    expect(h.err()).toMatch(/plan/i);
    expect(h.err()).not.toContain('Raw entitlement text.');
  });

  it('refreshes once and asks again when a session route answers 401', async () => {
    const h = harness([reply(401, { error: { message: 'Invalid or expired token.', context: [] } }), AuthAnswers.tokens(), AuthAnswers.memberships()]);
    h.signedIn();
    expect(await h.run(['orgs']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /auth/memberships', 'POST /auth/refresh', 'GET /auth/memberships']);
    expect(h.http.bearers()[2]).toBe(`Bearer ${ACCESS_2}`);
  });

  it('refuses --org that names another organization than the only one, and keeps nothing', async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.oneOrg()], { stdin: PASSWORD });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin', '--org', 'acme-two'])).toBe(1);
    expect(h.err()).toContain(membershipAcme.orgSlug);
    expect(() => h.credentialsText()).toThrow();
  });

  it('sends the password with a line break at its end taken off, and nothing else of standard input changed', async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.oneOrg(), apps()], { stdin: ` ${PASSWORD} \r\n` });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests[1])).toEqual({ email: EMAIL, password: ` ${PASSWORD} ` });
  });
});
