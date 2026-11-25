import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io';
import { runCli } from '../src/cli/run';
import { HOOK_FRAMES } from '../src/cli/hook-frames';
import { SANDBOX_BASE_URL } from '../src/http';
import { appRecord } from './apps-siren-answers';
import { ACCESS_1, AuthAnswers, EMAIL, PASSWORD, REFRESH_1, harness, membershipAcme, session, user } from './cli-fakes';
import type { HarnessOptions } from './cli-fakes';
import { reply } from './http-fakes';
import { fakeScreen } from './cli-screen-fake';

/*
 * Password-free sign-in, Alex's ruling M105. Contract: contract/cli-signin.md
 * in the run folder. `siren login` in a terminal signs in by a code the
 * person approves in the browser (RFC 8628), and SIREN_TOKEN, a personal
 * access token, lets a script manage apps with no sign-in at all.
 */

const DEVICE_CODE = 'd'.repeat(64);
const USER_CODE = 'BCDF-GHJK';
const VERIFY = `https://app.example/cli?code=${USER_CODE}`;
const TOKEN = `siren_pat_${'9'.repeat(44)}9f3c`;

const Device = {
  code: (interval = 5) =>
    reply(200, { device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri: 'https://app.example/cli', verification_uri_complete: VERIFY, expires_in: 600, interval }),
  refused: (code: string, interval?: number) =>
    reply(400, { error: { message: `Siren says ${code}.`, code, context: interval === undefined ? {} : { interval } } }),
  approved: () => reply(200, { accessToken: ACCESS_1, refreshToken: REFRESH_1, user, memberships: [membershipAcme] }),
};

const tokenSelf = () =>
  reply(200, {
    id: 12,
    name: 'GitHub Actions deploy',
    scopes: ['apps:manage'],
    lastFour: '9f3c',
    createdAt: '2026-11-24T16:40:00+00:00',
    lastUsedAt: null,
    expiresAt: '2027-02-22T16:40:00+00:00',
    user: { id: 7, email: EMAIL, role: 'admin' },
    organization: { orgId: 3, orgName: 'Acme', orgSlug: 'acme' },
  });

const bodyOf = (h: ReturnType<typeof harness>, at: number) => JSON.parse(String(h.http.requests[at]?.body)) as Record<string, unknown>;
const bearerOf = (h: ReturnType<typeof harness>, at: number) => h.http.requests[at]?.headers?.Authorization;

describe('cli sign-in: login approves a code in the browser', () => {
  it('asks for a code, opens the page, waits the interval Siren sets, and keeps the session approval gives', async () => {
    const h = harness([Device.code(), Device.refused('authorization_pending', 5), Device.refused('slow_down', 10), Device.approved()], { interactive: true });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/cli/code', 'POST /auth/cli/token', 'POST /auth/cli/token', 'POST /auth/cli/token']);
    expect(bodyOf(h, 0)).toEqual({ machine: 'test-laptop' });
    expect(bodyOf(h, 1)).toEqual({ device_code: DEVICE_CODE });
    expect(h.opened).toEqual([VERIFY]);
    expect(h.slept).toEqual([5000, 5000, 10000]);
    expect(h.printed()).toContain(USER_CODE);
    expect(h.printed()).toContain(VERIFY);
    expect(h.printed()).not.toContain(DEVICE_CODE);
    expect(h.out()).toContain(`Logged in as ${EMAIL} · 1 organization\n`);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]?.accessToken).toBe(ACCESS_1);
    expect(h.secretPrompts).toEqual([]);
  });

  it('prints the page with no character that could move the cursor or recolor the terminal', async () => {
    const page = `https://app.example/cli?code=${USER_CODE}\u001b[2J`;
    const h = harness([reply(200, { ...JSON.parse(Device.code().body), verification_uri_complete: page }), Device.approved()], { interactive: true, opens: false });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.printed()).not.toContain('\u001b');
  });

  it('prints the page to open when the browser does not open', async () => {
    const h = harness([Device.code(), Device.approved()], { interactive: true, opens: false });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.err()).toContain('Open the link in your browser, and approve the code there.');
    expect(h.err()).toContain(`Link: ${VERIFY}`);
  });

  it.each([
    ['access_denied', 'The login was denied in the browser. Nothing was kept.'],
    ['expired_token', 'The code expired before anyone approved it. Run siren login again.'],
    ['invalid_grant', 'Siren no longer knows this code. Run siren login again.'],
  ])('stops on %s with one line, and keeps nothing', async (code, line) => {
    const h = harness([Device.code(), Device.refused(code)], { interactive: true });
    expect(await h.run(['login'])).toBe(1);
    expect(h.err()).toContain(line);
    expect(existsSync(h.credentialsPath)).toBe(false);
  });

  it('stops once the code has outlived its 10 minutes, without asking again', async () => {
    let now = 0;
    const h = harness([Device.code(), ...Array.from({ length: 200 }, () => Device.refused('authorization_pending', 5))], { interactive: true });
    const io: CliIo = { ...h.io, now: () => 1_000_000 + now, sleep: async (ms) => void (now += ms) };
    expect(await runCli(['login'], io)).toBe(1);
    expect(h.err()).toContain('The code expired before anyone approved it.');
    expect(h.paths().length).toBeLessThanOrEqual(122);
  });

  it('with no terminal and no password flag, sends nothing and names SIREN_TOKEN and --password-stdin', async () => {
    const h = harness([]);
    expect(await h.run(['login'])).toBe(2);
    expect(h.err()).toContain('SIREN_TOKEN');
    expect(h.err()).toContain('--password-stdin');
    expect(h.sent()).toEqual([]);
  });

  it('in CI, even with a terminal, sends nothing and says the same', async () => {
    const h = harness([], { interactive: true, env: { CI: 'true' } });
    expect(await h.run(['login'])).toBe(2);
    expect(h.err()).toContain('SIREN_TOKEN');
    expect(h.sent()).toEqual([]);
  });

  it('--password signs in with the email and a hidden password, as before', async () => {
    const h = harness([AuthAnswers.oneOrg()], { interactive: true, typed: [EMAIL], secrets: [PASSWORD] });
    expect(await h.run(['login', '--password']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/login']);
    expect(h.secretPrompts).toEqual(['Password: ']);
  });

  it('--password-stdin keeps working with no terminal', async () => {
    const h = harness([AuthAnswers.oneOrg()], { stdin: `${PASSWORD}\n` });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/login']);
  });

  it('takes --email only with --password or --password-stdin, so --email alone never picks the password path', async () => {
    const h = harness([], { interactive: true });
    expect(await h.run(['login', '--email', EMAIL])).toBe(2);
    expect(h.err()).toContain('--email goes with --password or --password-stdin.');
    expect(h.sent()).toEqual([]);
    expect(h.secretPrompts).toEqual([]);
  });

  it('shows the logo while it waits, and grips it the moment the approval lands', async () => {
    const h = harness([Device.code(), Device.refused('authorization_pending', 5), Device.approved()], {
      interactive: true,
      env: { COLORTERM: 'truecolor', TERM: 'xterm-256color' },
    });
    const fake = fakeScreen();
    const sentAtFirstFrame: number[] = [];
    const screen = { ...fake.screen, write: (text: string) => (sentAtFirstFrame.push(h.paths().length), fake.screen.write(text)) };
    expect(await runCli(['login'], { ...h.io, screen }), h.err()).toBe(0);
    // The logo and the code show as soon as Siren gives the code, and the halves grip once the approval lands.
    expect(sentAtFirstFrame[0]).toBe(1);
    expect(fake.text()).toContain(USER_CODE);
    expect(fake.text()).toContain(HOOK_FRAMES[HOOK_FRAMES.length - 1]?.[3]?.trim());
    expect(fake.text()).toContain(`Logged in as ${EMAIL} · 1 organization`);
    expect(existsSync(join(h.configDir, 'state.json'))).toBe(true);
  });

  it('keeps the animation still with --quiet, NO_COLOR or CI, as everywhere else', async () => {
    for (const [argv, env] of [
      [['login', '--quiet'], {}],
      [['login'], { NO_COLOR: '1' }],
    ] as Array<[string[], Record<string, string>]>) {
      const h = harness([Device.code(), Device.approved()], { interactive: true, env: { TERM: 'xterm-256color', ...env } });
      const fake = fakeScreen();
      expect(await runCli(argv, { ...h.io, screen: fake.screen }), h.err()).toBe(0);
      expect(fake.writes).toEqual([]);
    }
  });
});

describe('cli sign-in: SIREN_TOKEN lets a script manage apps with no sign-in', () => {
  const tokenHarness = (replies: Parameters<typeof harness>[0], options: HarnessOptions = {}) =>
    harness(replies, { ...options, env: { SIREN_TOKEN: TOKEN, ...(options.env ?? {}) } });

  it('sends the token as the bearer, and reads who it is once', async () => {
    const h = tokenHarness([tokenSelf(), reply(200, [appRecord()])]);
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /personal-tokens/current', 'GET /apps']);
    expect(bearerOf(h, 0)).toBe(`Bearer ${TOKEN}`);
    expect(bearerOf(h, 1)).toBe(`Bearer ${TOKEN}`);
    expect(h.printed()).not.toContain(TOKEN);
  });

  it('is read before credentials.json, and never writes it', async () => {
    const h = tokenHarness([tokenSelf(), reply(200, [appRecord()])]);
    h.signedIn();
    const before = h.credentialsText();
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(bearerOf(h, 1)).toBe(`Bearer ${TOKEN}`);
    expect(h.credentialsText()).toBe(before);
  });

  it('goes only to the Siren the command line or SIREN_BASE_URL names, never the one a past sign-in remembered', async () => {
    const h = tokenHarness([tokenSelf(), reply(200, [appRecord()])]);
    h.signedIn({ 'http://localhost:8080/siren/v1': session({ baseUrl: 'http://localhost:8080/siren/v1' }) });
    const file = h.credentials();
    file.current = 'http://localhost:8080/siren/v1';
    h.write('../config/credentials.json', JSON.stringify(file));
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.http.requests[0]?.url.startsWith(SANDBOX_BASE_URL)).toBe(true);
  });

  it('refuses a value that is no personal access token, before sending it, and never prints it', async () => {
    const h = harness([], { env: { SIREN_TOKEN: 'sk_live_not-a-token' } });
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.err()).toContain('SIREN_TOKEN');
    expect(h.err()).toContain('siren_pat_');
    expect(h.err()).not.toContain('sk_live_not-a-token');
    expect(h.paths()).toEqual([]);
  });

  it('says the token was revoked or expired on 401 invalid_token, and never tries to refresh it', async () => {
    const h = tokenHarness([reply(401, { error: { message: 'Invalid token.', code: 'invalid_token', context: {} } })]);
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.err()).toContain('SIREN_TOKEN was revoked or has expired.');
    expect(h.paths()).toEqual(['GET /personal-tokens/current']);
  });

  it('says plainly when a route takes no token, and names siren login', async () => {
    const h = tokenHarness([tokenSelf(), reply(403, { error: { message: 'A personal access token cannot use this route.', code: 'token_not_accepted', context: {} } })]);
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.err()).toContain('Siren takes no personal access token for this.');
    expect(h.err()).toContain('siren login');
  });

  it('refuses apps answer with only SIREN_TOKEN before sending anything, since answering by hand needs a signed-in session', async () => {
    const h = tokenHarness([]);
    expect(await h.run(['apps', 'answer', 'apr_9f2c4e0b7a1d4c3e8b6f5a2d1c0e9b8a', '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(h.err()).toContain('siren apps answer needs you to log in');
    expect(h.err()).toContain('siren login');
    expect(h.paths()).toEqual([]);
  });

  it('answers with the stored session when one is kept, though SIREN_TOKEN is set', async () => {
    const h = tokenHarness([reply(200, { requestKey: 'apr_9f2c4e0b7a1d4c3e8b6f5a2d1c0e9b8a', status: 'answered' })]);
    h.signedIn();
    await h.run(['apps', 'answer', 'apr_9f2c4e0b7a1d4c3e8b6f5a2d1c0e9b8a', '--body', '{"outcome":"paid"}']);
    expect(h.paths()[0]).toBe('POST /apps/requests/apr_9f2c4e0b7a1d4c3e8b6f5a2d1c0e9b8a/answer');
    expect(bearerOf(h, 0)).toBe(`Bearer ${ACCESS_1}`);
  });

  it('needs --live to change a live organization, as a session does', async () => {
    const h = tokenHarness([], { edition: 'production', env: { SIREN_BASE_URL: 'https://uat.example/siren/v1' } });
    h.write('siren.app.json', JSON.stringify({ version: 1, apps: { 'acme-payouts': { name: 'Acme' } } }));
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.err()).toContain('--live');
    expect(h.paths()).toEqual([]);
  });

  it('apply reads how many records use a dropped feature from the app, not from a feature route a token cannot reach', async () => {
    const held = appRecord({ features: [{ ...appRecord().features[0], uses: 0, openRequests: 0, usedBy: [] }, { ...appRecord().features[1], uses: 2, openRequests: 0, usedBy: [] }] });
    const h = tokenHarness([tokenSelf(), reply(200, held), reply(200, appRecord())]);
    h.write(
      'siren.app.json',
      JSON.stringify({ version: 1, apps: { 'acme-payouts': { name: 'Acme', description: "Siren's example app.", url: 'https://acme.example/siren', features: { 'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' } } } } }),
    );
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /personal-tokens/current', 'GET /apps/acme-payouts', 'PUT /apps/acme-payouts']);
    expect(h.out()).toMatch(/acme-ledger.*2 records/);
  });
});

describe('cli sign-in: whoami says which credential is in use', () => {
  it('names SIREN_TOKEN, the token by name and last four, and who it acts as', async () => {
    const h = harness([tokenSelf()], { env: { SIREN_TOKEN: TOKEN } });
    h.signedIn();
    expect(await h.run(['whoami']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /personal-tokens/current']);
    expect(h.out()).toContain(`Using SIREN_TOKEN "GitHub Actions deploy", ending 9f3c, as ${EMAIL} in Acme (acme), as admin.`);
    expect(h.out()).toContain('It expires 2027-02-22.');
    expect(h.printed()).not.toContain(TOKEN);
  });

  it('gives the source in --json', async () => {
    const token = harness([tokenSelf()], { env: { SIREN_TOKEN: TOKEN } });
    expect(await token.run(['whoami', '--json']), token.err()).toBe(0);
    expect(JSON.parse(token.out())).toMatchObject({ source: 'SIREN_TOKEN', email: EMAIL, org: { id: 3, name: 'Acme', slug: 'acme' }, token: { name: 'GitHub Actions deploy', lastFour: '9f3c' } });
    const stored = harness([]);
    stored.signedIn();
    expect(await stored.run(['whoami', '--json']), stored.err()).toBe(0);
    expect(JSON.parse(stored.out())).toMatchObject({ source: 'session' });
  });

  it('says the session file is in use when SIREN_TOKEN is not set', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['whoami']), h.err()).toBe(0);
    expect(h.out()).toContain('Signed in as');
    expect(h.paths()).toEqual([]);
  });

  it('login warns that SIREN_TOKEN still wins while it is set', async () => {
    const h = harness([AuthAnswers.oneOrg()], { stdin: `${PASSWORD}\n`, env: { SIREN_TOKEN: TOKEN } });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(h.err()).toContain('SIREN_TOKEN is set, so the other commands use it');
  });
});

describe("cli sign-in: the README's SIREN_TOKEN sample", () => {
  it('runs as printed, with a real token in place of siren_pat_...', async () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const line = readme.split('\n').find((text) => text.startsWith('SIREN_TOKEN=siren_pat_... '));
    expect(line).toBeDefined();
    const words = line!.split(' ');
    const env: Record<string, string> = { SIREN_APP_URL: 'https://acme.example/siren' };
    while (words[0]?.includes('=')) {
      const [name, value] = words.shift()!.split('=') as [string, string];
      env[name] = name === 'SIREN_TOKEN' ? TOKEN : value;
    }
    expect(words.shift()).toBe('siren');
    const h = harness([tokenSelf(), reply(200, appRecord()), reply(200, appRecord())], { edition: 'production', env });
    h.write('siren.app.json', JSON.stringify({ version: 1, apps: { 'acme-payouts': { name: 'Acme', url: '${SIREN_APP_URL}' } } }));
    expect(await h.run(words), h.err()).toBe(0);
    expect(h.http.requests[0]?.url.startsWith(env.SIREN_BASE_URL!)).toBe(true);
    expect(bearerOf(h, 0)).toBe(`Bearer ${TOKEN}`);
    expect(h.printed()).not.toContain(TOKEN);
  });
});
