import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CliIo } from '../src/cli/io';
import { runCli } from '../src/cli/run';
import { HOOK_FRAMES } from '../src/cli/hook-frames';
import { CLI_VERSION } from '../src/cli/version';
import { AuthAnswers, EMAIL, PASSWORD, harness } from './cli-fakes';
import { fakeScreen } from './cli-screen-fake';
import type { FakeScreenOptions } from './cli-screen-fake';

/*
 * The password login beside the logo. Alex, 2026-11-27, testing
 * `siren login --live --password`: "the animation should not block the
 * login...Animate while also showing the login at the same time." The
 * welcome used to play every frame before the email prompt appeared. Now the
 * logo floats on the left while the prompts on the right take input from the
 * first frame, as the browser login's code and link do. A timer moves the
 * logo between a saved and a restored cursor, so typing is never lost,
 * delayed or garbled, and the password is never drawn. The halves grip when
 * Siren accepts the password and drift away when it refuses.
 */

const SAVE = '\u001b7';
const RESTORE = '\u001b8';
const SHOW = '\u001b[?25h';
const LAST = HOOK_FRAMES[HOOK_FRAMES.length - 1]!;
const FIRST = HOOK_FRAMES[0]!;
const strip = (text: string) => text.replace(/\u001b(?:\[[\d;?]*[A-Za-z]|[78])/g, '');

function start(replies: Parameters<typeof harness>[0], argv: string[] = [], screenOptions: FakeScreenOptions = {}, extra: { env?: Record<string, string>; io?: Partial<CliIo> } = {}) {
  const h = harness(replies, { interactive: true, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', SIREN_BASE_URL: 'http://127.0.0.1:34142/siren/v1', ...extra.env } });
  const fake = fakeScreen({ columns: 80, rows: 30, ...screenOptions });
  // What the screen had been sent when the keyboard was first read.
  let writtenAtListen = -1;
  const listen = fake.screen.listen;
  const screen = { ...fake.screen, listen: (onKey: (key: string) => void) => ((writtenAtListen = fake.writes.length), listen(onKey)) };
  const running = runCli(['login', '--password', ...argv], { ...h.io, stderrTty: true, screen, ...extra.io });
  return { h, fake, running, writtenAtListen: () => writtenAtListen };
}

/** Types `text` a character at a time, a frame of the logo after each. */
function typeWithFrames(fake: ReturnType<typeof fakeScreen>, text: string) {
  for (const char of text) {
    fake.press(char);
    fake.tick();
  }
}

/** The body of the one POST /auth/login the command sent. */
function loginBody(h: ReturnType<typeof harness>) {
  const request = h.http.requests.find((one) => one.url.endsWith('/auth/login'));
  return request === undefined ? undefined : (JSON.parse(String(request.body)) as { email: string; password: string });
}

describe('password login screen: the prompts are live from the first frame', () => {
  it('draws the logo, the wordmark, the Siren and both prompts at once, with the keyboard read before anything is drawn', async () => {
    const { fake, running, writtenAtListen, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    expect(writtenAtListen()).toBe(0);
    expect(fake.waits).toEqual([]);
    expect(fake.writtenAtTick).toEqual([]);
    const first = strip(fake.text());
    expect(first).toContain(`Siren ${CLI_VERSION}`);
    expect(first).toContain('Log in to 127.0.0.1:34142');
    expect(first).toContain('Email: ');
    expect(first).toContain('Password: ');
    // The cursor waits, shown, at the email prompt.
    expect(fake.writes.at(-1)).toBe(SHOW);
    fake.press(`${EMAIL}\r${PASSWORD}\r`);
    expect(await running, h.err()).toBe(0);
  });

  it('lands every character typed during the animation, in order, and never draws the password', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    typeWithFrames(fake, EMAIL);
    // Each key redraws the field from its first column, so the last such write is the whole email.
    expect(strip(fake.writes.filter((write) => !write.includes(SAVE)).at(-1) ?? '')).toBe(EMAIL);
    fake.press('\r');
    typeWithFrames(fake, PASSWORD);
    fake.press('\r');
    expect(await running, h.err()).toBe(0);
    expect(loginBody(h)).toEqual({ email: EMAIL, password: PASSWORD });
    expect(fake.writtenAtTick.length).toBeGreaterThan(EMAIL.length + PASSWORD.length - 1);
    for (const write of fake.writes) expect(write).not.toContain(PASSWORD.slice(0, 4));
    expect(h.prompts).toEqual([]);
    expect(h.secretPrompts).toEqual([]);
  });

  it('moves only the logo and the status line on a frame, between a saved and a restored cursor', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press('pat');
    const before = fake.writes.length;
    fake.tick(3);
    const frames = fake.writes.slice(before);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame).toMatch(new RegExp(`^\\u001b\\[\\?25l${SAVE}`));
      expect(frame).toContain(`${RESTORE}${SHOW}`);
      expect(frame).not.toContain('\n');
      expect(strip(frame)).not.toMatch(/Email|Password|pat/);
    }
    expect(new Set(frames).size).toBeGreaterThan(1);
    fake.press(`@example.invalid\r${PASSWORD}\r`);
    expect(await running, h.err()).toBe(0);
    expect(loginBody(h)?.email).toBe('pat@example.invalid');
  });

  it('keeps keys typed ahead in one burst, Enter and all, for the prompt they were meant for', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press(`${EMAIL}\r\n${PASSWORD}\r`);
    expect(await running, h.err()).toBe(0);
    expect(loginBody(h)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it('takes Backspace and Ctrl-U, and ignores arrow keys', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press('wrong\u0015dev@acme.examplx\u007fe\u001b[D\r');
    fake.press(`${PASSWORD}x\b\r`);
    expect(await running, h.err()).toBe(0);
    expect(loginBody(h)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it('shows the email given with --email and asks only for the password', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()], ['--email', EMAIL]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    expect(strip(fake.text())).toContain(`Email: ${EMAIL}`);
    fake.press(`${PASSWORD}\r`);
    expect(await running, h.err()).toBe(0);
    expect(loginBody(h)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it('stacks the prompts under the logo when the terminal is too narrow for both side by side', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()], [], { columns: 50, rows: 40 });
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    const lines = strip(fake.text()).split('\n');
    expect(lines.some((line) => /^ {2}Email: $/.test(line))).toBe(true);
    fake.press(`${EMAIL}\r${PASSWORD}\r`);
    expect(await running, h.err()).toBe(0);
  });
});

describe('password login screen: how it ends', () => {
  it("grips the halves when Siren accepts the password, puts the ✓ line in the status line, and gives the terminal back", async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press(`${EMAIL}\r${PASSWORD}\r`);
    expect(await running, h.err()).toBe(0);
    const text = fake.text();
    expect(text.lastIndexOf(LAST[3]!.trim())).toBeGreaterThan(text.indexOf('Logged in as'));
    expect(strip(text)).toContain(`✓ Logged in as ${EMAIL} · 1 organization`);
    expect(fake.text().endsWith(SHOW)).toBe(true);
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.timers()).toBe(0);
    expect(fake.pendingExitHooks()).toBe(0);
    expect(h.credentials().sessions).toBeDefined();
  });

  it('drifts the halves away when Siren refuses the password, then prints the ✗ line', async () => {
    const { fake, running, h } = start([AuthAnswers.wrongPassword()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press(`${EMAIL}\rnot-it\r`);
    expect(await running).toBe(1);
    const afterLogin = fake.writes.slice(fake.writes.findIndex((write) => write.includes('Logging in')));
    expect(afterLogin.some((write) => write.includes(FIRST[3]!.trim()))).toBe(true);
    expect(fake.text().endsWith(SHOW)).toBe(true);
    expect(h.err()).toContain("Siren didn't accept that email and password.");
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.timers()).toBe(0);
    expect(existsSync(h.credentialsPath)).toBe(false);
  });

  it('stops on Ctrl-C at a prompt, sends nothing, and gives the terminal back', async () => {
    const { fake, running, h } = start([AuthAnswers.oneOrg()]);
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press(`${EMAIL}\rcorr`);
    fake.tick(2);
    fake.press('\u0003');
    expect(await running).toBe(1);
    expect(h.err()).toContain('Stopped.');
    expect(h.paths()).toEqual([]);
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.timers()).toBe(0);
    expect(fake.text().endsWith(SHOW)).toBe(true);
  });

  it('stops on Ctrl-C while Siren checks the password, and keeps no session', async () => {
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { fake, running, h } = start([AuthAnswers.oneOrg()], [], {}, {
      io: {
        httpClient: {
          send: async (request) => {
            if (request.url.endsWith('/auth/signup-options')) return AuthAnswers.sandbox();
            await gate;
            return AuthAnswers.oneOrg();
          },
        },
      },
    });
    await vi.waitFor(() => expect(fake.listening()).toBe(true));
    fake.press(`${EMAIL}\r${PASSWORD}\r`);
    await vi.waitFor(() => expect(strip(fake.text())).toContain('Logging in'));
    fake.tick(3);
    fake.press('\u0003');
    expect(await running).toBe(1);
    open();
    expect(h.err()).toContain('Stopped logging in.');
    expect(existsSync(h.credentialsPath)).toBe(false);
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.timers()).toBe(0);
  });
});

describe('password login screen: the skip rules', () => {
  const plain: Array<[string, FakeScreenOptions, Record<string, string>, string[], Partial<CliIo>]> = [
    ['NO_COLOR', {}, { NO_COLOR: '1' }, [], {}],
    ['CI', {}, { CI: 'true' }, [], {}],
    ['--quiet', {}, {}, ['--quiet'], {}],
    ['-q', {}, {}, ['-q'], {}],
    ['a terminal too small for the logo', { columns: 40, rows: 12 }, {}, [], {}],
    ['standard output that is not a terminal', { tty: false }, {}, [], {}],
    ['standard input that is not a terminal', { keys: false }, {}, [], {}],
    ['standard error that is not a terminal', {}, {}, [], { stderrTty: false }],
  ];
  it.each(plain)('asks at plain prompts and draws no logo under %s', async (_name, screen, env, argv, io) => {
    const h = harness([AuthAnswers.oneOrg()], { interactive: true, typed: [EMAIL], secrets: [PASSWORD], env: { TERM: 'xterm-256color', SIREN_BASE_URL: 'http://127.0.0.1:34142/siren/v1', ...env } });
    const fake = fakeScreen({ columns: 80, rows: 30, ...screen });
    expect(await runCli(['login', '--password', ...argv], { ...h.io, stderrTty: true, screen: fake.screen, ...io }), h.err()).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(fake.waits).toEqual([]);
    expect(fake.timers()).toBe(0);
    expect(h.prompts).toEqual(['Email: ']);
    expect(h.secretPrompts).toEqual(['Password: ']);
    expect(loginBody(h)).toEqual({ email: EMAIL, password: PASSWORD });
  });
});
