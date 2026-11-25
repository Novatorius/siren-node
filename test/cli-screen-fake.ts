import type { CliScreen } from '../src/cli/io';

/** A terminal the logo animation can play on, which records what it was sent. */

export interface FakeScreenOptions {
  /** False when standard output is not a terminal. */
  tty?: boolean;
  columns?: number;
  rows?: number;
  /** False when standard input is not a terminal, so no key can skip. */
  keys?: boolean;
  platform?: NodeJS.Platform;
  /** Presses this key during the wait with this number, from 1. */
  press?: { at: number; key: string };
  /** Types these keys one after another once something listens, each on a later turn of the event loop. */
  type?: readonly string[];
}

export function fakeScreen(options: FakeScreenOptions = {}) {
  const writes: string[] = [];
  const waits: number[] = [];
  /** How many writes came before each wait. */
  const writtenAtWait: number[] = [];
  const log: string[] = [];
  let onKey: ((key: string) => void) | null = null;
  let exitHooks = 0;
  const screen: CliScreen = {
    size: options.tty === false ? null : { columns: options.columns ?? 80, rows: options.rows ?? 24 },
    platform: options.platform ?? 'linux',
    write: (text) => {
      writes.push(text);
    },
    wait: async (ms) => {
      waits.push(ms);
      writtenAtWait.push(writes.length);
      if (options.press && options.press.at === waits.length) onKey?.(options.press.key);
    },
    listen: (callback) => {
      if (options.keys === false) return null;
      onKey = callback;
      log.push('listen');
      const keys = [...(options.type ?? [])];
      const next = () => {
        const key = keys.shift();
        if (key === undefined || onKey === null) return;
        onKey(key);
        setTimeout(next, 0);
      };
      if (keys.length > 0) setTimeout(next, 0);
      return () => {
        onKey = null;
        log.push('stop');
      };
    },
    atExit: () => {
      exitHooks += 1;
      return () => {
        exitHooks -= 1;
      };
    },
  };
  return { screen, writes, waits, writtenAtWait, log, text: () => writes.join(''), pendingExitHooks: () => exitHooks };
}
