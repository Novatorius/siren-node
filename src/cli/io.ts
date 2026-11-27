import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { FetchHttpClient } from '../http';
import type { HttpClient } from '../http';
import { CliRefusal } from './targets';
import { CLI_VERSION } from './version';

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
  /**
   * Turns echo off and drops keys until a prompt reads, for a command about
   * to ask for a password, and answers a function that gives the mode back.
   * Absent, as in tests, nothing changes. See {@link quietKeys}.
   */
  holdKeys?(): () => void;
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
  /** Waits between reads, for `logs tail` and `apps requests --follow`. */
  sleep(ms: number): Promise<void>;
  /** Aborted when the person presses Ctrl-C. Ends `logs tail` and `apps requests --follow` with exit code 130. */
  readonly signal?: AbortSignal;
  /**
   * The terminal the Siren hook plays on (see `hook.ts`). Absent, as in most
   * tests, the hook never plays.
   */
  readonly screen?: CliScreen;
  /** True when standard output is a terminal, so the style module may color it. Absent, as in tests, it is plain. */
  readonly stdoutTty?: boolean;
  /** True when standard error is a terminal. */
  readonly stderrTty?: boolean;
  /** This machine's name, which the browser sign-in shows on the approval page as "Siren CLI on <machine>". */
  readonly machine?: string;
  /**
   * Opens an http or https address in the person's browser, and answers
   * true when a browser was started. Absent, or answering false, the tool
   * prints the address for the person to open.
   */
  openUrl?(url: string): Promise<boolean>;
}

/**
 * What the hook animation needs from the terminal standard output writes
 * to. {@link nodeIo} builds it on `process.stdout` and `process.stdin`.
 */
export interface CliScreen {
  /** The terminal's columns and rows, or null when standard output is not a terminal. */
  readonly size: { columns: number; rows: number } | null;
  readonly platform: NodeJS.Platform;
  /** Writes to standard output as given. */
  write(text: string): void;
  /** Waits between frames. */
  wait(ms: number): Promise<void>;
  /**
   * Calls `tick` every `ms` until the answered function is called, for an
   * animation that runs while the tool does other work, such as reading a
   * prompt. The timer never keeps the process alive by itself.
   */
  every(ms: number, tick: () => void): () => void;
  /**
   * When standard input is a terminal, puts it in raw mode and calls
   * `onKey` with each key typed, Ctrl-C included, and answers a function
   * that stops reading and gives the mode back. Answers null, and reads
   * nothing, when standard input is not a terminal.
   */
  listen(onKey: (key: string) => void): (() => void) | null;
  /** Runs `fn` if the process exits before the answered function is called. */
  atExit(fn: () => void): () => void;
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

/** What the tool calls itself to Siren, so Siren's API request log can tell its calls from the dashboard's. */
export const CLI_CLIENT = `siren-cli/${CLI_VERSION}`;

/**
 * `client` with an `X-Siren-Client` header on every request, so Siren's API
 * request log names the call's source `cli` (contract/devtools-logs.md,
 * section 4.3). The header names the tool and its version, nothing more.
 */
export function namedClient(client: HttpClient): HttpClient {
  return { send: (request) => client.send({ ...request, headers: { ...request.headers, 'X-Siren-Client': CLI_CLIENT } }) };
}

/**
 * The real terminal: `process.stdout` and `process.stderr`, the process
 * environment and folder, a {@link FetchHttpClient}, the real clock, and a
 * signal that Ctrl-C aborts.
 *
 * Prompts write their question to standard error, so standard output keeps
 * only results. Ctrl-C at a prompt stops the command with exit code 1 and
 * leaves the terminal as it was. Ctrl-C at any other time aborts `signal`
 * when something listens for it, as `apps requests --follow` and `sleep`
 * do, and otherwise ends the process with exit code 130. A second Ctrl-C
 * always ends it.
 */
export function nodeIo(): CliIo {
  const controller = new AbortController();
  process.on('SIGINT', () => {
    const listening = getEventListeners(controller.signal, 'abort').length > 0;
    if (controller.signal.aborted || !listening) process.exit(130);
    controller.abort();
  });
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: (question) => askVisible(question),
    promptSecret: (question) => askHidden(question),
    holdKeys: () => quietKeys(),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
    env: process.env,
    cwd: process.cwd(),
    configDir: defaultConfigDir(process.env),
    httpClient: namedClient(new FetchHttpClient()),
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) return resolve();
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        controller.signal.addEventListener('abort', done);
      }),
    signal: controller.signal,
    screen: nodeScreen(),
    stdoutTty: process.stdout.isTTY === true,
    stderrTty: process.stderr.isTTY === true,
    machine: hostname(),
    openUrl: (url) => openInBrowser(url, process.env, process.platform),
  };
}

/**
 * Starts the system's opener on `url`, given as one argument and never
 * through a shell: `open` on macOS, `rundll32` on Windows, `xdg-open`
 * elsewhere. Opens nothing over SSH or on a Linux machine with no display,
 * where no browser would reach the person, and answers false.
 */
function openInBrowser(url: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return Promise.resolve(false);
  if (env.SSH_CONNECTION || env.SSH_TTY) return Promise.resolve(false);
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.resolve(false);
  const [command, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore', shell: false });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** The real terminal for the hook, read once when the command starts. */
function nodeScreen(): CliScreen {
  const out = process.stdout;
  return {
    size: out.isTTY === true ? { columns: out.columns ?? 80, rows: out.rows ?? 24 } : null,
    platform: process.platform,
    write: (text) => {
      out.write(text);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    every: (ms, tick) => {
      const timer = setInterval(tick, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
    listen: (onKey) => {
      const input = process.stdin;
      if (input.isTTY !== true) return null;
      const wasRaw = input.isRaw;
      const onData = (chunk: Buffer | string) => onKey(chunk.toString());
      const stopReading = readingKeys();
      input.setRawMode(true);
      input.on('data', onData);
      input.resume();
      return () => {
        stopReading();
        input.off('data', onData);
        if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
        input.pause();
      };
    },
    atExit: (fn) => {
      process.on('exit', fn);
      return () => {
        process.off('exit', fn);
      };
    },
  };
}

/** The error a prompt answers when the person presses Ctrl-C at it. */
function stopped(): CliRefusal {
  return new CliRefusal('Stopped.', { why: 'You pressed Ctrl-C, so nothing was sent.', fixText: 'Run the command again when you are ready.' });
}

/**
 * How long a prompt reads and drops what standard input holds, with echo
 * already off, before it writes its question. Keys typed before a question
 * appears were never an answer to it, and may be a password typed early.
 */
export const KEY_DRAIN_MS = 20;

/** How many readers take keys from standard input right now: prompts, and the screen's listeners. */
let keyReaders = 0;

/**
 * Turns the terminal's echo off now and drops every key typed until a
 * prompt or the screen reads, and answers a function that gives the mode
 * back. A command that will ask for a password calls it first, before it
 * draws or sends anything, so a password typed early, while the command
 * starts or waits on Siren, is neither echoed nor taken as an answer. Keys
 * typed before the tool started were echoed by the terminal already, and
 * are dropped too. Ctrl-C while nothing reads keys stops the command, as it
 * would with echo on.
 */
export function quietKeys(input: NodeJS.ReadStream = process.stdin): () => void {
  if (input.isTTY !== true) return () => undefined;
  const wasRaw = input.isRaw;
  const drop = (chunk: Buffer | string) => {
    if (keyReaders === 0 && chunk.toString().includes('\u0003')) process.kill(process.pid, 'SIGINT');
  };
  input.setRawMode(true);
  input.on('data', drop);
  input.resume();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    input.off('data', drop);
    if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    input.pause();
  };
}

/** Counts a reader of keys until the answered function is called. */
export function readingKeys(): () => void {
  keyReaders += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    keyReaders -= 1;
  };
}


/** Asks on standard error and answers the line typed, showing what is typed. See {@link askHidden}. */
export function askVisible(
  question: string,
  input: Pick<NodeJS.ReadStream, 'isRaw' | 'setRawMode' | 'on' | 'off' | 'resume' | 'pause'> = process.stdin,
  output: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
  drainMs = KEY_DRAIN_MS,
): Promise<string> {
  return askRaw(question, false, input, output, drainMs);
}

/**
 * Asks on standard error and answers the line typed, echoing nothing. It
 * puts the terminal in raw mode before it writes the question, so no
 * character is shown and Ctrl-C reaches it as a character, and puts the mode
 * back however the prompt ends. Backspace removes the last character. Enter
 * or Ctrl-D ends the line.
 *
 * The order matters. `setRawMode` waits for the terminal to take the output
 * already written (libuv sets the mode with TCSADRAIN), so a question written
 * first lets a person who types the instant it appears get in before echo is
 * off, and the terminal shows what they typed.
 *
 * Keys that reach the prompt before its question is written are dropped:
 * for {@link KEY_DRAIN_MS} after echo goes off it reads and throws away what
 * standard input holds, and only then writes the question. A key typed
 * before then was not typed at this prompt. It may be a password typed while
 * the command started, which the terminal echoed when it arrived, and which
 * must not then be sent as an answer as well. The email prompt before this
 * one reads in raw mode too, so no gap with echo on lies between the two.
 *
 * The mode goes back as soon as the prompt ends, not only when the process
 * exits, so a command that asks again or keeps running after the prompt
 * leaves the terminal echoing. test/cli-hidden-prompt.test.ts ("gives the
 * mode back after Enter") fails when the restore is removed, mutation
 * e2e-1-mode-not-restored in scripts/mutations/apps-cli-e2e.json.
 */
export function askHidden(
  question: string,
  input: Pick<NodeJS.ReadStream, 'isRaw' | 'setRawMode' | 'on' | 'off' | 'resume' | 'pause'> = process.stdin,
  output: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
  drainMs = KEY_DRAIN_MS,
): Promise<string> {
  return askRaw(question, true, input, output, drainMs);
}

/** An escape sequence a key such as an arrow sends, which a prompt ignores whole. */
const ESCAPE_SEQUENCE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/su;

/** The prompt both {@link askVisible} and {@link askHidden} are: raw mode, a drain, the question, the line. */
function askRaw(
  question: string,
  hidden: boolean,
  input: Pick<NodeJS.ReadStream, 'isRaw' | 'setRawMode' | 'on' | 'off' | 'resume' | 'pause'>,
  output: Pick<NodeJS.WriteStream, 'write'>,
  drainMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let typed = '';
    let done = false;
    let asked = false;
    let afterReturn = false;
    const wasRaw = input.isRaw;
    const stopReading = readingKeys();
    const restore = () => {
      if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off('data', onData);
      stopReading();
      restore();
      input.pause();
      output.write('\n');
      if (error === undefined) resolve(typed);
      else reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      let text = chunk.toString();
      // Before the question is written, only Ctrl-C counts.
      if (!asked) {
        if (text.includes('\u0003')) finish(stopped());
        return;
      }
      while (text !== '') {
        if (text.startsWith('\u001b')) {
          text = text.slice(ESCAPE_SEQUENCE.exec(text)?.[0].length || 1);
          continue;
        }
        const char = String.fromCodePoint(text.codePointAt(0)!);
        text = text.slice(char.length);
        const wasReturn = afterReturn;
        afterReturn = char === '\r';
        if (char === '\n' && wasReturn) continue;
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(stopped());
        if (char === '\u007f' || char === '\b') {
          if (typed === '') continue;
          typed = [...typed].slice(0, -1).join('');
          if (!hidden) output.write('\b \b');
        } else if (char === '\u0015') {
          if (!hidden) output.write('\b \b'.repeat([...typed].length));
          typed = '';
        } else if (char >= ' ') {
          typed += char;
          if (!hidden) output.write(char);
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Echo goes off first, then what standard input already holds is dropped, and only then does the question appear.
      input.setRawMode(true);
      input.on('data', onData);
      input.resume();
      timer = setTimeout(() => {
        if (done) return;
        asked = true;
        output.write(question);
      }, drainMs);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
