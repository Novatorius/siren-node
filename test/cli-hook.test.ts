import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CliIo } from '../src/cli/io';
import { runCli } from '../src/cli/run';
import { HOOK_FRAMES, HOOK_FRAME_MS, HOOK_WIDTH } from '../src/cli/hook-frames';
import { HOOK_HOVER_LIFTS, liftFrame } from '../src/cli/hook';
import { harness } from './cli-fakes';
import { fakeScreen } from './cli-screen-fake';
import type { FakeScreenOptions } from './cli-screen-fake';

/*
 * The Siren hook animation. Contract: docs/architecture/apps-cli.md, "The
 * hook on first run". It plays once, the first time a person runs the tool
 * in a terminal, and each time they run `siren` with nothing after it. It
 * never plays where it would get in the way, and a skip costs no time.
 */

const HIDE = '\u001b[?25l';
const SHOW = '\u001b[?25h';
const TRUECOLOR = '\u001b[38;2;0;255;185m';
const COLOR_256 = '\u001b[38;5;49m';

function setup(env: Record<string, string> = {}, screenOptions: FakeScreenOptions = {}) {
  const h = harness([], { env: { COLORTERM: 'truecolor', TERM: 'xterm-256color', ...env } });
  const fake = fakeScreen(screenOptions);
  const io: CliIo = { ...h.io, screen: fake.screen };
  return { h, fake, run: (argv: string[]) => runCli(argv, io), marker: join(h.configDir, 'state.json') };
}

const OFFLINE = ['apps', 'init', '--key', 'acme-payouts'];

/** Every frame the hook draws: the slide and grip, then the hover. */
const FRAME_COUNT = HOOK_FRAMES.length + HOOK_HOVER_LIFTS.length;
/** A drawn logo cell: a quadrant or half block, never braille. */
const LOGO = /[\u2580\u2584\u2588\u258c\u2590\u2596-\u259f]/;

/** The text written before the first wait, which is all a fast reader needs. */
function beforeFirstWait(fake: ReturnType<typeof fakeScreen>) {
  return fake.writes.slice(0, fake.writtenAtWait[0] ?? fake.writes.length).join('');
}

describe('apps-cli: the hook plays on first run', () => {
  /*
   * Alex, 2026-11-27, testing siren login --live --password: "the animation
   * should not block the login". The welcome used to play all 58 frames
   * before the first command started. It now draws at once and plays beside
   * the command, which starts straight away and stills it with its first line.
   */
  it('draws the welcome and starts the command at once, never waiting on a frame', async () => {
    const { fake, run, h } = setup();
    expect(await run(OFFLINE), h.err()).toBe(0);
    const text = fake.text();
    expect(text.startsWith(HIDE)).toBe(true);
    expect(fake.waits).toEqual([]);
    expect(text).toContain('Siren');
    expect(text).toMatch(/siren --help/);
    // The command's first line stilled the logo: the last frame, then the cursor back.
    expect(fake.writes.at(-1)).toContain(HOOK_FRAMES[HOOK_FRAMES.length - 1]?.[3]?.trim());
    expect(text.lastIndexOf(SHOW)).toBeGreaterThan(text.lastIndexOf(HIDE));
    expect(fake.timers()).toBe(0);
    expect(fake.log).toEqual([]);
    expect(fake.pendingExitHooks()).toBe(0);
    expect(h.file('siren.app.json')).toContain('acme-payouts');
  });

  it('moves the logo while a command waits on Siren, and stills it before the command prints anything', async () => {
    const h = harness([], { env: { COLORTERM: 'truecolor', TERM: 'xterm-256color' }, stdin: 'made-up-password\n' });
    const fake = fakeScreen();
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const io: CliIo = {
      ...h.io,
      screen: fake.screen,
      stdout: (text) => (fake.writes.push(`[stdout]${text}`), h.io.stdout(text)),
      stderr: (text) => (fake.writes.push(`[stderr]${text}`), h.io.stderr(text)),
      httpClient: { send: async (request) => (await gate, h.io.httpClient.send(request)) },
    };
    const running = runCli(['login', '--password-stdin', '--email', 'pat@example.invalid'], io);
    await vi.waitFor(() => expect(fake.timers()).toBe(1));
    const drawn = fake.writes.length;
    fake.tick(5);
    expect(fake.writes.length).toBe(drawn + 5);
    expect(new Set(fake.writes.slice(drawn)).size).toBe(5);
    open();
    await running;
    const firstOutput = fake.writes.findIndex((write) => write.startsWith('[stdout]') || write.startsWith('[stderr]'));
    expect(firstOutput).toBeGreaterThan(drawn + 5);
    expect(fake.writes[firstOutput - 1]).toContain(HOOK_FRAMES[HOOK_FRAMES.length - 1]?.[3]?.trim());
    expect(fake.writes[firstOutput - 1]).toContain(SHOW);
    expect(fake.writes.slice(firstOutput).every((write) => write.startsWith('['))).toBe(true);
    expect(fake.timers()).toBe(0);
    // It never read the keyboard, so the piped password stayed the command's.
    expect(fake.log).toEqual([]);
  });

  it('remembers it played in the config folder, and stays still the second time', async () => {
    const { fake, run, marker, h } = setup();
    await run(OFFLINE);
    expect(existsSync(marker)).toBe(true);
    expect(statSync(h.configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ version: 1 });
    const before = fake.writes.length;
    await run(['apps', 'init', '--key', 'acme-other']);
    expect(fake.writes.length).toBe(before);
  });

  it('plays on siren with nothing after it, every time, and exits 0', async () => {
    const { fake, run } = setup();
    expect(await run([])).toBe(0);
    expect(await run([])).toBe(0);
    expect(fake.waits).toHaveLength(2 * (FRAME_COUNT - 1));
    expect(fake.text()).toContain('siren login');
  });

  it('slides in and grips in about 1.8 to 2 seconds, and hovers, in no more than 3 seconds in all', () => {
    const slide = (HOOK_FRAMES.length - 1) * HOOK_FRAME_MS;
    expect(slide).toBeGreaterThanOrEqual(1800);
    expect(slide).toBeLessThanOrEqual(2000);
    expect((FRAME_COUNT - 1) * HOOK_FRAME_MS).toBeLessThanOrEqual(3000);
  });

  it('colors the hook Siren green in truecolor, and falls back to the nearest of 256 colors', async () => {
    const truecolor = setup({ COLORTERM: 'truecolor' });
    await truecolor.run([]);
    expect(truecolor.fake.text()).toContain(TRUECOLOR);

    const fallback = setup({ COLORTERM: '' });
    await fallback.run([]);
    expect(fallback.fake.text()).toContain(COLOR_256);
    expect(fallback.fake.text()).not.toContain(TRUECOLOR);
  });
});

describe('apps-cli: logo animation v2, after the demo', () => {
  it('prints all the text with the first frame, so nobody waits to read it', async () => {
    const { fake, run } = setup();
    expect(await run([])).toBe(0);
    const first = beforeFirstWait(fake);
    for (const words of ['Siren', 'Not logged in. Run siren login to log in.', 'siren login', 'siren apps init', 'siren --help lists every command.']) expect(first).toContain(words);
  });

  it('sets the wordmark in bold Siren green beside the logo, with the version', async () => {
    const { fake, run } = setup();
    await run([]);
    const lines = beforeFirstWait(fake).split('\n');
    const mark = lines.find((line) => line.includes(`${TRUECOLOR}\u001b[1mSiren`));
    expect(mark).toBeDefined();
    expect(mark).toMatch(LOGO);
    expect(mark).toMatch(/Siren\u001b\[0m \d+\.\d+\.\d+/);
    expect(lines.some((line) => LOGO.test(line) && line.includes('siren login'))).toBe(true);
  });

  it('stacks the text under the logo when the terminal is too narrow for both side by side', async () => {
    const { fake, run } = setup({}, { columns: 44, rows: 50 });
    expect(await run([])).toBe(0);
    const lines = beforeFirstWait(fake).split('\n');
    expect(lines.some((line) => line.includes('siren login'))).toBe(true);
    expect(lines.some((line) => LOGO.test(line) && /siren|Siren/.test(line))).toBe(false);
  });

  it('prints the text alone, with no animation, when neither layout fits', async () => {
    const { fake, run, h } = setup({}, { columns: 44, rows: 24 });
    expect(await run([])).toBe(0);
    expect(fake.waits).toEqual([]);
    expect(h.out()).toContain('siren login');
  });

  it('floats after the grip: the logo lifts and settles, over a shadow that narrows as it rises', async () => {
    const { fake, run } = setup();
    await run([]);
    expect(Math.max(...HOOK_HOVER_LIFTS)).toBeGreaterThan(0);
    expect(Math.max(...HOOK_HOVER_LIFTS)).toBeLessThanOrEqual(2);
    expect(HOOK_HOVER_LIFTS[HOOK_HOVER_LIFTS.length - 1]).toBe(0);
    const shadows = fake.writes.map((write) => /\u001b\[2m[^\u001b]*?(\u2581+)/.exec(write)?.[1]?.length).filter((width): width is number => width !== undefined);
    expect(new Set(shadows).size).toBeGreaterThan(1);
    expect(Math.min(...shadows)).toBeLessThan(Math.max(...shadows));
    // Alex after the demo: the shadow read as stray noise above the next output, so it goes once the logo settles.
    const settled = fake.writes.filter((write) => LOGO.test(write)).at(-1) ?? '';
    expect(settled).not.toContain('\u2581\u2581');
    const lifted = fake.writes.findIndex((write, at) => at > 0 && write.includes(HOOK_FRAMES[HOOK_FRAMES.length - 1]![3]!.trim()) === false && LOGO.test(write));
    expect(lifted).toBeGreaterThan(0);
    expect(fake.writes[fake.writes.length - 2] ?? '').toContain(HOOK_FRAMES[HOOK_FRAMES.length - 1]![3]!.trim());
  });
});

describe('apps-cli: logo animation v2, the lift', () => {
  it('a lift of 2 half rows raises the logo one whole row into the headroom, and 0 keeps it at rest', () => {
    const still = HOOK_FRAMES[HOOK_FRAMES.length - 1]!;
    const rest = liftFrame(still, 0);
    const up = liftFrame(still, 2);
    expect(rest[0]!.trim()).toBe('');
    expect(rest.slice(1).map((line) => line.trimEnd())).toEqual(still.map((line) => line.trimEnd()));
    expect(up.slice(0, -1)).toEqual(rest.slice(1));
    expect(liftFrame(still, 1)).not.toEqual(rest);
    expect(liftFrame(still, 1)).not.toEqual(up);
  });
});

/*
 * Alex on 2026-11-25, in COSMIC Terminal with Fira Mono: "the logo has gaps
 * between lines when animating". Braille dots never reach a cell's edges,
 * Fira Mono has no braille so another font draws it, and line spacing above
 * 1.0 opens a gap under every row. Block elements fill the cell, and many
 * terminals draw them to the cell's edges whatever the spacing.
 */
describe('apps-cli: the logo is drawn in block elements, which hold up under line spacing', () => {
  const blocks = /^[ \u2580\u2584\u2588\u258c\u2590\u2596-\u259f]*$/;
  it('holds no braille in any frame, lifted or not', () => {
    for (const frame of HOOK_FRAMES) for (const line of frame) expect(line, line).toMatch(blocks);
    const still = HOOK_FRAMES[HOOK_FRAMES.length - 1]!;
    for (const lift of [0, 1, 2]) for (const line of liftFrame(still, lift)) expect(line, `${lift}: ${line}`).toMatch(blocks);
  });

  it('keeps every quadrant when lifted by half a row and back', () => {
    const still = HOOK_FRAMES[HOOK_FRAMES.length - 1]!;
    const count = (lines: readonly string[]) => lines.join('').replace(/ /g, '').length;
    expect(count(liftFrame(still, 1))).toBeGreaterThan(0);
    expect(liftFrame(still, 0).map((line) => line.trimEnd())).toEqual(['', ...still.map((line) => line.trimEnd())]);
  });
});

describe('apps-cli: the hook never gets in the way', () => {
  const SKIPS: Array<{ name: string; env?: Record<string, string>; screen?: FakeScreenOptions; argv?: string[] }> = [
    { name: 'standard output is not a terminal', screen: { tty: false } },
    { name: 'CI is set', env: { CI: 'true' } },
    { name: 'NO_COLOR is set', env: { NO_COLOR: '1' } },
    { name: 'TERM is dumb', env: { TERM: 'dumb' } },
    { name: '--quiet is given', argv: [...OFFLINE, '--quiet'] },
    { name: '-q is given', argv: [...OFFLINE, '-q'] },
    { name: '--json is given', argv: ['apps', 'list', '--json', '--base-url', 'http://127.0.0.1:9'] },
    { name: 'the terminal is narrower than the hook', screen: { columns: HOOK_WIDTH } },
    { name: 'the terminal is shorter than the hook', screen: { rows: HOOK_FRAMES[0]!.length + 2 } },
    { name: 'the old Windows console is not known to draw quadrant blocks', screen: { platform: 'win32' } },
  ];

  for (const skip of SKIPS) {
    it(`skips with no delay, and keeps first run for later, when ${skip.name}`, async () => {
      const { fake, run, marker } = setup(skip.env, skip.screen);
      await run(skip.argv ?? OFFLINE);
      expect(fake.writes).toEqual([]);
      expect(fake.waits).toEqual([]);
      expect(fake.log).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    });
  }

  it('plays in Windows Terminal, which draws block elements itself', async () => {
    const { fake, run } = setup({ WT_SESSION: 'abc' }, { platform: 'win32' });
    await run(OFFLINE);
    expect(fake.writes.length).toBeGreaterThan(0);
  });

  it('treats CI=false as no CI', async () => {
    const { fake, run } = setup({ CI: 'false' });
    await run(OFFLINE);
    expect(fake.writes.length).toBeGreaterThan(0);
  });

  it('treats an empty NO_COLOR as unset, as no-color.org says', async () => {
    const { fake, run } = setup({ NO_COLOR: '' });
    await run(OFFLINE);
    expect(fake.writes.length).toBeGreaterThan(0);
  });

  it('prints the wordmark and next step without the hook on siren alone when it is skipped', async () => {
    const { fake, run, h } = setup({ CI: '1' });
    expect(await run([])).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(h.out()).toContain('Siren');
    expect(h.out()).toContain('siren login');
    expect(h.out()).not.toContain('\u001b[');
  });

  it('jumps to the still logo on siren alone when any key is pressed, and gives the keyboard back', async () => {
    const { fake, run, h } = setup({}, { press: { at: 3, key: 'x' } });
    expect(await run([]), h.err()).toBe(0);
    expect(fake.waits).toHaveLength(3);
    expect(fake.writes[fake.writes.length - 2]).toContain(HOOK_FRAMES[HOOK_FRAMES.length - 1]?.[3]?.trim());
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.text().lastIndexOf(SHOW)).toBeGreaterThan(fake.text().lastIndexOf(HIDE));
    expect(fake.pendingExitHooks()).toBe(0);
  });

  it('stops siren alone on Ctrl-C with exit code 130, the cursor shown and the keyboard given back', async () => {
    const { fake, run } = setup({}, { press: { at: 2, key: '\u0003' } });
    expect(await run([])).toBe(130);
    expect(fake.waits).toHaveLength(2);
    expect(fake.text().endsWith(`${SHOW}\n`) || fake.text().endsWith(SHOW)).toBe(true);
    expect(fake.log).toEqual(['listen', 'stop']);
    expect(fake.pendingExitHooks()).toBe(0);
  });

  it('plays siren alone to the end with no key skip when standard input is not a terminal', async () => {
    const { fake, run } = setup({}, { keys: false });
    await run([]);
    expect(fake.waits).toHaveLength(FRAME_COUNT - 1);
  });
});

describe('apps-cli: the hook frames', () => {
  it('are small, all the same height, and no wider than HOOK_WIDTH', () => {
    const source = readFileSync(new URL('../src/cli/hook-frames.ts', import.meta.url));
    expect(source.byteLength).toBeLessThan(40 * 1024);
    const height = HOOK_FRAMES[0]!.length;
    for (const frame of HOOK_FRAMES) {
      expect(frame).toHaveLength(height);
      for (const line of frame) expect([...line].length).toBeLessThanOrEqual(HOOK_WIDTH);
    }
    expect(HOOK_FRAMES[0]).not.toEqual(HOOK_FRAMES[HOOK_FRAMES.length - 1]);
  });
});
