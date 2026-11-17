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
  session,
} from './cli-fakes';

/*
 * Acceptance tests for the `siren` command, packets cli-session, cli-apply
 * and cli-requests. Contract: docs/architecture/apps-cli.md, "The commands",
 * "Signing in and the stored files" and "Sandbox and live".
 *
 * Every test runs `runCli` on a fake terminal (test/cli-fakes.ts): Siren's
 * answers come from a FakeHttpClient, files land in a temporary folder, and
 * the clock is fixed.
 *
 * Pending: each packet turns its `describe.skip` into `describe`.
 */

const posix = process.platform !== 'win32';
const KEY = 'acme-payouts';
const REQUEST = 'apr_b79943ff8ca353ce5cf5312bb3fa66c7';
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const RAW_KEY_2 = `sk_test_${'1b'.repeat(32)}`;
const SIGNING_SECRET_2 = '9c'.repeat(32);
const appEnv = { ACME_SIREN_URL: 'https://acme.example/siren' };
const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');

const app = {
  id: 4,
  key: KEY,
  name: 'Acme',
  description: "Siren's example app.",
  status: 'active',
  webhookSubscriptionId: 31,
  apiKeyId: 52,
  url: 'https://acme.example/siren',
  events: [],
  scopes: [],
  apiKeyPrefix: RAW_KEY.slice(0, 16),
  items: [
    { id: 11, ref: 'app:11', appId: 4, kind: 'postConversionAction', key: 'notify-crm', name: 'Tell the CRM', description: '', settings: {}, status: 'active' },
    { id: 12, ref: 'app:12', appId: 4, kind: 'fulfillmentMethod', key: 'acme-ledger', name: 'Acme ledger', description: '', settings: { currencies: ['USD'], answerWindowMinutes: 4320 }, status: 'active' },
  ],
};
const row = {
  id: REQUEST,
  appId: 4,
  item: 'app:12',
  kind: 'fulfillmentMethod',
  mode: 'ask',
  subject: { type: 'payout', id: '88' },
  status: 'sent',
  sendCount: 1,
  answerBy: '2026-11-18T09:14:03+00:00',
  answeredBy: null,
  answeredAt: null,
  lastError: null,
  createdAt: '2026-11-17T09:14:03+00:00',
};

function bearer(h: ReturnType<typeof harness>, index: number): string | undefined {
  return h.http.bearers()[index];
}

describe.skip('apps-cli: siren signup, login and the session', () => {
  it('signs up on the sandbox, sends the sign-up once, and keeps the session but never the password', async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.registered()], { stdin: `${PASSWORD}\n` });
    const code = await h.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms']);

    expect(code, h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /auth/signup-options', 'POST /auth/register-org']);
    expect(h.http.requests[0]?.url.startsWith(SANDBOX_BASE_URL)).toBe(true);
    expect(bodyOf(h.http.requests[1])).toEqual({ orgName: 'Acme', email: EMAIL, password: PASSWORD, acceptTerms: true });
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
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.registered()], { stdin: PASSWORD });
    expect(await h.run(['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin'])).not.toBe(0);
    expect(h.paths()).not.toContain('POST /auth/register-org');
  });

  it('refuses a live Siren without --live, before asking for the password', async () => {
    for (const answer of [AuthAnswers.production, AuthAnswers.noEdition]) {
      for (const argv of [['login', '--email', EMAIL], ['signup', '--org-name', 'Acme', '--email', EMAIL, '--accept-terms']]) {
        const h = harness([answer()], { interactive: true, secrets: [PASSWORD], typed: ['y'] });
        expect(await h.run(argv)).toBe(1);
        expect(h.paths()).toEqual(['GET /auth/signup-options']);
        expect(h.secretPrompts).toEqual([]);
        expect(h.err()).toContain('--live');
      }
    }
  });

  it('logs in to a person with one organization and keeps its session', async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.oneOrg()], { interactive: true, typed: [EMAIL], secrets: [PASSWORD] });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /auth/signup-options', 'POST /auth/login']);
    expect(bodyOf(h.http.requests[1])).toEqual({ email: EMAIL, password: PASSWORD });
    expect(h.secretPrompts).toHaveLength(1);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 3, orgName: 'Acme', refreshToken: REFRESH_1 });
    for (const secret of [PASSWORD, ACCESS_1, REFRESH_1]) expect(h.printed()).not.toContain(secret);
  });

  it('picks one of several organizations by slug or id, and keeps no verification token', async () => {
    for (const choice of ['acme-two', '4']) {
      const h = harness([AuthAnswers.sandbox(), AuthAnswers.severalOrgs(), AuthAnswers.tokens()], { stdin: PASSWORD });
      expect(await h.run(['login', '--email', EMAIL, '--password-stdin', '--org', choice]), h.err()).toBe(0);
      expect(h.paths()).toEqual(['GET /auth/signup-options', 'POST /auth/login', 'POST /auth/select-org']);
      expect(bodyOf(h.http.requests[2])).toEqual({ verificationToken: 'verification-token', orgId: 4 });
      expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 4, orgName: 'Acme Two', accessToken: ACCESS_2 });
      expect(h.credentialsText()).not.toContain('verification-token');
    }

    const unchosen = harness([AuthAnswers.sandbox(), AuthAnswers.severalOrgs(), AuthAnswers.tokens()], { stdin: PASSWORD });
    expect(await unchosen.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(unchosen.paths()).not.toContain('POST /auth/select-org');
    expect(unchosen.err()).toContain('acme-two');
  });

  it("answers a wrong password with Siren's message and keeps nothing", async () => {
    const h = harness([AuthAnswers.sandbox(), AuthAnswers.wrongPassword()], { stdin: PASSWORD });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(h.err()).toContain('Those details do not match an account.');
    expect(h.printed()).not.toContain(PASSWORD);
    expect(() => h.credentialsText()).toThrow();
  });

  it('keeps --live for a live organization: refuses it on a sandbox, and requires it for a live session', async () => {
    const sandbox = harness([AuthAnswers.sandbox()], { stdin: PASSWORD });
    expect(await sandbox.run(['login', '--live', '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(sandbox.http.requests[0]?.url).toBe(`${LIVE_BASE_URL}/auth/signup-options`);
    expect(sandbox.paths()).toEqual(['GET /auth/signup-options']);

    const live = harness([reply(200, [app])]);
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
    ]) {
      const h = harness([reply(200, [app])]);
      h.signedIn();
      expect(await h.run(argv), argv.join(' ')).toBe(2);
      expect(h.http.requests).toHaveLength(0);
      expect(h.err()).not.toBe('');
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

describe.skip('apps-cli: siren apps init, apply and the app key', () => {
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
  });

  it('leaves the env file as it is when a later apply answers no secret', async () => {
    const h = harness([reply(200, app)], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    h.write('.env.sandbox', 'PORT=8787\n');
    expect(await h.run(['apps', 'apply', 'siren.app.json']), h.err()).toBe(0);
    expect(h.file('.env.sandbox')).toBe('PORT=8787\n');
  });

  it('prints each problem in the app file with its line, and sends nothing', async () => {
    const h = harness([reply(200, app)]);
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('ACME_SIREN_URL');
    expect(h.err()).toMatch(/siren\.app\.json:9\b/);
  });

  it('prints the key and secret once, on standard error, when the env file cannot be written', async () => {
    const h = harness([reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    mkdirSync(join(h.cwd, '.env.sandbox'));
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.out()).not.toContain(RAW_KEY);
    expect(h.err().split(RAW_KEY)).toHaveLength(2);
    expect(h.err().split(SIGNING_SECRET)).toHaveLength(2);
  });

  it('rotates the key and replaces only its three lines in the env file', async () => {
    const h = harness([reply(200, { ...app, rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 })]);
    h.signedIn();
    h.write('.env.sandbox', `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    expect(await h.run(['apps', 'rotate', KEY]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`POST /apps/${KEY}/rotate`]);
    expect(h.file('.env.sandbox')).toBe(
      `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY_2}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET_2}\n`,
    );
    expect(h.printed()).not.toContain(RAW_KEY_2);
    expect(h.printed()).not.toContain(SIGNING_SECRET_2);
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
      reply(409, {
        error: {
          message: 'Records still select items of "Acme", so it can\'t be deleted. Turn it off instead.',
          context: { reason: 'app_in_use', uses: { 'app:12': 2 } },
        },
      }),
    ]);
    h.signedIn();
    expect(await h.run(['apps', 'delete', KEY])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('--yes');

    expect(await h.run(['apps', 'delete', KEY, '--yes']), h.err()).toBe(0);
    expect(await h.run(['apps', 'delete', KEY, '--yes'])).toBe(1);
    expect(h.paths()).toEqual([`DELETE /apps/${KEY}`, `DELETE /apps/${KEY}`]);
    expect(h.err()).toContain('app:12');
    expect(h.err()).toContain('siren apps off');
  });
});

describe.skip('apps-cli: siren apps requests, answer and resend', () => {
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

  it('shows one request: each send, what the app answered, and the body Siren sent', async () => {
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
      reply(200, { requests: [{ ...row, sendCount: 2 }] }),
      reply(200, [app]),
      reply(200, [
        delivery(`${REQUEST}.1`, 500, 'upstream timeout'),
        delivery(`${REQUEST}.2`, 200, '{"received":true}'),
        delivery('apr_0123456789abcdef0123456789abcdef.1', 200, 'someone else'),
      ]),
    ]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', REQUEST]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps/requests', 'GET /apps', 'GET /webhooks/31/deliveries']);
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

    const late = harness([reply(409, { error: { code: 'app_request_already_answered', message: 'This request already has a different answer.' } })]);
    late.signedIn();
    expect(await late.run(['apps', 'answer', REQUEST, '--body', '{"outcome":"failed"}'])).toBe(1);
    expect(late.err()).toContain('This request already has a different answer.');
  });

  it('sends a request again', async () => {
    const h = harness([reply(200, { ...row, sendCount: 2 })]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', REQUEST]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`POST /apps/requests/${REQUEST}/resend`]);
    expect(h.out()).toContain(REQUEST);
  });
});
