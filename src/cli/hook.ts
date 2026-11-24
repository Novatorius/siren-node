import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_FRAMES, HOOK_FRAME_MS, HOOK_WIDTH } from './hook-frames';
import type { CliIo, CliScreen } from './io';

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
const CTRL_C = '\u0003';
const INDENT = '  ';

/** Why the hook does not play. Each one is checked before anything is drawn or waited on. */
export type HookSkip = 'not-a-terminal' | 'ci' | 'no-color' | 'dumb-terminal' | 'quiet' | 'json' | 'too-small' | 'no-braille';

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
 * since the old console draws no braille.
 */
export function hookSkip(screen: CliScreen | undefined, env: Readonly<Record<string, string | undefined>>, flags: HookFlags): HookSkip | null {
  if (screen === undefined || screen.size === null) return 'not-a-terminal';
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0') return 'ci';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'no-color';
  if (env.TERM === 'dumb') return 'dumb-terminal';
  if (flags.quiet) return 'quiet';
  if (flags.json) return 'json';
  const height = HOOK_FRAMES[0]?.length ?? 0;
  if (screen.size.columns < HOOK_WIDTH + INDENT.length * 2 || screen.size.rows < height + 4) return 'too-small';
  if (screen.platform === 'win32' && !env.WT_SESSION) return 'no-braille';
  return null;
}

/** How the hook ended: every frame drawn, a key pressed to skip to the still logo, or Ctrl-C. */
export type HookEnd = 'played' | 'skipped' | 'interrupted';

/**
 * Plays the hook on the screen: hides the cursor, draws each frame
 * {@link HOOK_FRAME_MS} apart over the one before, and shows the cursor
 * again however it ends, also when the process exits mid-way. Any key draws
 * the still logo at once. Ctrl-C stops it where it is. When standard input
 * is a terminal it reads keys in raw mode and gives the mode back at the
 * end. Otherwise it plays to the end, about 1.2 seconds, and never reads
 * standard input, which may hold a piped password.
 */
export async function playHook(screen: CliScreen, env: Readonly<Record<string, string | undefined>>): Promise<HookEnd> {
  const color = greenFor(env);
  const height = HOOK_FRAMES[0]?.length ?? 0;
  const last = HOOK_FRAMES.length - 1;
  const draw = (index: number, over: boolean) => {
    const lines = (HOOK_FRAMES[index] ?? []).map((line) => `${CLEAR_LINE}${INDENT}${color}${line}${RESET}\n`).join('');
    screen.write(`${over ? `\u001b[${height}A` : ''}${lines}`);
  };

  const keys: { pressed: string | null } = { pressed: null };
  screen.write(HIDE_CURSOR);
  const forgetExit = screen.atExit(() => screen.write(`${RESET}${SHOW_CURSOR}`));
  const stopListening = screen.listen((key) => {
    keys.pressed ??= key;
  });
  let end: HookEnd = 'played';
  try {
    draw(0, false);
    for (let index = 1; index <= last; index++) {
      await screen.wait(HOOK_FRAME_MS);
      if (keys.pressed === CTRL_C) {
        end = 'interrupted';
        break;
      }
      if (keys.pressed !== null) {
        draw(last, true);
        end = 'skipped';
        break;
      }
      draw(index, true);
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

/** True when any Siren session is kept on this machine, read without refusing anything. */
async function signedInSomewhere(io: CliIo): Promise<boolean> {
  try {
    const file = JSON.parse(await readFile(join(io.configDir, 'credentials.json'), 'utf8')) as { sessions?: Record<string, unknown> };
    return Object.keys(file.sessions ?? {}).length > 0;
  } catch {
    return false;
  }
}

/** The wordmark line and the next step under it, in green when the hook played. */
function wordmark(version: string, nextStep: string, color: string | null): string {
  const name = color === null ? 'Siren' : `${color}${BOLD}Siren${RESET}`;
  return `\n${INDENT}${name} ${version}\n${INDENT}${nextStep}\n\n`;
}

/**
 * What `siren` with nothing after it does: plays the hook when it may, then
 * prints the wordmark and the next step, to sign in or to declare an app.
 * Answers the exit code, 0, or 130 after Ctrl-C.
 */
export async function welcome(io: CliIo, flags: HookFlags, version: string): Promise<number> {
  const plays = hookSkip(io.screen, io.env, flags) === null && io.screen !== undefined;
  if (plays) {
    const end = await playHook(io.screen!, io.env);
    await rememberPlayed(io);
    if (end === 'interrupted') return 130;
  }
  const next = (await signedInSomewhere(io))
    ? 'Next: run siren apps init in your app\'s folder. Run siren --help to see every command.'
    : 'Next: run siren login, or siren signup for a new organization. Run siren --help to see every command.';
  io.stdout(wordmark(version, next, plays ? greenFor(io.env) : null));
  return 0;
}

/**
 * Plays the hook before the first command a person runs on this machine, and
 * answers false when they pressed Ctrl-C during it, so the command does not
 * run. Plays nothing, waits on nothing and remembers nothing when the hook
 * may not play here, so the first run in a terminal still gets it.
 */
export async function firstRun(io: CliIo, flags: HookFlags, version: string): Promise<boolean> {
  if (hookSkip(io.screen, io.env, flags) !== null || io.screen === undefined) return true;
  if (await hasPlayed(io)) return true;
  const end = await playHook(io.screen, io.env);
  await rememberPlayed(io);
  if (end === 'interrupted') return false;
  io.stdout(wordmark(version, 'Run siren --help any time to see every command.', greenFor(io.env)));
  return true;
}
