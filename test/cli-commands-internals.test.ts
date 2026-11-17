import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { LIVE_BASE_URL } from '../src/cli/targets';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { ACCESS_2, AuthAnswers, EMAIL, NOW_S, PASSWORD, REFRESH_1, harness, membershipAcme, session } from './cli-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord } from './apps-siren-answers';

/*
 * Guards of packet cli-session that the acceptance tests in
 * test/cli-commands.test.ts do not reach. Each case has a mutation in
 * scripts/mutations/apps-cli.json.
 */

const apps = () => reply(200, []);

describe('apps-cli internals: the session', () => {
  it('refuses a credentials file of another shape, and never overwrites it with a sign-in', async () => {
    const h = harness([AuthAnswers.oneOrg()], { stdin: PASSWORD });
    mkdirSync(h.configDir, { mode: 0o700 });
    writeFileSync(h.credentialsPath, '{"version":2,"sessions":{}}', { mode: 0o600 });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(h.err()).toContain(h.credentialsPath);
    expect(h.credentialsText()).toBe('{"version":2,"sessions":{}}');
  });

  it('asks for --email and --password-stdin before sending when there is no terminal', async () => {
    for (const argv of [['login', '--password-stdin'], ['login', '--email', EMAIL], ['signup', '--email', EMAIL, '--password-stdin', '--accept-terms']]) {
      const h = harness([], { stdin: PASSWORD });
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

    const unavailable = harness([AuthAnswers.refreshUnavailable()]);
    unavailable.signedIn({ [SANDBOX_BASE_URL]: session({ accessExpiresAt: NOW_S - 10 }) });
    expect(await unavailable.run(['apps', 'list'])).toBe(1);
    expect(unavailable.err()).toMatch(/try again/i);
    expect(unavailable.err()).not.toContain('siren login');
    expect(unavailable.credentials().sessions[SANDBOX_BASE_URL]?.refreshToken).toBe(REFRESH_1);

    const plan = harness([reply(401, { error: { message: 'Raw entitlement text.', code: 'trial_ended' } })]);
    plan.signedIn({ [SANDBOX_BASE_URL]: session({ accessExpiresAt: NOW_S - 10 }) });
    expect(await plan.run(['apps', 'list'])).toBe(1);
    expect(plan.err()).toMatch(/plan/i);
    expect(plan.err()).not.toContain('Raw entitlement text.');
  });

  it('says what to do about a plan when choosing among several organizations', async () => {
    const h = harness([AuthAnswers.severalOrgs(), reply(401, { error: { message: 'Raw entitlement text.', code: 'trial_ended' } })], {
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
    const h = harness([AuthAnswers.oneOrg()], { stdin: PASSWORD });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin', '--org', 'acme-two'])).toBe(1);
    expect(h.err()).toContain(membershipAcme.orgSlug);
    expect(() => h.credentialsText()).toThrow();
  });

  it('sends the password with a line break at its end taken off, and nothing else of standard input changed', async () => {
    const h = harness([AuthAnswers.oneOrg(), apps()], { stdin: ` ${PASSWORD} \r\n` });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests[0])).toEqual({ email: EMAIL, password: ` ${PASSWORD} ` });
  });
});

describe('apps-cli internals: apply and the app key', () => {
  it('refuses an app key Siren would refuse, and writes nothing', async () => {
    for (const key of ['Acme', 'requests', 'acme--payouts']) {
      const h = harness([]);
      expect(await h.run(['apps', 'init', '--key', key]), key).toBe(2);
      expect(() => h.file('siren.app.json')).toThrow();
    }
  });

  it('refuses --app-file that names no file, before sending', async () => {
    const h = harness([reply(200, { ...appRecord(), rawKey: `sk_test_${'1b'.repeat(32)}`, signingSecret: '9c'.repeat(32) })]);
    h.signedIn();
    expect(await h.run(['apps', 'rotate-key', APP_KEY, '--yes', '--app-file', 'missing/siren.app.json'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
  });

  it('refuses --app-file that names no file in a folder that exists, before sending', async () => {
    const h = harness([reply(200, { ...appRecord(), rawKey: `sk_test_${'1b'.repeat(32)}`, signingSecret: '9c'.repeat(32) })]);
    h.signedIn();
    expect(await h.run(['apps', 'rotate-key', APP_KEY, '--yes', '--app-file', 'siren.app.json'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('There is no app file');
  });

  it('deletes in a terminal only when the key is typed', async () => {
    const wrong = harness([reply(200, { success: true })], { interactive: true, typed: ['acme'] });
    wrong.signedIn();
    expect(await wrong.run(['apps', 'delete', APP_KEY])).toBe(1);
    expect(wrong.http.requests).toHaveLength(0);

    const typed = harness([reply(200, { success: true })], { interactive: true, typed: [APP_KEY] });
    typed.signedIn();
    expect(await typed.run(['apps', 'delete', APP_KEY]), typed.err()).toBe(0);
    expect(typed.paths()).toEqual([`DELETE /apps/${APP_KEY}`]);
  });
});

describe('apps-cli internals: requests', () => {
  it('refuses a request id it cannot read, or one given with list options, before sending', async () => {
    for (const argv of [['apps', 'requests', 'apr_1'], ['apps', 'requests', APP_REQUEST_ID, '--follow']]) {
      const h = harness([reply(200, { requests: [] })]);
      h.signedIn();
      expect(await h.run(argv), argv.join(' ')).toBe(2);
      expect(h.http.requests).toHaveLength(0);
    }
  });

  it('refuses an answer given both as --body and --file, before sending', async () => {
    const h = harness([reply(200, { status: 'accepted' })]);
    h.signedIn();
    h.write('answer.json', '{"outcome":"paid"}');
    expect(await h.run(['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}', '--file', 'answer.json'])).toBe(2);
    expect(h.http.requests).toHaveLength(0);
  });
});

describe('apps-cli internals: the stored files before a secret is sent', () => {
  it('refuses a credentials file others can read before the password leaves the machine', async () => {
    for (const argv of [
      ['login', '--email', EMAIL, '--password-stdin'],
      ['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms'],
    ]) {
      const h = harness([AuthAnswers.oneOrg()], { stdin: PASSWORD });
      h.signedIn();
      chmodSync(h.credentialsPath, 0o644);
      expect(await h.run(argv), argv[0]).toBe(1);
      expect(h.http.requests, argv[0]).toHaveLength(0);
      expect(h.err()).toContain('chmod 600');
    }
  });

  it('stops rotate before sending when the env file holds the key of another Siren or the live target', async () => {
    for (const other of ['http://localhost:33918/siren/v1', LIVE_BASE_URL]) {
      const held = `SIREN_BASE_URL=${other}\nSIREN_API_KEY=sk_test_${'0a'.repeat(32)}\nSIREN_SIGNING_SECRET=${'ef'.repeat(32)}\n`;
      const h = harness([reply(200, { ...appRecord(), rawKey: `sk_test_${'1b'.repeat(32)}`, signingSecret: '9c'.repeat(32) })]);
      h.signedIn();
      h.write('siren.app.json', '{}');
      h.write('.env.sandbox', held);
      expect(await h.run(['apps', 'rotate-key', APP_KEY, '--yes', '--app-file', 'siren.app.json']), other).toBe(1);
      expect(h.http.requests, other).toHaveLength(0);
      expect(h.err()).toContain(other);
      expect(h.err()).toContain(SANDBOX_BASE_URL);
      expect(h.file('.env.sandbox')).toBe(held);
    }
  });

  it('stops a later apply before sending when the env file holds the key of another Siren', async () => {
    const appEnv = { SIREN_APP_URL: 'https://acme.example/siren' };
    const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
    for (const other of ['http://localhost:33918/siren/v1', LIVE_BASE_URL]) {
      const held = `SIREN_BASE_URL=${other}\nSIREN_API_KEY=sk_test_${'0a'.repeat(32)}\nSIREN_SIGNING_SECRET=${'ef'.repeat(32)}\n`;
      const h = harness([reply(200, appRecord())], { env: appEnv });
      h.signedIn();
      h.write('siren.app.json', exampleFile);
      h.write('.env.sandbox', held);
      expect(await h.run(['apps', 'apply']), other).toBe(1);
      expect(h.http.requests, other).toHaveLength(0);
      expect(h.err()).toContain(other);
      expect(h.err()).toContain(SANDBOX_BASE_URL);
      expect(h.err()).toMatch(/siren apps apply/);
      expect(h.file('.env.sandbox')).toBe(held);
    }
  });
});
