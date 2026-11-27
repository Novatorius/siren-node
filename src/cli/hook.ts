import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_FRAMES, HOOK_FRAME_MS, HOOK_WIDTH } from './hook-frames';
import { KEY_DRAIN_MS } from './io';
import type { CliIo, CliScreen } from './io';
import { CliRefusal } from './targets';
import { visibleLength } from './style';

/**
 * Siren green, the dark theme's `--primary` in Siren's frontend
 * (frontend/src/index.css, `.dark`, `164 100% 50%`, which the file names
 * "exact logo color #00FFB9"). The logo SVG fills both hook halves with it.
 * Terminals that draw only 256 colors get 49, the nearest (#00FFAF).
 */
export const SIREN_GREEN = { truecolor: '\u001b[38;2;0;255;185m', ansi256: '\u001b[38;5;49m' } as const;

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR_LINE = '\u001b[2K';
const SAVE_CURSOR = '\u001b7';
const RESTORE_CURSOR = '\u001b8';
const CTRL_C = '\u0003';
const INDENT = '  ';

/** Why the hook does not play. Each one is checked before anything is drawn or waited on. */
export type HookSkip = 'not-a-terminal' | 'ci' | 'no-color' | 'dumb-terminal' | 'quiet' | 'json' | 'too-small' | 'old-console';

/** The flags on the command line that silence the hook. */
export interface HookFlags {
  quiet: boolean;
  json: boolean;
}

/**
 * The reason the hook must not play here, or null when it may. It never
 * plays when standard output is not a terminal, under CI (any value but
 * `false` or `0`), under NO_COLOR (any value but empty, as no-color.org
 * says), when TERM is `dumb`, with `--quiet` or `--json`, in a terminal too
 * small to hold it, or in a Windows console other than Windows Terminal,
 * since the old console is not known to draw quadrant blocks.
 */
export function hookSkip(screen: CliScreen | undefined, env: Readonly<Record<string, string | undefined>>, flags: HookFlags): HookSkip | null {
  if (screen === undefined || screen.size === null) return 'not-a-terminal';
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0') return 'ci';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'no-color';
  if (env.TERM === 'dumb') return 'dumb-terminal';
  if (flags.quiet) return 'quiet';
  if (flags.json) return 'json';
  if (screen.size.columns < HOOK_WIDTH + INDENT.length * 2 || screen.size.rows < HOOK_ROWS + 4) return 'too-small';
  if (screen.platform === 'win32' && !env.WT_SESSION) return 'old-console';
  return null;
}

/** How the hook ended: every frame drawn, a key pressed to skip to the still logo, or Ctrl-C. */
export type HookEnd = 'played' | 'skipped' | 'interrupted';

/**
 * How far the logo floats above its rest after the grip, in half rows, one
 * entry a frame, {@link HOOK_FRAME_MS} apart: up a row, down, a smaller bob,
 * and still. A quadrant block is two pixels tall, so 2 is one row.
 */
export const HOOK_HOVER_LIFTS: readonly number[] = [1, 1, 2, 2, 2, 2, 2, 2, 2, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0];

/** The blank row above the logo that it floats into. */
const HEADROOM = 1;

/** The lines the logo takes: the headroom, the frame, and the shadow under it. */
export const HOOK_ROWS = HEADROOM + (HOOK_FRAMES[0]?.length ?? 0) + 1;

/** Columns between the logo and the text beside it. */
const GAP = '    ';

/** The shadow's character, a thin block along the bottom of the cell, and its widths at rest and at the top of a lift. */
const SHADOW = '\u2581';
const SHADOW_REST = 14;
const SHADOW_NARROWEST = 8;

/** A dark Siren green for the shadow, drawn dim. */
const SHADOW_COLOR = { truecolor: '\u001b[38;2;0;110;80m', ansi256: '\u001b[38;5;23m' } as const;
const DIM = '\u001b[2m';

/**
 * The quadrant block for each 4-bit pattern: top left 1, top right 2,
 * bottom left 4, bottom right 8. The frames hold only these and spaces.
 */
const QUADRANTS = [' ', '\u2598', '\u259d', '\u2580', '\u2596', '\u258c', '\u259e', '\u259b', '\u2597', '\u259a', '\u2590', '\u259c', '\u2584', '\u2599', '\u259f', '\u2588'] as const;
const QUADRANT_BITS = new Map<string, number>(QUADRANTS.map((char, bits) => [char, bits]));

/**
 * A frame's rows with the headroom row above, the logo lifted `lift` half
 * rows into it, each row exactly {@link HOOK_WIDTH} characters. Each
 * character holds 2 by 2 pixels, so a lift of 1 moves the logo half a row.
 */
export function liftFrame(frame: readonly string[], lift: number): string[] {
  const height = (frame.length + HEADROOM) * 2;
  const width = HOOK_WIDTH * 2;
  const pixels: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  frame.forEach((line, row) => {
    [...line].forEach((char, col) => {
      const bits = QUADRANT_BITS.get(char) ?? 0;
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) if (bits & (1 << (dy * 2 + dx))) pixels[(row + HEADROOM) * 2 + dy - lift]![col * 2 + dx] = true;
    });
  });
  const rows: string[] = [];
  for (let row = 0; row < height / 2; row++) {
    let line = '';
    for (let col = 0; col < HOOK_WIDTH; col++) {
      let bits = 0;
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) if (pixels[row * 2 + dy]?.[col * 2 + dx]) bits |= 1 << (dy * 2 + dx);
      line += QUADRANTS[bits];
    }
    rows.push(line);
  }
  return rows;
}

/** One drawn moment of the logo: its rows, and the shadow's width, 0 for none. */
export interface LogoFrame {
  rows: readonly string[];
  shadow: number;
}

/**
 * The slide and grip, then the hover. The last is the still logo at rest
 * with no shadow, since a shadow left under a still logo reads as a stray
 * line above whatever prints next.
 */
export function hookSequence(): LogoFrame[] {
  const last = HOOK_FRAMES[HOOK_FRAMES.length - 1] ?? [];
  const slide = HOOK_FRAMES.map((frame) => ({ rows: liftFrame(frame, 0), shadow: 0 }));
  const hover = HOOK_HOVER_LIFTS.map((lift, at) => ({
    rows: liftFrame(last, lift),
    shadow: at === HOOK_HOVER_LIFTS.length - 1 ? 0 : shadowWidth(lift),
  }));
  return [...slide, ...hover];
}

/** The shadow narrows as the logo rises. */
function shadowWidth(lift: number): number {
  return Math.round(SHADOW_REST - ((SHADOW_REST - SHADOW_NARROWEST) * lift) / 2);
}

/**
 * What the hook shows beside the logo: the wordmark with the version, then
 * where you stand, the commands that come next with a line about each, and
 * a last line. Any part may be empty.
 */
export interface HookCard {
  version: string;
  where: readonly string[];
  next: ReadonlyArray<readonly [string, string]>;
  footer: string;
}

/** Where the text goes: beside the logo, under it, or nowhere because neither fits. */
export type HookLayout = 'side' | 'stacked';

/** The card's lines beside the logo: each command on its own line with its note under it. */
function sideLines(card: HookCard): string[] {
  const lines: string[] = [];
  if (card.where.length > 0) lines.push('', ...card.where);
  if (card.next.length > 0) {
    lines.push('');
    for (const [command, about] of card.next) lines.push(command, `  ${about}`);
  }
  if (card.footer !== '') lines.push('', card.footer);
  return lines;
}

/** The card's lines under the logo, or with no logo: each command padded to line up with its note. */
function stackedLines(card: HookCard): string[] {
  const width = Math.max(0, ...card.next.map(([command]) => command.length)) + 2;
  const lines: string[] = [...card.where];
  if (card.next.length > 0) lines.push(...(lines.length > 0 ? [''] : []), ...card.next.map(([command, about]) => `${command.padEnd(width)}${about}`));
  if (card.footer !== '') lines.push(...(lines.length > 0 ? [''] : []), card.footer);
  return lines;
}

/** The plain card, for a terminal the hook does not play in: the wordmark and the lines under it. */
export function plainCard(card: HookCard): string {
  return `\n${INDENT}Siren ${card.version}\n${stackedLines(card).map((line) => (line === '' ? '\n' : `${INDENT}${line}\n`)).join('')}\n`;
}

/**
 * Side by side when the terminal is wide and tall enough for the logo and
 * the longest line beside it, else stacked when it is tall enough for the
 * logo and the text under it, else null.
 */
export function hookLayout(size: { columns: number; rows: number }, card: HookCard): HookLayout | null {
  const side = sideLines(card);
  const sideWidth = INDENT.length + HOOK_WIDTH + GAP.length + Math.max(`Siren ${card.version}`.length, ...side.map((line) => visibleLength(line)));
  if (size.columns > sideWidth && size.rows >= Math.max(HOOK_ROWS, side.length + 2) + 2) return 'side';
  if (size.rows >= HOOK_ROWS + 2 + stackedLines(card).length + 2) return 'stacked';
  return null;
}

/** How the hook draws a card: the whole block at once, and the logo's columns alone after that. */
interface HookPainter {
  /** Every line of the block, the logo, the text beside it and under it, ending under the block. */
  block(frame: LogoFrame): string;
  /** The logo's columns alone, from under the block and back there, leaving the text as it is. */
  redraw(frame: LogoFrame): string;
}

/** The painter for `card` in `layout`, in Siren green. */
function hookPainter(env: Readonly<Record<string, string | undefined>>, card: HookCard, layout: HookLayout): HookPainter {
  const color = greenFor(env);
  const shade = color === SIREN_GREEN.truecolor ? SHADOW_COLOR.truecolor : SHADOW_COLOR.ansi256;
  const logoLine = (frame: LogoFrame, row: number): string => {
    if (row < HOOK_ROWS - 1) return `${color}${frame.rows[row] ?? ''.padEnd(HOOK_WIDTH)}${RESET}`;
    if (frame.shadow === 0) return ' '.repeat(HOOK_WIDTH);
    const left = Math.floor((HOOK_WIDTH - frame.shadow) / 2);
    return `${shade}${DIM}${' '.repeat(left)}${SHADOW.repeat(frame.shadow)}${RESET}${' '.repeat(HOOK_WIDTH - left - frame.shadow)}`;
  };
  const mark = `${color}${BOLD}Siren${RESET} ${card.version}`;
  const text = layout === 'side' ? [mark, ...sideLines(card)] : [];
  const below = layout === 'stacked' ? ['', mark, ...stackedLines(card)] : [];
  const top = layout === 'side' ? Math.max(0, Math.floor((HOOK_ROWS - text.length) / 2)) : 0;
  const besideRows = Math.max(HOOK_ROWS, top + text.length);
  const height = besideRows + below.length;
  return {
    block(frame) {
      let out = '';
      for (let row = 0; row < height; row++) {
        if (row >= besideRows) {
          const line = below[row - besideRows] ?? '';
          out += `${CLEAR_LINE}${line === '' ? '' : `${INDENT}${line}`}\n`;
          continue;
        }
        const beside = text[row - top];
        const logo = row < HOOK_ROWS ? logoLine(frame, row) : ' '.repeat(HOOK_WIDTH);
        out += `${CLEAR_LINE}${INDENT}${logo}${beside === undefined || beside === '' ? '' : `${GAP}${beside}`}\n`;
      }
      return out;
    },
    redraw(frame) {
      let out = `\u001b[${height}A`;
      for (let row = 0; row < HOOK_ROWS; row++) out += `\r${INDENT}${logoLine(frame, row)}\n`;
      return height > HOOK_ROWS ? `${out}\u001b[${height - HOOK_ROWS}B\r` : out;
    },
  };
}

/**
 * Plays the hook with the card's text, for `siren` with nothing after it,
 * whose whole job the card is: hides the cursor, prints every line of text
 * with the first frame, then redraws only the logo in place,
 * {@link HOOK_FRAME_MS} apart, so a fast reader never waits for the text.
 * Any key draws the still logo at once. Ctrl-C stops it where it is. It
 * shows the cursor again however it ends, also when the process exits
 * mid-way. When standard input is a terminal it reads keys in raw mode and
 * gives the mode back at the end. Otherwise it plays to the end, about 2.9
 * seconds, and never reads standard input, which may hold a piped password.
 */
export async function playHook(screen: CliScreen, env: Readonly<Record<string, string | undefined>>, card: HookCard, layout: HookLayout): Promise<HookEnd> {
  const paint = hookPainter(env, card, layout);
  const frames = hookSequence();
  const last = frames.length - 1;

  const keys: { pressed: string | null } = { pressed: null };
  screen.write(HIDE_CURSOR);
  const forgetExit = screen.atExit(() => screen.write(`${RESET}${SHOW_CURSOR}`));
  const stopListening = screen.listen((key) => {
    keys.pressed ??= key;
  });
  let end: HookEnd = 'played';
  try {
    screen.write(paint.block(frames[0]!));
    for (let index = 1; index <= last; index++) {
      await screen.wait(HOOK_FRAME_MS);
      if (keys.pressed === CTRL_C) {
        end = 'interrupted';
        break;
      }
      if (keys.pressed !== null) {
        screen.write(paint.redraw(frames[last]!));
        end = 'skipped';
        break;
      }
      screen.write(paint.redraw(frames[index]!));
    }
  } finally {
    stopListening?.();
    screen.write(SHOW_CURSOR);
    forgetExit();
  }
  return end;
}

/** Truecolor when the terminal says it draws it (COLORTERM `truecolor` or `24bit`), else the 256-color green. */
function greenFor(env: Readonly<Record<string, string | undefined>>): string {
  const depth = (env.COLORTERM ?? '').toLowerCase();
  return depth === 'truecolor' || depth === '24bit' ? SIREN_GREEN.truecolor : SIREN_GREEN.ansi256;
}

/** The file in the config folder that says the hook has played on this machine. */
function markerPath(io: CliIo): string {
  return join(io.configDir, 'state.json');
}

/** True when the hook has played before. A file that cannot be read counts as played, so a fault never replays it. */
async function hasPlayed(io: CliIo): Promise<boolean> {
  try {
    await stat(markerPath(io));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Remembers that the hook played. The folder is made with mode 0700, as for credentials.json. A write that fails is let go. */
async function rememberPlayed(io: CliIo): Promise<void> {
  try {
    const made = await mkdir(io.configDir, { recursive: true, mode: 0o700 });
    if (made !== undefined && process.platform !== 'win32') await chmod(io.configDir, 0o700);
    await writeFile(markerPath(io), `${JSON.stringify({ version: 1, hookPlayedAt: new Date(io.now()).toISOString() })}\n`, { mode: 0o600 });
  } catch {
    // The hook is a welcome. Failing to remember it must not fail the command.
  }
}

/**
 * Plays the hook with `card` beside or under it when it may and a layout
 * fits, and answers how it ended, or null when it did not play. Remembers
 * that it played.
 */
async function playCard(io: CliIo, flags: HookFlags, card: HookCard): Promise<HookEnd | null> {
  if (hookSkip(io.screen, io.env, flags) !== null || io.screen?.size == null) return null;
  const layout = hookLayout(io.screen.size, card);
  if (layout === null) return null;
  const end = await playHook(io.screen, io.env, card, layout);
  await rememberPlayed(io);
  return end;
}

/**
 * What `siren` with nothing after it does: plays the hook with the card
 * when it may, else prints the plain card: the wordmark, where you stand
 * and what comes next. Answers the exit code, 0, or 130 after Ctrl-C.
 */
export async function welcome(io: CliIo, flags: HookFlags, card: HookCard): Promise<number> {
  const end = await playCard(io, flags, card);
  if (end === 'interrupted') return 130;
  if (end === null) io.stdout(plainCard(card));
  return 0;
}

/** The first-run welcome, which plays beside the command rather than before it. */
export interface FirstRunWelcome {
  /**
   * The io the command runs with. Its first line, prompt or screen write
   * stills the logo first, so the command's own output never waits and
   * never lands inside the animation.
   */
  readonly io: CliIo;
  /** Stills the logo if it still moves, and waits until the marker is written. */
  settle(): Promise<void>;
}

/**
 * The welcome the first time a person runs the tool on this machine: the
 * logo with the wordmark and a pointer to `--help` beside it. It never
 * delays the command (Alex, 2026-11-27: "the animation should not block").
 * The block is drawn at once and the command starts straight away. A timer
 * moves the logo while the command works, and the command's first output
 * stills it, so a quick command shows the still logo and a slow one, such
 * as one that waits on Siren, shows the logo moving meanwhile. It never
 * reads standard input, so keys typed ahead reach the command, and Ctrl-C
 * stops the command as it always does. It plays nothing and remembers
 * nothing when the hook may not play here, so the first run in a terminal
 * still gets it.
 */
export async function firstRun(io: CliIo, flags: HookFlags, version: string): Promise<FirstRunWelcome> {
  const none: FirstRunWelcome = { io, settle: async () => undefined };
  const screen = io.screen;
  if (hookSkip(screen, io.env, flags) !== null || screen === undefined || screen.size === null) return none;
  if (await hasPlayed(io)) return none;
  const card: HookCard = { version, where: [], next: [], footer: 'Run siren --help any time to see every command.' };
  const layout = hookLayout(screen.size, card);
  if (layout === null) return none;
  const paint = hookPainter(io.env, card, layout);
  const frames = hookSequence();
  const last = frames.length - 1;
  let index = 0;
  let still = false;
  screen.write(HIDE_CURSOR);
  const forgetExit = screen.atExit(() => screen.write(`${RESET}${SHOW_CURSOR}`));
  screen.write(paint.block(frames[0]!));
  // Saving and restoring the cursor keeps it where a key typed ahead left it.
  const stopTimer = screen.every(HOOK_FRAME_MS, () => {
    index += 1;
    if (index >= last) return stillLogo();
    screen.write(`${SAVE_CURSOR}${paint.redraw(frames[index]!)}${RESTORE_CURSOR}`);
  });
  const remembered = rememberPlayed(io);
  function stillLogo(): void {
    if (still) return;
    still = true;
    stopTimer();
    screen!.write(`${SAVE_CURSOR}${paint.redraw(frames[last]!)}${RESTORE_CURSOR}${SHOW_CURSOR}`);
    forgetExit();
  }
  const first = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    stillLogo();
    return fn(...args);
  };
  const wrapped: CliIo = {
    ...io,
    stdout: first(io.stdout),
    stderr: first(io.stderr),
    prompt: first(io.prompt),
    promptSecret: first(io.promptSecret),
    screen: { ...screen, write: first(screen.write), listen: first(screen.listen) },
  };
  return {
    io: wrapped,
    settle: async () => {
      stillLogo();
      await remembered;
    },
  };
}

/** What the login screen shows beside the logo while it waits for approval in the browser. */
export interface LoginCard {
  version: string;
  code: string;
  link: string;
  /** True when the tool opened the link in the browser itself. */
  opened: boolean;
  /** The host of the Siren the tool polls, so the person can tell a look-alike page from it. */
  siren: string;
}

/** The logo during `siren login`. Build it with {@link startLoginStage}. */
export interface LoginStage {
  /** Waits `ms` while the halves float apart and the spinner turns. Ctrl-C stops the login. */
  wait(ms: number): Promise<void>;
  /** Draws the gripped logo at once, with `line` in the spinner's place with a ✓, and gives the terminal back. */
  approved(line: string): Promise<void>;
  /** Clears the logo and the spinner's line at once for the ✗ line the tool prints next. */
  failed(): Promise<void>;
  /** True once the person pressed Ctrl-C. */
  stopped(): boolean;
}

/** The frame the halves float around while login waits: apart, before they meet. */
const APART = 6;

/** How far from {@link APART} the halves drift on each frame while login waits, so they float without meeting. */
const APART_DRIFT: readonly number[] = [0, 0, 1, 1, 2, 2, 2, 1, 1, 0, 0, -1, -1, -2, -2, -2, -1, -1];

/** The spinner beside "Waiting for approval", one character a frame. */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The words under the wordmark while login waits. */
function loginLines(card: LoginCard): string[] {
  return [
    '',
    card.opened ? 'Your browser is open. Approve the code there.' : 'Open the link, and approve the code there.',
    '',
    `Code   ${card.code}`,
    `Link   ${card.link}`,
    `Siren  ${card.siren}`,
    '',
    'Waiting for approval',
  ];
}

/**
 * Starts the login screen when the logo animation may play here and the
 * logo and its text fit side by side or stacked, else answers null, and the
 * tool prints plain lines. The text is all drawn at once. The halves float
 * apart while login waits. Any key stills them, and Ctrl-C stops the login.
 */
export function startLoginStage(io: CliIo, flags: HookFlags, card: LoginCard): LoginStage | null {
  const screen = io.screen;
  if (hookSkip(screen, io.env, flags) !== null || screen === undefined || screen.size === null) return null;
  const lines = loginLines(card);
  const fits = hookLayout(screen.size, { version: card.version, where: lines, next: [], footer: '' });
  if (fits === null) return null;
  const color = greenFor(io.env);
  const mark = `${color}${BOLD}Siren${RESET} ${card.version}`;
  const spinAt = lines.length; // The spinner's line, counted with the wordmark as line 0.
  const text = [mark, ...lines];
  const top = fits === 'side' ? Math.max(0, Math.floor((HOOK_ROWS - text.length) / 2)) : 0;
  const besideRows = fits === 'side' ? Math.max(HOOK_ROWS, top + text.length) : HOOK_ROWS;
  const below = fits === 'stacked' ? ['', ...text] : [];
  const height = besideRows + below.length;
  const frameAt = (index: number): LogoFrame => ({ rows: liftFrame(HOOK_FRAMES[Math.max(0, Math.min(index, HOOK_FRAMES.length - 1))] ?? [], 0), shadow: 0 });
  const blank: LogoFrame = { rows: liftFrame(HOOK_FRAMES[0] ?? [], 0).map((row) => ' '.repeat([...row].length)), shadow: 0 };

  let status = `${color}${SPIN[0]}${RESET} Waiting for approval`;
  const lineOf = (index: number) => (index === spinAt ? status : text[index] ?? '');
  const draw = (frame: LogoFrame): string => {
    let out = '';
    for (let row = 0; row < height; row++) {
      if (row >= besideRows) {
        const index = row - besideRows - 1;
        const line = index < 0 ? '' : lineOf(index);
        out += `${CLEAR_LINE}${line === '' ? '' : `${INDENT}${line}`}\n`;
        continue;
      }
      const logo = row < HOOK_ROWS - 1 ? `${color}${frame.rows[row] ?? ''.padEnd(HOOK_WIDTH)}${RESET}` : ' '.repeat(HOOK_WIDTH);
      const index = row - top;
      const beside = fits === 'side' && index >= 0 && index < text.length ? lineOf(index) : '';
      out += `${CLEAR_LINE}${INDENT}${logo}${beside === '' ? '' : `${GAP}${beside}`}\n`;
    }
    return out;
  };
  const redraw = (frame: LogoFrame) => screen.write(`\u001b[${height}A${draw(frame)}`);

  const keys: { pressed: string | null } = { pressed: null };
  screen.write(HIDE_CURSOR);
  const forgetExit = screen.atExit(() => screen.write(`${RESET}${SHOW_CURSOR}`));
  const stopListening = screen.listen((key) => {
    keys.pressed ??= key;
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stopListening?.();
    screen.write(SHOW_CURSOR);
    forgetExit();
  };
  let tick = 0;
  let current = frameAt(APART);
  screen.write(draw(current));

  return {
    async wait(ms) {
      const ticks = Math.max(1, Math.ceil(ms / HOOK_FRAME_MS));
      for (let step = 0; step < ticks; step++) {
        await screen.wait(HOOK_FRAME_MS);
        if (keys.pressed === CTRL_C) {
          close();
          throw new CliRefusal('Stopped waiting for approval.', { why: 'You pressed Ctrl-C, so nothing was kept.', fixText: 'Run siren login again when you are ready.' });
        }
        tick += 1;
        if (keys.pressed === null) current = frameAt(APART + APART_DRIFT[tick % APART_DRIFT.length]!);
        status = `${color}${SPIN[tick % SPIN.length]}${RESET} Waiting for approval`;
        redraw(current);
      }
    },
    stopped: () => keys.pressed === CTRL_C,
    async approved(line) {
      if (closed) return;
      status = `${color}✓${RESET} ${line}`;
      redraw(hookSequence().at(-1)!);
      close();
      await rememberPlayed(io);
    },
    async failed() {
      // Ctrl-C already gave the terminal back, or gives it back now with the halves where they were.
      if (closed) return;
      if (keys.pressed === CTRL_C) return close();
      status = '';
      redraw(blank);
      close();
    },
  };
}

/** What `siren login --password` shows beside the logo while it asks for the email and password. */
export interface PasswordCard {
  version: string;
  /** The host of the Siren the tool logs in to. */
  siren: string;
  /** The email given with --email, shown in place of its prompt. */
  email?: string;
}

/** The logo beside the password login's prompts. Build it with {@link startPasswordStage}. */
export interface PasswordStage {
  /** Reads a line at the prompt named `question`, `Email: `, showing what is typed. */
  prompt(question: string): Promise<string>;
  /** Reads a line at the prompt named `question`, `Password: `, showing nothing of it. */
  promptSecret(question: string): Promise<string>;
  /** Turns the spinner beside "Logging in" until `work` settles. Ctrl-C stops waiting. */
  during<T>(work: Promise<T>): Promise<T>;
  /** Draws the gripped logo at once, with `line` in the spinner's place with a ✓, and gives the terminal back. */
  approved(line: string): Promise<void>;
  /** Clears the logo and the spinner's line at once for the ✗ line the tool prints next. */
  failed(): Promise<void>;
}

/** The columns kept free for typing beside a prompt when the tool checks the layout fits. */
const FIELD_ROOM = 32;

/** The prompts the password login asks, in the words of the plain prompts. */
const EMAIL_PROMPT = 'Email: ';
const PASSWORD_PROMPT = 'Password: ';

/** An escape sequence a key such as an arrow sends, which a prompt ignores whole. */
const ESCAPE_SEQUENCE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/su;

/**
 * Starts the password login's screen when the logo animation may play
 * here, standard input and standard error are terminals, and the logo and
 * its prompts fit side by side or stacked, else answers null and draws
 * nothing, and the tool asks at plain prompts.
 *
 * Alex, 2026-11-27: "Animate while also showing the login at the same
 * time." The block, with both prompts, is drawn at once and the cursor waits
 * at the first prompt. A timer floats the halves apart while the person
 * types, and redraws only the logo's columns between saving and restoring
 * the cursor, so a key is echoed where it was typed and never waits for a
 * frame. Standard input is in raw mode from before anything is drawn until
 * the screen closes, so the terminal itself never echoes, and the password
 * is never shown. Keys typed ahead of a prompt wait for it. Ctrl-C stops the
 * login at any point.
 */
export async function startPasswordStage(io: CliIo, flags: HookFlags, card: PasswordCard): Promise<PasswordStage | null> {
  const screen = io.screen;
  if (!io.interactive || io.stderrTty === false) return null;
  if (hookSkip(screen, io.env, flags) !== null || screen === undefined || screen.size === null) return null;
  const size = screen.size;
  const fields = [card.email === undefined ? EMAIL_PROMPT : `${EMAIL_PROMPT}${card.email}`, PASSWORD_PROMPT];
  const lines = ['', `Log in to ${card.siren}`, '', ...fields, '', ''];
  const roomy = lines.map((line) => (fields.includes(line) ? `${line}${'x'.repeat(FIELD_ROOM)}` : line));
  const fits = hookLayout(size, { version: card.version, where: roomy, next: [], footer: '' });
  if (fits === null) return null;

  // Raw mode goes on before the first character is drawn, so nothing typed the moment a prompt shows is echoed.
  // Keys that arrive before the prompts are drawn were not typed at them, so the drain drops all but Ctrl-C.
  let queue = '';
  let draining = true;
  let stoppedEarly = false;
  let feed = () => undefined as void;
  const stopListening = screen.listen((key) => {
    if (draining) {
      if (key.includes(CTRL_C)) stoppedEarly = true;
      return;
    }
    queue += key;
    feed();
  });
  if (stopListening === null) return null;
  await screen.wait(KEY_DRAIN_MS);
  draining = false;

  const color = greenFor(io.env);
  const mark = `${color}${BOLD}Siren${RESET} ${card.version}`;
  const text = [mark, ...lines];
  const statusAt = text.length - 1;
  const top = fits === 'side' ? Math.max(0, Math.floor((HOOK_ROWS - text.length) / 2)) : 0;
  const besideRows = fits === 'side' ? Math.max(HOOK_ROWS, top + text.length) : HOOK_ROWS;
  const height = besideRows + (fits === 'stacked' ? 1 + text.length : 0);
  /** The block row and the first column, from 0, of each text line. */
  const rowOf = (line: number) => (fits === 'side' ? top + line : besideRows + 1 + line);
  const textColumn = fits === 'side' ? INDENT.length + HOOK_WIDTH + GAP.length : INDENT.length;
  const frameAt = (index: number): LogoFrame => ({ rows: liftFrame(HOOK_FRAMES[Math.max(0, Math.min(index, HOOK_FRAMES.length - 1))] ?? [], 0), shadow: 0 });
  const blank: LogoFrame = { rows: liftFrame(HOOK_FRAMES[0] ?? [], 0).map((row) => ' '.repeat([...row].length)), shadow: 0 };

  let status = '';
  let current = frameAt(APART);
  /** The block row the cursor is on. Under the block it is `height`. */
  let cursorRow = height;
  let cursorShown = false;
  const logoRow = (frame: LogoFrame, row: number) => `${color}${frame.rows[row] ?? ''.padEnd(HOOK_WIDTH)}${RESET}`;
  const lineOf = (index: number) => (index === statusAt ? status : text[index] ?? '');
  const block = (): string => {
    let out = '';
    for (let row = 0; row < height; row++) {
      if (row >= besideRows) {
        const index = row - besideRows - 1;
        const line = index < 0 ? '' : lineOf(index);
        out += `${CLEAR_LINE}${line === '' ? '' : `${INDENT}${line}`}\n`;
        continue;
      }
      const logo = row < HOOK_ROWS - 1 ? logoRow(current, row) : ' '.repeat(HOOK_WIDTH);
      const index = row - top;
      const beside = fits === 'side' && index >= 0 && index < text.length ? lineOf(index) : '';
      out += `${CLEAR_LINE}${INDENT}${logo}${beside === '' ? '' : `${GAP}${beside}`}\n`;
    }
    return out;
  };
  const vertical = (from: number, to: number) => (to < from ? `\u001b[${from - to}A` : to > from ? `\u001b[${to - from}B` : '');
  const column = (at: number) => `\u001b[${at + 1}G`;
  // The logo's columns and the status line, between a saved and a restored cursor, so the prompt's line is never touched.
  const paint = (frame: LogoFrame) => {
    current = frame;
    let out = `${HIDE_CURSOR}${SAVE_CURSOR}`;
    let at = cursorRow;
    for (let row = 0; row < HOOK_ROWS - 1; row++) {
      out += `${vertical(at, row)}\r${INDENT}${logoRow(frame, row)}`;
      at = row;
    }
    out += `${vertical(at, rowOf(statusAt))}${column(textColumn)}${status}\u001b[K`;
    out += `${RESTORE_CURSOR}${cursorShown ? SHOW_CURSOR : ''}`;
    screen.write(out);
  };
  const moveTo = (row: number, col: number) => {
    screen.write(`${vertical(cursorRow, row)}${column(col)}`);
    cursorRow = row;
  };

  let closed = false;
  const forgetExit = screen.atExit(() => screen.write(`${RESET}${SHOW_CURSOR}`));
  let stopTimer = () => undefined as void;
  const close = () => {
    if (closed) return;
    closed = true;
    stopTimer();
    stopListening();
    screen.write(`${vertical(cursorRow, height)}\r${SHOW_CURSOR}`);
    cursorRow = height;
    forgetExit();
  };

  // The prompt being read, the phase after the password, and how a Ctrl-C ends it.
  interface Reading {
    secret: boolean;
    typed: string;
    column: number;
    resolve(line: string): void;
    reject(error: Error): void;
  }
  let reading: Reading | null = null;
  let phase: 'asking' | 'waiting' | 'ending' = 'asking';
  let onStop: ((error: Error) => void) | null = null;
  let afterReturn = false;
  const stop = (error: Error) => {
    close();
    const read = reading;
    reading = null;
    read?.reject(error);
    onStop?.(error);
  };
  const showField = (read: Reading) => {
    if (read.secret) return;
    const room = Math.max(1, size.columns - read.column - 1);
    const shown = [...read.typed].slice(-room).join('');
    screen.write(`${column(read.column)}${shown}\u001b[K`);
  };
  feed = () => {
    while (queue !== '' && !closed) {
      if (queue.startsWith('\u001b')) {
        queue = queue.slice(ESCAPE_SEQUENCE.exec(queue)?.[0].length || 1);
        continue;
      }
      const char = String.fromCodePoint(queue.codePointAt(0)!);
      if (char === CTRL_C) {
        queue = '';
        if (phase === 'ending') return;
        return stop(
          phase === 'waiting'
            ? new CliRefusal('Stopped logging in.', { why: 'You pressed Ctrl-C, so the tool kept no session.', fixText: 'Run siren login --password again when you are ready.' })
            : new CliRefusal('Stopped.', { why: 'You pressed Ctrl-C, so nothing was sent.', fixText: 'Run the command again when you are ready.' }),
        );
      }
      if (phase !== 'asking') {
        // After the password, only Ctrl-C counts.
        queue = queue.slice(char.length);
        continue;
      }
      // Between two prompts the keys wait for the next one, so nothing typed ahead is lost.
      if (reading === null) return;
      queue = queue.slice(char.length);
      const read = reading;
      const wasReturn = afterReturn;
      afterReturn = char === '\r';
      if (char === '\n' && wasReturn) continue;
      if (char === '\r' || char === '\n' || char === '\u0004') {
        reading = null;
        read.resolve(read.typed);
        continue;
      }
      if (char === '\u007f' || char === '\b') read.typed = [...read.typed].slice(0, -1).join('');
      else if (char === '\u0015') read.typed = '';
      else if (char >= ' ') read.typed += char;
      else continue;
      showField(read);
    }
  };
  const ask = (question: string, secret: boolean) =>
    new Promise<string>((resolve, reject) => {
      if (closed) return reject(new CliRefusal('Stopped.', { why: 'You pressed Ctrl-C, so nothing was sent.', fixText: 'Run the command again when you are ready.' }));
      const line = text.indexOf(question);
      const at = line < 0 ? text.indexOf(PASSWORD_PROMPT) : line;
      const read: Reading = { secret, typed: '', column: textColumn + question.length, resolve, reject };
      moveTo(rowOf(at), read.column);
      cursorShown = true;
      screen.write(SHOW_CURSOR);
      reading = read;
      feed();
    });

  screen.write(HIDE_CURSOR);
  screen.write(block());
  if (stoppedEarly) queue = CTRL_C;
  let tick = 0;
  stopTimer = screen.every(HOOK_FRAME_MS, () => {
    tick += 1;
    if (phase === 'waiting') status = `${color}${SPIN[tick % SPIN.length]}${RESET} Logging in`;
    paint(frameAt(APART + APART_DRIFT[tick % APART_DRIFT.length]!));
  });

  const hide = () => {
    cursorShown = false;
    screen.write(HIDE_CURSOR);
  };
  return {
    prompt: (question) => ask(question, false),
    promptSecret: (question) => ask(question, true),
    async during(work) {
      if (closed) return work;
      phase = 'waiting';
      queue = '';
      hide();
      status = `${color}${SPIN[0]}${RESET} Logging in`;
      paint(current);
      return new Promise((resolve, reject) => {
        onStop = reject;
        work.then(resolve, reject);
      });
    },
    // Both endings are drawn at once, so the next lines and the shell's prompt never wait on the logo.
    async approved(line) {
      if (closed) return;
      phase = 'ending';
      stopTimer();
      hide();
      status = `${color}✓${RESET} ${line}`;
      paint(hookSequence().at(-1)!);
      close();
      await rememberPlayed(io);
    },
    async failed() {
      if (closed) return;
      phase = 'ending';
      stopTimer();
      hide();
      status = '';
      paint(blank);
      close();
    },
  };
}
