import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { HOOK_FRAMES } from '../src/cli/hook-frames';
import { ACCESS_1, EMAIL, REFRESH_1, harness, membershipAcme, membershipTwo, user } from './cli-fakes';
import { reply } from './http-fakes';
import { fakeScreen } from './cli-screen-fake';
import type { FakeScreenOptions } from './cli-screen-fake';

/*
 * The login screen (Alex, 2026-11-24): "the login screen while we login can
 * absolutely show the siren logo." While `siren login` waits for approval
 * in the browser, the logo's two halves float apart on the left, with the
 * wordmark, the code, the link and a spinner on the right. The halves grip
 * the moment the approval lands, and "✓ Logged in as …" takes the spinner's
 * place. On deny or expiry they drift away and the ✗ line follows. Every
 * skip rule of the logo animation holds, and without it the tool prints
 * plain lines.
 */

const USER_CODE = 'BCDF-GHJK';
const LINK = `http://127.0.0.1:34142/cli?code=${USER_CODE}`;
const code = () =>
  reply(200, { device_code: 'd'.repeat(64), user_code: USER_CODE, verification_uri: 'http://127.0.0.1:34142/cli', verification_uri_complete: LINK, expires_in: 600, interval: 1 });
const pending = () => reply(400, { error: { message: 'Pending.', code: 'authorization_pending', context: { interval: 1 } } });
const approved = () => reply(200, { accessToken: ACCESS_1, refreshToken: REFRESH_1, user, memberships: [membershipAcme, membershipTwo] });
const denied = () => reply(400, { error: { message: 'Denied.', code: 'access_denied', context: {} } });

const LAST = HOOK_FRAMES[HOOK_FRAMES.length - 1]!;
const FIRST = HOOK_FRAMES[0]!;
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');

async function login(replies: ReturnType<typeof reply>[], screenOptions: FakeScreenOptions = {}, env: Record<string, string> = {}) {
  const h = harness(replies, { interactive: true, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', SIREN_BASE_URL: 'http://127.0.0.1:34142/siren/v1', ...env } });
  const fake = fakeScreen({ columns: 80, rows: 30, ...screenOptions });
  const code = await runCli(['login'], { ...h.io, screen: fake.screen });
  return { h, fake, code };
}

describe('login screen: while it waits', () => {
  it('draws the logo, the wordmark, the code, the link and the spinner side by side, all with the first frame', async () => {
    const { fake, code: exit } = await login([code(), approved()]);
    expect(exit).toBe(0);
    const first = strip(fake.writes.find((write) => write.includes(USER_CODE)) ?? '');
    expect(first).toContain('Siren 0.3.0');
    expect(first).toContain(`Code   ${USER_CODE}`);
    expect(first).toContain(`Link   ${LINK}`);
    expect(first).toContain('Waiting for approval');
    expect(first.split('\n').find((line) => line.includes(USER_CODE))).toMatch(/^ {2}\S*[⠀-⣿ ]{20,} {4}Code/);
  });

  it('floats the halves apart and turns the spinner while it waits, and never shows the gripped logo before approval', async () => {
    const { fake } = await login([code(), pending(), pending(), denied()]);
    const waiting = fake.writes.filter((write) => write.includes('Waiting for approval'));
    expect(waiting.length).toBeGreaterThan(20);
    expect(new Set(waiting.map((write) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Waiting/.exec(strip(write))?.[0])).size).toBeGreaterThan(3);
    expect(new Set(waiting.map((write) => strip(write).split('\n').slice(2, 8).join('\n'))).size).toBeGreaterThan(1);
    for (const write of waiting) expect(write).not.toContain(LAST[3]!.trim());
  });
});

describe('login screen: how it ends', () => {
  it('grips the halves when the approval lands, puts the ✓ line in the spinner\'s place, and gives the cursor back', async () => {
    const { h, fake } = await login([code(), pending(), approved()]);
    const text = fake.text();
    const end = text.lastIndexOf(LAST[3]!.trim());
    expect(end).toBeGreaterThan(text.lastIndexOf('Waiting for approval'));
    expect(strip(fake.writes.at(-2) ?? '')).toContain(`✓ Logged in as ${EMAIL} · 2 organizations`);
    expect(fake.writes.at(-1)).toBe('\u001b[?25h');
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.pendingExitHooks()).toBe(0);
    expect(h.credentials().sessions).toBeDefined();
  });

  it('drifts the halves away on a denial, clears the spinner, and prints the ✗ line after', async () => {
    const { h, fake, code: exit } = await login([code(), pending(), denied()]);
    expect(exit).toBe(1);
    const lastWait = fake.writes.map((write) => write.includes('Waiting for approval')).lastIndexOf(true);
    const afterDenial = fake.writes.slice(lastWait + 1);
    expect(afterDenial.some((write) => write.includes(FIRST[3]!.trim()))).toBe(true);
    expect(strip(fake.writes.at(-2) ?? '')).not.toMatch(/[⠁-⣿]/);
    expect(fake.writes.at(-1)).toBe('\u001b[?25h');
    expect(h.err()).toContain('The login was denied in the browser.');
    expect(existsSync(h.credentialsPath)).toBe(false);
  });

  it('stops on Ctrl-C, keeps nothing, and gives the terminal back', async () => {
    const { h, fake, code: exit } = await login([code(), pending(), pending(), approved()], { press: { at: 5, key: '\u0003' } });
    expect(exit).toBe(1);
    expect(h.err()).toContain('Stopped waiting for approval');
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.text().endsWith('\u001b[?25h')).toBe(true);
    expect(existsSync(h.credentialsPath)).toBe(false);
  });

  it('stills the halves on any other key, and keeps waiting', async () => {
    const { fake, code: exit } = await login([code(), pending(), approved()], { press: { at: 3, key: 'x' } });
    expect(exit).toBe(0);
    const waiting = fake.writes.filter((write) => write.includes('Waiting for approval')).slice(4);
    expect(new Set(waiting.map((write) => strip(write).split('\n').slice(2, 8).join('\n'))).size).toBe(1);
  });
});

describe('login screen: the skip rules', () => {
  it.each([
    ['NO_COLOR', {}, { NO_COLOR: '1' }],
    ['a terminal too small for the logo', { columns: 40, rows: 12 }, {}],
  ] as const)('prints plain lines and draws no logo under %s', async (_name, screen, env) => {
    const { h, fake, code: exit } = await login([code(), approved()], screen, env);
    expect(exit).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(h.err()).toContain(`Code: ${USER_CODE}`);
    expect(h.err()).toContain(`Link: ${LINK}`);
    expect(h.out()).toContain(`Logged in as ${EMAIL} · 2 organizations`);
  });
});
