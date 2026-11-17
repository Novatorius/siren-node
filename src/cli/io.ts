import { homedir } from 'node:os';
import { join } from 'node:path';
import { FetchHttpClient } from '../http';
import type { HttpClient } from '../http';

/**
 * Everything the `siren` command reads from or writes to the world outside
 * Siren's API, so `runCli` runs the same in a terminal and in a test. The
 * bin entry builds it with {@link nodeIo}. Tests build their own, with a
 * `FakeHttpClient`, a temporary folder and a fixed clock, so no test reaches
 * the network or the developer's home folder.
 */
export interface CliIo {
  /** Writes to standard output as given. The caller ends each line with `\n`. */
  stdout(text: string): void;
  /** Writes to standard error as given. Progress, warnings and refusals go here. */
  stderr(text: string): void;
  /** True when a person can answer a prompt: standard input and output are both terminals. */
  readonly interactive: boolean;
  /** Asks a question on the terminal and answers the line typed. Only called when `interactive`. */
  prompt(question: string): Promise<string>;
  /** As {@link prompt}, with the typed characters hidden. Only called when `interactive`. */
  promptSecret(question: string): Promise<string>;
  /** All of standard input as text, for `--password-stdin`. */
  readStdin(): Promise<string>;
  /** The environment: `SIREN_BASE_URL` and the `${NAME}` values an app file names. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder relative paths start from. */
  readonly cwd: string;
  /** The folder that holds `credentials.json`. See {@link defaultConfigDir}. */
  readonly configDir: string;
  /** Sends every request the command makes to Siren. */
  readonly httpClient: HttpClient;
  /** Milliseconds since the epoch. */
  now(): number;
  /** Waits, for `apps requests --follow`. */
  sleep(ms: number): Promise<void>;
  /** Aborted when the person presses Ctrl-C. Ends `apps requests --follow` with exit code 0. */
  readonly signal?: AbortSignal;
}

/**
 * Where `credentials.json` lives: `SIREN_CONFIG_DIR` when set, else
 * `%APPDATA%\siren` on Windows, else `$XDG_CONFIG_HOME/siren`, else
 * `~/.config/siren`.
 */
export function defaultConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.SIREN_CONFIG_DIR) return env.SIREN_CONFIG_DIR;
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'siren');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'siren');
  return join(home, '.config', 'siren');
}

/**
 * The real terminal: `process.stdout` and `process.stderr`, the process
 * environment and folder, a {@link FetchHttpClient}, the real clock, and a
 * signal that Ctrl-C aborts.
 *
 * Stub: `prompt`, `promptSecret` and `readStdin` answer an empty string and
 * `interactive` is false. Packet cli-session builds them with
 * `node:readline`, hiding typed characters for `promptSecret`.
 */
export function nodeIo(): CliIo {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    interactive: false,
    prompt: async () => '',
    promptSecret: async () => '',
    readStdin: async () => '',
    env: process.env,
    cwd: process.cwd(),
    configDir: defaultConfigDir(process.env),
    httpClient: new FetchHttpClient(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    signal: controller.signal,
  };
}
