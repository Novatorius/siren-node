import { existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CliIo, CliScreen } from '../src/cli/io';
import { runCli } from '../src/cli/run';
import { clean } from '../src/cli/style';
import { ACCESS_1, AuthAnswers, REFRESH_1, harness, membershipAcme, membershipTwo, session, user } from './cli-fakes';
import { reply } from './http-fakes';
import { SANDBOX_BASE_URL } from '../src/http';

/*
 * The security review of the CLI sign-in at fe1a545 (five should-fix
 * items, 2026-11-25). The reviewer's red probes are in the run folder,
 * review/cli-signin-cli-security-probes/. These tests carry them over.
 */

const DEVICE_CODE = 'd'.repeat(64);
const USER_CODE = 'BCDF-GHJK';
const PAGE = `https://app.sirenaffiliates.com/cli?code=${USER_CODE}`;
const code = (over: Record<string, unknown> = {}) =>
  reply(200, { device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri: 'https://app.sirenaffiliates.com/cli', verification_uri_complete: PAGE, expires_in: 600, interval: 5, ...over });
const refused = (c: string, interval?: number) => reply(400, { error: { message: `Siren says ${c}.`, code: c, context: interval === undefined ? {} : { interval } } });
const approved = (over: Record<string, unknown> = {}) => reply(200, { accessToken: ACCESS_1, refreshToken: REFRESH_1, user, memberships: [membershipAcme], ...over });

describe('security 1: the approval page', () => {
  it('opens no plain-http page on a host that is not this machine, and stops before polling', async () => {
    const h = harness([code({ verification_uri_complete: `http://evil.example/cli?code=${USER_CODE}` }), approved()], { interactive: true });
    expect(await h.run(['login'])).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.paths()).toEqual(['POST /auth/cli/code']);
    expect(h.err()).toContain('http://evil.example');
    expect(h.err()).toContain('not https');
  });

  it('opens a plain-http page on this machine, as the API takes plain http there', async () => {
    const h = harness([code({ verification_uri_complete: `http://127.0.0.1:34142/cli?code=${USER_CODE}` }), approved()], {
      interactive: true,
      env: { SIREN_BASE_URL: 'http://127.0.0.1:34142/siren/v1' },
    });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.opened).toEqual([`http://127.0.0.1:34142/cli?code=${USER_CODE}`]);
  });

  it('refuses a page on another host than the API, unless it is Siren Cloud dashboard for a Siren Cloud API', async () => {
    const phish = harness([code({ verification_uri_complete: `https://phish.example/cli?code=${USER_CODE}` }), approved()], { interactive: true });
    expect(await phish.run(['login'])).toBe(1);
    expect(phish.opened).toEqual([]);
    expect(phish.paths()).toEqual(['POST /auth/cli/code']);
    expect(phish.err()).toContain('phish.example');
    expect(phish.err()).toContain('sandbox.sirenaffiliates.com');

    const cloud = harness([code(), approved()], { interactive: true });
    expect(await cloud.run(['login']), cloud.err()).toBe(0);
    expect(cloud.opened).toEqual([PAGE]);

    const selfHosted = harness([code({ verification_uri_complete: `https://app.sirenaffiliates.com/cli?code=${USER_CODE}` })], {
      interactive: true,
      env: { SIREN_BASE_URL: 'https://siren.acme.example/siren/v1' },
    });
    expect(await selfHosted.run(['login'])).toBe(1);
    expect(selfHosted.opened).toEqual([]);
  });

  it('names the Siren it polls beside the code, plain and on the logo screen', async () => {
    const h = harness([code(), approved()], { interactive: true });
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.err()).toContain('Siren: sandbox.sirenaffiliates.com');
  });
});

describe('security 2: the poll has a limit of its own', () => {
  it('stops within 15 minutes when Siren names a code life of 30 years and never answers', async () => {
    let now = 0;
    const h = harness([code({ expires_in: 1e9 }), ...Array.from({ length: 400 }, () => refused('authorization_pending', 5))], { interactive: true });
    const io: CliIo = {
      ...h.io,
      now: () => 1_000_000 + now,
      sleep: async (ms) => {
        now += ms;
        if (now > 60 * 60 * 1000) throw new Error('test guard: still polling after one hour');
      },
    };
    expect(await runCli(['login'], io)).toBe(1);
    expect(h.err()).not.toContain('test guard');
    expect(h.err()).toContain('The code expired before anyone approved it.');
    expect(now).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe('security 3: the config folder', () => {
  it('tightens a config folder that already exists with mode 0755 to 0700', async () => {
    if (process.platform === 'win32') return;
    const h = harness([code(), approved()], { interactive: true });
    mkdirSync(h.configDir, { mode: 0o755 });
    chmodSync(h.configDir, 0o755);
    expect(await h.run(['login']), h.err()).toBe(0);
    expect(h.modeOf(h.credentialsPath)).toBe(0o600);
    expect(statSync(h.configDir).mode & 0o777).toBe(0o700);
  });
});

describe('security 4: Ctrl-C under the logo wins over an approval in flight', () => {
  it('keeps nothing and exits non-zero when Ctrl-C came while the approving poll was on the wire', async () => {
    let onKey: ((key: string) => void) | null = null;
    const screen: CliScreen = {
      size: { columns: 120, rows: 40 },
      platform: 'linux',
      write: () => undefined,
      wait: async () => undefined,
      every: () => () => undefined,
      listen: (callback) => {
        onKey = callback;
        return () => {
          onKey = null;
        };
      },
      atExit: () => () => undefined,
    };
    const h = harness([], { interactive: true, env: { COLORTERM: 'truecolor', TERM: 'xterm-256color' } });
    const answers = [code(), approved()];
    const io: CliIo = {
      ...h.io,
      screen,
      httpClient: {
        send: async (request) => {
          if (request.url.endsWith('/auth/signup-options')) return AuthAnswers.sandbox();
          const answer = answers.shift()!;
          if (request.url.endsWith('/auth/cli/token')) onKey?.('\u0003');
          return answer;
        },
      },
    };
    const exit = await runCli(['login'], io);
    expect(exit, `${h.err()} | ${onKey === null}`).not.toBe(0);
    expect(existsSync(h.credentialsPath)).toBe(false);
    expect(h.err()).toContain('Stopped waiting for approval');
  });
});

describe('security 5: text from Siren prints with no control character', () => {
  const hostile = '\u001b]8;;https://evil.example\u0007Acme\u001b[2J\u009b31m\u0000';

  it('clean() drops escape sequences and control characters, and keeps the words', () => {
    expect(clean(hostile)).toBe('Acme');
    expect(clean('Acme Outdoors · 3')).toBe('Acme Outdoors · 3');
    expect(clean('tab\there\nnewline')).toBe('tabherenewline');
  });

  it('login, orgs, whoami and the organization question print none of it', async () => {
    const bad = { ...membershipAcme, orgName: hostile };
    const login = harness([code(), approved({ user: { ...user, email: `dev\u001b[31m@acme.example` }, memberships: [bad, { ...membershipTwo, orgName: hostile }] })], { interactive: true });
    expect(await login.run(['login']), login.err()).toBe(0);
    for (const h of [login]) expect(h.printed()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);

    const orgs = harness([reply(200, { memberships: [bad, membershipTwo] })]);
    orgs.signedIn({ [SANDBOX_BASE_URL]: session({ orgName: hostile, email: `dev\u001b[31m@acme.example` }) });
    expect(await orgs.run(['orgs']), orgs.err()).toBe(0);
    expect(await orgs.run(['whoami']), orgs.err()).toBe(0);
    expect(orgs.printed()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);

    const asked = harness([], { interactive: true, typed: ['nope'] });
    asked.signedIn({ [SANDBOX_BASE_URL]: session({ memberships: [{ ...bad, role: 'admin' }, { orgId: 4, orgName: hostile, orgSlug: 'acme-two', role: 'admin' }] }) });
    await asked.run(['apps', 'list']);
    expect(asked.printed()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
});
