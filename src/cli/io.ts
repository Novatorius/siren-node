import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { FetchHttpClient } from '../http';
import type { HttpClient } from '../http';
import { CliRefusal } from './targets';

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
export const CLI_CLIENT = 'siren-cli/0.3.0';

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
    prompt: askVisible,
    promptSecret: askHidden,
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
    listen: (onKey) => {
      const input = process.stdin;
      if (input.isTTY !== true) return null;
      const wasRaw = input.isRaw;
      const onData = (chunk: Buffer | string) => onKey(chunk.toString());
      input.setRawMode(true);
      input.on('data', onData);
      input.resume();
      return () => {
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
  return new CliRefusal('Stopped.');
}

/** Asks on standard error and answers the line typed, through `node:readline`. */
function askVisible(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.once('SIGINT', () => {
      rl.close();
      process.stderr.write('\n');
      reject(stopped());
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
 * off, and the terminal shows what they typed. The email prompt before this
 * one leaves the terminal echoing, as readline does when it closes.
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    let typed = '';
    let done = false;
    const wasRaw = input.isRaw;
    const restore = () => {
      if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      restore();
      input.pause();
      output.write('\n');
      if (error === undefined) resolve(typed);
      else reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(stopped());
        if (char === '\u007f' || char === '\b') typed = [...typed].slice(0, -1).join('');
        else if (char >= ' ') typed += char;
      }
    };
    try {
      // Echo goes off first, and only then does the question appear.
      input.setRawMode(true);
      output.write(question);
      input.on('data', onData);
      input.resume();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
