import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, CLI_VERSION } from '../src/cli/run';
import { LIVE_BASE_URL } from '../src/cli/targets';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { BASE, bodyOf } from './record-fakes';
import {
  ACCESS_1,
  ACCESS_2,
  AuthAnswers,
  EMAIL,
  NOW_S,
  PASSWORD,
  REFRESH_1,
  REFRESH_2,
  harness,
  jwt,
  membershipAcme,
  session,
  user,
} from './cli-fakes';
import { APP_KEY, APP_REQUEST_ID, AppAnswers, ConfirmationAnswers, appRecord, requestRow } from './apps-siren-answers';

/*
 * Acceptance tests for the `siren` command, packets cli-session, cli-apply
 * and cli-requests. Contract: docs/architecture/apps-cli.md, "The commands",
 * "Signing in and the stored files" and "Sandbox and live".
 *
 * Every test runs `runCli` on a fake terminal (test/cli-fakes.ts): Siren's
 * answers come from a FakeHttpClient, files land in a temporary folder, and
 * the clock is fixed.
 */

const posix = process.platform !== 'win32';
const KEY = APP_KEY;
const REQUEST = APP_REQUEST_ID;
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const RAW_KEY_2 = `sk_test_${'1b'.repeat(32)}`;
const SIGNING_SECRET_2 = '9c'.repeat(32);
const appEnv = { SIREN_APP_URL: 'https://acme.example/siren' };
const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');

const app = appRecord({ apiKeyPrefix: RAW_KEY.slice(0, 16) });
const row = requestRow();

function bearer(h: ReturnType<typeof harness>, index: number): string | undefined {
  return h.http.bearers()[index];
}

describe('apps-cli: siren signup, login and the session', () => {
  it('signs up on the sandbox, sends the sign-up once, and keeps the session but never the password', async () => {
    const h = harness([AuthAnswers.registered()], { stdin: `${PASSWORD}\n` });
    const code = await h.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms']);

    expect(code, h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/register-org']);
    expect(h.editionReads[0]?.url.startsWith(SANDBOX_BASE_URL)).toBe(true);
    expect(bodyOf(h.http.requests[0])).toEqual({ orgName: 'Acme', email: EMAIL, password: PASSWORD, acceptTerms: true });
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({
      edition: 'sandbox',
      email: EMAIL,
      userId: 7,
      orgId: 3,
      orgName: 'Acme',
      role: 'admin',
      accessToken: ACCESS_1,
      refreshToken: REFRESH_1,
      accessExpiresAt: NOW_S + 3600,
    });
    expect(h.credentialsText()).not.toContain(PASSWORD);
    if (posix) {
      expect(h.modeOf(h.credentialsPath)).toBe(0o600);
      expect(h.modeOf(h.configDir)).toBe(0o700);
    }
    for (const secret of [PASSWORD, ACCESS_1, REFRESH_1]) expect(h.printed()).not.toContain(secret);
    expect(h.out()).toContain('Acme');
  });

  it('refuses sign-up without the terms accepted, before sending it', async () => {
    const h = harness([AuthAnswers.registered()], { stdin: PASSWORD });
    expect(await h.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin'])).not.toBe(0);
    expect(h.paths()).not.toContain('POST /auth/register-org');
  });

  it('refuses a live Siren without --live, before asking for the password', async () => {
    for (const edition of ['production', 'none'] as const) {
      for (const argv of [['login', '--email', EMAIL], ['signup', '--org-name', 'Acme', '--email', EMAIL, '--accept-terms']]) {
        const h = harness([], { edition, interactive: true, secrets: [PASSWORD], typed: ['y'] });
        expect(await h.run(argv)).toBe(1);
        expect(h.editionReads).toHaveLength(1);
        expect(h.paths()).toEqual([]);
        expect(h.secretPrompts).toEqual([]);
        expect(h.err()).toContain('--live');
      }
    }
  });

  it("says what to do when Siren asks for the address to be confirmed, or has sign-up turned off", async () => {
    const confirm = harness(
      [ConfirmationAnswers.registeredUnconfirmed(membershipAcme, user)],
      { stdin: PASSWORD },
    );
    expect(await confirm.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms']), confirm.err()).toBe(0);
    expect(confirm.out()).toMatch(/inbox/i);
    expect(confirm.out()).toContain('siren login');
    expect(confirm.printed()).not.toContain('confirm-token');
    expect(() => confirm.credentialsText()).toThrow();

    const pending = harness(
      [
        ConfirmationAnswers.registeredPending(membershipAcme, user, { accessToken: ACCESS_1, refreshToken: REFRESH_1 }, NOW_S),
      ],
      { stdin: PASSWORD },
    );
    expect(await pending.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms']), pending.err()).toBe(0);
    expect(pending.out()).toMatch(/confirm/i);
    expect(pending.out()).toContain('14 days');

    const pendingLogin = harness([ConfirmationAnswers.loginPending(membershipAcme, user, { accessToken: ACCESS_1, refreshToken: REFRESH_1 }, NOW_S)], {
      stdin: PASSWORD,
    });
    expect(await pendingLogin.run(['login', '--email', EMAIL, '--password-stdin']), pendingLogin.err()).toBe(0);
    expect(pendingLogin.out()).toContain('3 days');

    const closed = harness([ConfirmationAnswers.signupOff()], { stdin: PASSWORD });
    expect(await closed.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms'])).toBe(1);
    expect(closed.err()).toContain(`Sign-up is turned off on ${SANDBOX_BASE_URL}. Ask its owner, or use siren login.`);
    expect(closed.err()).not.toMatch(/not found/i);

    const unconfirmed = harness(
      [ConfirmationAnswers.loginUnconfirmed(EMAIL)],
      { stdin: PASSWORD },
    );
    expect(await unconfirmed.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(unconfirmed.err()).toMatch(/inbox/i);
    expect(unconfirmed.printed()).not.toContain('confirm-token');

    for (const code of ['no_entitlement', 'entitlement_lapsed', 'trial_ended', 'entitlements_unavailable'] as const) {
      const plan = harness([ConfirmationAnswers.loginNoPlan(code)], { stdin: PASSWORD });
      expect(await plan.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
      expect(plan.err(), code).not.toContain('Raw entitlement text.');
      expect(plan.err(), code).toMatch(code === 'entitlements_unavailable' ? /try again/i : /plan/i);
    }
  });

  it('logs in to a person with one organization and keeps its session', async () => {
    const h = harness([AuthAnswers.oneOrg()], { interactive: true, typed: [EMAIL], secrets: [PASSWORD] });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/login']);
    expect(bodyOf(h.http.requests[0])).toEqual({ email: EMAIL, password: PASSWORD });
    expect(h.secretPrompts).toHaveLength(1);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 3, orgName: 'Acme', refreshToken: REFRESH_1 });
    for (const secret of [PASSWORD, ACCESS_1, REFRESH_1]) expect(h.printed()).not.toContain(secret);
  });

  it('picks one of several organizations by slug or id, and keeps no verification token', async () => {
    for (const choice of ['acme-two', '4']) {
      const h = harness([AuthAnswers.severalOrgs(), AuthAnswers.tokens()], { stdin: PASSWORD });
      expect(await h.run(['login', '--email', EMAIL, '--password-stdin', '--org', choice]), h.err()).toBe(0);
      expect(h.paths()).toEqual(['POST /auth/login', 'POST /auth/select-org']);
      expect(bodyOf(h.http.requests[1])).toEqual({ verificationToken: 'verification-token', orgId: 4 });
      expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 4, orgName: 'Acme Two', accessToken: ACCESS_2 });
      expect(h.credentialsText()).not.toContain('verification-token');
    }

    const unchosen = harness([AuthAnswers.severalOrgs(), AuthAnswers.tokens()], { stdin: PASSWORD });
    expect(await unchosen.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(unchosen.paths()).not.toContain('POST /auth/select-org');
    expect(unchosen.err()).toContain('acme-two');
  });

  it("answers a wrong password with Siren's message and keeps nothing", async () => {
    const h = harness([AuthAnswers.wrongPassword()], { stdin: PASSWORD });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(h.err()).toContain("Invalid email or password. If you haven't set up your login yet, check your email for a link to set it up.");
    expect(h.printed()).not.toContain(PASSWORD);
    expect(() => h.credentialsText()).toThrow();
  });

  it('keeps --live for a live organization: refuses it on a sandbox, and requires it for a live session', async () => {
    const sandbox = harness([], { stdin: PASSWORD });
    expect(await sandbox.run(['login', '--live', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(sandbox.editionReads[0]?.url).toBe(`${LIVE_BASE_URL}/auth/signup-options`);
    expect(sandbox.paths()).toEqual([]);

    const live = harness([reply(200, [app])], { edition: 'production' });
    live.signedIn({ [BASE]: session({ edition: 'production' }) });
    expect(await live.run(['apps', 'list', '--base-url', BASE])).toBe(1);
    expect(live.http.requests).toHaveLength(0);
    expect(live.err()).toContain('--live');
    expect(await live.run(['apps', 'list', '--base-url', BASE, '--live']), live.err()).toBe(0);
    expect(live.paths()).toEqual(['GET /apps']);
  });

  it('chooses the sandbox unless told otherwise, and reads SIREN_BASE_URL', async () => {
    const plain = harness([reply(200, [app])]);
    plain.signedIn();
    expect(await plain.run(['apps', 'list']), plain.err()).toBe(0);
    expect(plain.http.requests[0]?.url).toBe(`${SANDBOX_BASE_URL}/apps`);

    const local = harness([reply(200, [app])], { env: { SIREN_BASE_URL: BASE } });
    local.signedIn({ [BASE]: session() });
    expect(await local.run(['apps', 'list']), local.err()).toBe(0);
    expect(local.http.requests[0]?.url).toBe(`${BASE}/apps`);
  });

  it('answers exit code 2 for a command line it cannot read, and sends nothing', async () => {
    for (const argv of [
      ['--sandbox', '--live', 'apps', 'list'],
      ['apps', 'list', '--sandbox', '--base-url', BASE],
      ['apps', 'frobnicate'],
      ['apps', 'list', '--colour'],
      ['apps', 'show'],
      ['deploy'],
      ['apps', 'list', '--base-url', 'http://siren.example/siren/v1'],
      ['login', '--email', EMAIL, '--password-stdin', '--base-url', 'http://10.0.0.5/siren/v1'],
    ]) {
      const h = harness([reply(200, [app])], { stdin: PASSWORD });
      h.signedIn();
      expect(await h.run(argv), argv.join(' ')).toBe(2);
      expect(h.http.requests).toHaveLength(0);
      expect(h.err()).not.toBe('');
    }

    const fromEnv = harness([], { stdin: PASSWORD, env: { SIREN_BASE_URL: 'http://siren.example/siren/v1' } });
    expect(await fromEnv.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(2);
    expect(fromEnv.http.requests).toHaveLength(0);
  });

  it('takes plain http only for a Cloud on this machine', async () => {
    for (const base of ['http://localhost:33918/siren/v1', 'http://127.0.0.1:33918/siren/v1', 'http://host.docker.internal:33918/siren/v1']) {
      const h = harness([reply(200, [app])]);
      h.signedIn({ [base]: session() });
      expect(await h.run(['apps', 'list', '--base-url', base]), h.err()).toBe(0);
      expect(h.http.requests[0]?.url).toBe(`${base}/apps`);
    }
  });

  it('says to sign in, and sends nothing, when there is no session', async () => {
    const h = harness([reply(200, [app])]);
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('siren login');
  });

  it('refreshes an access token that has run out before sending, and keeps the new pair', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [app])]);
    const spent = jwt({ type: 'access', userId: 7, orgId: 3, role: 'admin', exp: NOW_S - 10 });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ accessToken: spent, accessExpiresAt: NOW_S - 10 }) });
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/refresh', 'GET /apps']);
    expect(bodyOf(h.http.requests[0])).toEqual({ refreshToken: REFRESH_1 });
    expect(bearer(h, 1)).toBe(`Bearer ${ACCESS_2}`);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ accessToken: ACCESS_2, refreshToken: REFRESH_2 });
  });

  it('refreshes once after a 401, and says to sign in again when the refresh is refused', async () => {
    const h = harness([reply(401, { error: { message: 'Authentication required.', context: [] } }), AuthAnswers.tokens(), reply(200, [app])]);
    h.signedIn();
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps', 'POST /auth/refresh', 'GET /apps']);

    const refused = harness([AuthAnswers.refreshRefused()]);
    refused.signedIn({ [SANDBOX_BASE_URL]: session({ accessExpiresAt: NOW_S - 10 }) });
    expect(await refused.run(['apps', 'list'])).toBe(1);
    expect(refused.paths()).toEqual(['POST /auth/refresh']);
    expect(refused.err()).toContain('siren login');
  });

  it.skipIf(!posix)('refuses a credentials file that anyone but its owner can read', async () => {
    const h = harness([reply(200, [app])]);
    h.signedIn();
    chmodSync(h.credentialsPath, 0o644);
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('chmod 600');
    expect(h.err()).toContain(h.credentialsPath);
    expect(h.modeOf(h.credentialsPath)).toBe(0o644);
  });

  it('logs out by revoking both tokens, and forgets only this Siren', async () => {
    const h = harness([AuthAnswers.loggedOut()]);
    h.signedIn({ [SANDBOX_BASE_URL]: session(), [BASE]: session({ orgName: 'Local' }) });
    expect(await h.run(['logout']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/logout']);
    expect(bearer(h, 0)).toBe(`Bearer ${ACCESS_1}`);
    expect(bodyOf(h.http.requests[0])).toEqual({ refreshToken: REFRESH_1 });
    expect(Object.keys(h.credentials().sessions)).toEqual([BASE]);

    const live = harness([AuthAnswers.loggedOut()], { edition: 'production' });
    live.signedIn({ [BASE]: session({ edition: 'production' }) });
    expect(await live.run(['logout', '--base-url', BASE]), live.err()).toBe(0);
    expect(live.paths()).toEqual(['POST /auth/logout']);
    expect(live.credentials().sessions).toEqual({});
  });

  it('lists the organizations and switches to another', async () => {
    const list = harness([AuthAnswers.memberships()]);
    list.signedIn();
    expect(await list.run(['orgs']), list.err()).toBe(0);
    expect(list.paths()).toEqual(['GET /auth/memberships']);
    expect(list.out()).toMatch(/\*.*acme\b/);
    expect(list.out()).toContain('acme-two');

    const use = harness([AuthAnswers.memberships(), AuthAnswers.tokens()]);
    use.signedIn();
    expect(await use.run(['use', 'acme-two']), use.err()).toBe(0);
    expect(use.paths()).toEqual(['GET /auth/memberships', 'POST /auth/switch-org']);
    expect(bodyOf(use.http.requests[1])).toEqual({ orgId: 4 });
    expect(use.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 4, orgName: 'Acme Two', accessToken: ACCESS_2 });
  });

  it('lists every command for --help and prints the version for --version', async () => {
    const help = harness([]);
    expect(await help.run(['--help'])).toBe(0);
    for (const command of COMMANDS) expect(help.out()).toContain(command);

    const version = harness([]);
    expect(await version.run(['--version'])).toBe(0);
    expect(version.out().trim()).toBe(CLI_VERSION);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});

describe('apps-cli: siren apps init, apply and the app key', () => {
  it('writes an app file and keeps env files out of git, and never overwrites one', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'init', '--key', KEY, '--name', 'Acme']), h.err()).toBe(0);
    expect(h.file('siren.app.json')).toContain(`"${KEY}"`);
    expect(h.file('.gitignore').split('\n')).toContain('.env.*');
    expect(h.http.requests).toHaveLength(0);

    h.write('siren.app.json', '{"mine": true}');
    expect(await h.run(['apps', 'init', '--key', KEY, '--name', 'Acme'])).toBe(1);
    expect(h.file('siren.app.json')).toBe('{"mine": true}');
  });

  it('declares the app on the first apply, writes its key and secret to .env.sandbox, and prints neither', async () => {
    const h = harness([reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);

    expect(h.paths()).toEqual([`PUT /apps/${KEY}`]);
    expect(bearer(h, 0)).toBe(`Bearer ${ACCESS_1}`);
    expect(bodyOf(h.http.requests[0])).toMatchObject({ name: 'Acme', url: 'https://acme.example/siren' });
    expect(h.file('.env.sandbox').split('\n')).toEqual(
      expect.arrayContaining([`SIREN_BASE_URL=${SANDBOX_BASE_URL}`, `SIREN_API_KEY=${RAW_KEY}`, `SIREN_SIGNING_SECRET=${SIGNING_SECRET}`]),
    );
    if (posix) expect(h.modeOf(join(h.cwd, '.env.sandbox'))).toBe(0o600);
    expect(h.printed()).not.toContain(RAW_KEY);
    expect(h.printed()).not.toContain(SIGNING_SECRET);
    expect(h.out()).toContain(RAW_KEY.slice(0, 16));
    expect(h.out()).toContain('.env.sandbox');
    expect(h.out()).toContain('app:12');
    expect(h.out()).toContain('SIREN_APP_URL');
    expect(h.printed()).not.toContain(appEnv.SIREN_APP_URL);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]?.envFiles).toEqual({ [KEY]: join(h.cwd, '.env.sandbox') });
  });

  it('says once, before sending, that a Siren in a container cannot reach an app on localhost, and names host.docker.internal', async () => {
    const NOTE =
      "siren: The app's url is on this machine's own address, which a Siren running in a container cannot reach. " +
      'Use host.docker.internal in its place, and see "Running against your own Siren Cloud" in the README.\n';
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787/siren', 'http://localhost']) {
      const h = harness([reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: { SIREN_APP_URL: url } });
      h.signedIn();
      h.write('siren.app.json', exampleFile);
      expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
      expect(h.err(), url).toBe(NOTE);
      expect(h.printed(), url).not.toContain(url);
    }
    for (const url of ['https://acme.example/siren', 'http://host.docker.internal:8787', 'https://localhost.acme.example']) {
      const h = harness([reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: { SIREN_APP_URL: url } });
      h.signedIn();
      h.write('siren.app.json', exampleFile);
      expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
      expect(h.err(), url).toBe('');
    }
  });

  it('leaves the env file as it is when a later apply answers no secret, and says when this machine holds no key', async () => {
    const h = harness([reply(200, app), reply(200, app)], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    h.write('.env.sandbox', `PORT=8787\nSIREN_API_KEY=${RAW_KEY}\n`);
    expect(await h.run(['apps', 'apply', 'siren.app.json']), h.err()).toBe(0);
    expect(h.paths()).toEqual([`PUT /apps/${KEY}`]);
    expect(h.file('.env.sandbox')).toBe(`PORT=8787\nSIREN_API_KEY=${RAW_KEY}\n`);
    expect(h.printed()).not.toContain('siren apps rotate');

    h.write('.env.sandbox', 'PORT=8787\n');
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.paths()).toEqual([`PUT /apps/${KEY}`, `PUT /apps/${KEY}`]);
    expect(h.file('.env.sandbox')).toBe('PORT=8787\n');
    expect(h.printed()).toContain(`siren apps rotate ${KEY}`);
  });

  it('prints each problem in the app file with its line, and sends nothing', async () => {
    const h = harness([reply(200, app)]);
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('SIREN_APP_URL');
    expect(h.err()).toMatch(/siren\.app\.json:9\b/);
  });

  // The orchestrator's ruling in the slice 8 fix round (AP-A904): Siren issues an app's key and
  // secret once, so a declare that succeeds while the env file cannot be written loses the pair.
  // apply checks the env path before sending, and this case expects the refusal with nothing sent.
  it('refuses before sending when the env file cannot be written as a regular file, and prints no key', async () => {
    const h = harness([reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    mkdirSync(join(h.cwd, '.env.sandbox'));
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toMatch(/not a regular file/);
    expect(h.printed()).not.toContain(RAW_KEY);
    expect(h.printed()).not.toContain(SIGNING_SECRET);
  });

  it('rotates the key into the env file apply wrote, replacing only its three lines, never in the working folder', async () => {
    const h = harness([reply(200, { ...app, rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 })]);
    const envFile = join(h.cwd, 'acme', '.env.sandbox');
    mkdirSync(join(h.cwd, 'acme'));
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [KEY]: envFile } }) });
    h.write('acme/.env.sandbox', `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    expect(await h.run(['apps', 'rotate', KEY]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`POST /apps/${KEY}/rotate`]);
    expect(h.file('acme/.env.sandbox')).toBe(
      `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY_2}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET_2}\n`,
    );
    expect(() => h.file('.env.sandbox')).toThrow();
    expect(h.out()).toContain(envFile);
    expect(h.printed()).not.toContain(RAW_KEY_2);
    expect(h.printed()).not.toContain(SIGNING_SECRET_2);
  });

  // The orchestrator's ruling after the fix round's re-review (AP-A906): rotate stops before sending
  // when the env file holds another Siren's key, as apply does, where it used to replace that key.
  it('refuses to rotate before sending when it does not know where the key lives, or when the env file holds another Siren\'s key', async () => {
    const unknown = harness([reply(200, { ...app, rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 })]);
    unknown.signedIn();
    expect(await unknown.run(['apps', 'rotate', KEY])).toBe(1);
    expect(unknown.http.requests).toHaveLength(0);
    expect(unknown.err()).toContain('--app-file');

    const held = `SIREN_BASE_URL=http://localhost:33918/siren/v1\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`;
    const other = harness([reply(200, { ...app, rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 })]);
    other.signedIn();
    other.write('siren.app.json', exampleFile);
    other.write('.env.sandbox', held);
    expect(await other.run(['apps', 'rotate', KEY, '--app-file', 'siren.app.json'])).toBe(1);
    expect(other.http.requests).toHaveLength(0);
    expect(other.file('.env.sandbox')).toBe(held);
    expect(other.err()).toContain('http://localhost:33918/siren/v1');

    const named = harness([reply(200, { ...app, rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 })]);
    named.signedIn();
    named.write('siren.app.json', exampleFile);
    named.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    expect(await named.run(['apps', 'rotate', KEY, '--app-file', 'siren.app.json']), named.err()).toBe(0);
    expect(named.file('.env.sandbox')).toContain(`SIREN_API_KEY=${RAW_KEY_2}`);
    expect(named.credentials().sessions[SANDBOX_BASE_URL]?.envFiles).toEqual({ [KEY]: join(named.cwd, '.env.sandbox') });
  });

  it('turns an app on and off, lists the apps and shows one', async () => {
    const h = harness([
      reply(200, { ...app, status: 'inactive' }),
      reply(200, app),
      reply(200, [app]),
      reply(200, app),
      reply(200, [app]),
    ]);
    h.signedIn();
    expect(await h.run(['apps', 'off', KEY]), h.err()).toBe(0);
    expect(await h.run(['apps', 'on', KEY]), h.err()).toBe(0);
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    const before = h.out().length;
    expect(await h.run(['apps', 'list', '--json']), h.err()).toBe(0);

    expect(h.paths()).toEqual([`POST /apps/${KEY}/status`, `POST /apps/${KEY}/status`, 'GET /apps', `GET /apps/${KEY}`, 'GET /apps']);
    expect(bodyOf(h.http.requests[0])).toEqual({ status: 'inactive' });
    expect(bodyOf(h.http.requests[1])).toEqual({ status: 'active' });
    expect(h.out()).toContain(KEY);
    expect(h.out()).toContain('app:11');
    expect(JSON.parse(h.out().slice(before))).toEqual([app]);
  });

  it('deletes only with --yes, and explains an app that records still use', async () => {
    const h = harness([
      reply(200, { success: true }),
      AppAnswers.inUse(),
      reply(200, app),
    ]);
    h.signedIn();
    expect(await h.run(['apps', 'delete', KEY])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('--yes');

    expect(await h.run(['apps', 'delete', KEY, '--yes']), h.err()).toBe(0);
    expect(await h.run(['apps', 'delete', KEY, '--yes'])).toBe(1);
    expect(h.paths()).toEqual([`DELETE /apps/${KEY}`, `DELETE /apps/${KEY}`, `GET /apps/${KEY}`]);
    expect(h.err()).toContain('app:12');
    expect(h.err()).toContain('siren apps off');

    const asking = harness([AppAnswers.inUseWithOpenAsks(2)]);
    asking.signedIn();
    expect(await asking.run(['apps', 'delete', KEY, '--yes'])).toBe(1);
    expect(asking.err()).toContain(`siren apps requests --app ${KEY}`);
    expect(asking.err()).not.toContain('siren apps off');
  });
});

describe('apps-cli: siren apps requests, answer and resend', () => {
  it('lists the latest requests, for one app or those that need attention', async () => {
    const other = { ...row, id: 'apr_0123456789abcdef0123456789abcdef', appId: 9, status: 'delivered' };
    const h = harness([
      reply(200, { requests: [row, other] }),
      reply(200, { requests: [row, other] }),
      reply(200, app),
      reply(200, { requests: [] }),
    ]);
    h.signedIn();
    expect(await h.run(['apps', 'requests']), h.err()).toBe(0);
    expect(h.out()).toContain(REQUEST);
    expect(h.out()).toContain(other.id);

    const before = h.out().length;
    expect(await h.run(['apps', 'requests', '--app', KEY]), h.err()).toBe(0);
    expect(h.out().slice(before)).toContain(REQUEST);
    expect(h.out().slice(before)).not.toContain(other.id);

    expect(await h.run(['apps', 'requests', '--attention']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps/requests', 'GET /apps/requests', `GET /apps/${KEY}`, 'GET /apps/requests']);
    expect(new URL(h.http.requests[3]!.url).searchParams.get('status')).toBe('needs_attention');
  });

  it('shows one request: the data Siren sent, each send, and what the app answered', async () => {
    const delivery = (eventId: string, httpStatusCode: number, responseBody: string) => ({
      id: httpStatusCode,
      webhookSubscriptionId: 31,
      eventType: 'app.request',
      eventId,
      payload: { version: 1, id: eventId.split('.')[0], data: { payoutId: 88, amount: 2500, currency: 'USD' } },
      status: httpStatusCode === 200 ? 'delivered' : 'failed',
      attemptCount: 1,
      httpStatusCode,
      responseBody,
      errorMessage: null,
      nextRetryAt: null,
      deliveredAt: null,
      dateCreated: '2026-11-17 09:14:03',
      dateModified: '2026-11-17 09:14:04',
    });
    const h = harness([
      reply(200, { ...row, sendCount: 2, data: { payoutId: 88, amount: 2500, currency: 'USD' }, answer: null, answeredByUser: null }),
      reply(200, [app]),
      reply(200, [
        delivery(`${REQUEST}.1`, 500, 'upstream timeout'),
        delivery(`${REQUEST}.2`, 200, '{"received":true}'),
        delivery('apr_0123456789abcdef0123456789abcdef.1', 200, 'someone else'),
      ]),
    ]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', REQUEST]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`GET /apps/requests/${REQUEST}`, 'GET /apps', 'GET /webhooks/31/deliveries']);
    expect(h.out()).toContain(`${REQUEST}.1`);
    expect(h.out()).toContain('upstream timeout');
    expect(h.out()).toContain('{"received":true}');
    expect(h.out()).toContain('"payoutId": 88');
    expect(h.out()).not.toContain('someone else');
  });

  it('follows the requests, printing each change once, until Ctrl-C', async () => {
    const h = harness(
      [reply(200, { requests: [row] }), reply(200, { requests: [row] }), reply(200, { requests: [{ ...row, status: 'delivered' }] })],
      { onSleep: (count, abort) => count === 3 && abort() },
    );
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--follow']), h.err()).toBe(0);
    expect(h.http.requests).toHaveLength(3);
    const lines = h.out().split('\n').filter((line) => line.includes(REQUEST));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('sent');
    expect(lines[1]).toContain('delivered');
  });

  it('posts an answer with the session, from --body or --file, and says when Siren already had it', async () => {
    const h = harness([reply(200, { status: 'accepted' }), reply(200, { status: 'accepted', duplicate: true })]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', REQUEST, '--body', '{"outcome":"paid","reference":"acme-88"}']), h.err()).toBe(0);
    h.write('answer.json', '{"outcome":"paid","reference":"acme-88"}');
    expect(await h.run(['apps', 'answer', REQUEST, '--file', 'answer.json']), h.err()).toBe(0);

    expect(h.paths()).toEqual([`POST /apps/requests/${REQUEST}/answer`, `POST /apps/requests/${REQUEST}/answer`]);
    expect(bearer(h, 0)).toBe(`Bearer ${ACCESS_1}`);
    expect(bodyOf(h.http.requests[1])).toEqual({ outcome: 'paid', reference: 'acme-88' });
    expect(h.out()).toMatch(/accepted/i);
    expect(h.out()).toMatch(/already/i);
  });

  it("refuses an answer it cannot read before sending, and prints Siren's refusal", async () => {
    for (const argv of [
      ['apps', 'answer', REQUEST, '--body', '{outcome: paid}'],
      ['apps', 'answer', REQUEST, '--body', '["paid"]'],
      ['apps', 'answer', REQUEST],
      ['apps', 'answer', 'apr_1', '--json', '{"outcome":"paid"}'],
    ]) {
      const h = harness([reply(200, { status: 'accepted' })]);
      h.signedIn();
      expect(await h.run(argv), argv.join(' ')).not.toBe(0);
      expect(h.http.requests).toHaveLength(0);
    }

    const late = harness([AppAnswers.alreadyAnswered()]);
    late.signedIn();
    expect(await late.run(['apps', 'answer', REQUEST, '--body', '{"outcome":"failed"}'])).toBe(1);
    expect(late.err()).toContain('This request already has a different answer, and the first answer stands.');
  });

  it("says a person may answer only a request that needs attention, and where to see those, when Siren refuses a hand answer", async () => {
    const early = harness([AppAnswers.notNeedingAttention()]);
    early.signedIn();
    expect(await early.run(['apps', 'answer', REQUEST, '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(early.paths()).toEqual([`POST /apps/requests/${REQUEST}/answer`]);
    expect(early.err()).toBe(
      'siren: A person may answer only a request that needs attention. The app may still answer this one. ' +
        'See the requests that need attention with siren apps requests --attention.\n',
    );
  });

  it("prints Siren's message and its code for a refusal whose code the SDK does not know, and exits 1", async () => {
    const h = harness([AppAnswers.unknownRefusal()]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', REQUEST, '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(h.err()).toBe("siren: Siren refused this answer for a reason this SDK does not know. Siren's code: made_up_refusal_code.\n");
  });

  it('sends a request again', async () => {
    const h = harness([reply(200, { ...row, sendCount: 2 })]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', REQUEST]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`POST /apps/requests/${REQUEST}/resend`]);
    expect(h.out()).toContain(REQUEST);
  });
});
