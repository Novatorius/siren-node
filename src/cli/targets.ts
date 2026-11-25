import { resolveBaseUrl } from '../client';
import { DEFAULT_BASE_URL, SANDBOX_BASE_URL } from '../http';
import type { Edition } from './session-auth';

/** The live deployment of Siren Cloud. */
export const LIVE_BASE_URL = DEFAULT_BASE_URL;
export { SANDBOX_BASE_URL };

/** The only hosts the tool sends a password or a token to over plain http: a Cloud on this machine. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];

/** The flags that choose which Siren a command talks to. */
export interface TargetFlags {
  sandbox?: boolean;
  live?: boolean;
  baseUrl?: string;
}

/** The Siren a command talks to, and whether the person said `--live`. */
export interface Target {
  /** With no trailing slash. Also the key of its session in `credentials.json`. */
  baseUrl: string;
  live: boolean;
  /**
   * The flag that chose the address, as a hint should repeat it: ` --sandbox`,
   * ` --base-url <address>`, or empty when the address came from
   * `SIREN_BASE_URL` or the default, which the next command reads the same way.
   */
  addressFlag: string;
}

/**
 * Chooses the Siren a command talks to.
 *
 * - `--live` alone: `SIREN_BASE_URL` when set, else {@link LIVE_BASE_URL},
 *   so a live UAT Cloud named once in the environment takes `--live` like
 *   the live deployment does.
 * - `--sandbox`: {@link SANDBOX_BASE_URL}.
 * - `--base-url <url>`: that address, with or without `--live`, checked by
 *   the rules `new Siren()` applies to `baseUrl`, and https unless its host
 *   is `localhost`, `127.0.0.1` or `host.docker.internal`, since the tool
 *   sends a password and session tokens to it.
 * - None of the three: `SIREN_BASE_URL` from the environment when set,
 *   else `remembered`, the Siren the last `login`, `signup` or `use` was
 *   for (skipped for `--live` when that one is a sandbox), else {@link SANDBOX_BASE_URL}, or {@link LIVE_BASE_URL} with
 *   `--live`. A command never reaches the live deployment unless the person
 *   typed `--live` or signed in to it.
 *
 * An address may be a bare host, such as `siren.example.com`, which gets
 * `https://`, and one with no path gets `/siren/v1`, as `gh --hostname`
 * takes a host.
 *
 * Throws {@link CliUsageError} for `--sandbox` with `--live` or with
 * `--base-url`, and for an address the rules refuse, `SIREN_BASE_URL`
 * included, before anything is sent. No message quotes the address.
 */
export function resolveTarget(flags: TargetFlags, env: Readonly<Record<string, string | undefined>>, remembered?: { baseUrl: string; live: boolean }): Target {
  if (flags.sandbox && flags.live) throw new CliUsageError('--sandbox and --live name two different Sirens. Pass one of them.');
  if (flags.sandbox && flags.baseUrl !== undefined) throw new CliUsageError('--sandbox and --base-url name two Sirens. Pass one of them.');

  const fromEnv = env.SIREN_BASE_URL === '' ? undefined : env.SIREN_BASE_URL;
  let chosen: string;
  let source: string;
  if (flags.baseUrl !== undefined) {
    chosen = flags.baseUrl;
    source = '--base-url';
  } else if (flags.sandbox) {
    chosen = SANDBOX_BASE_URL;
    source = '--sandbox';
  } else if (fromEnv !== undefined) {
    chosen = fromEnv;
    source = 'SIREN_BASE_URL';
  } else if (remembered !== undefined && (remembered.live || !flags.live)) {
    chosen = remembered.baseUrl;
    source = 'The Siren you signed in to';
  } else {
    chosen = flags.live ? LIVE_BASE_URL : SANDBOX_BASE_URL;
    source = flags.live ? '--live' : 'the default';
  }

  const baseUrl = checkedAddress(chosen, source);
  const addressFlag = flags.baseUrl !== undefined ? ` --base-url ${baseUrl}` : flags.sandbox ? ' --sandbox' : '';
  return { baseUrl, live: flags.live === true, addressFlag };
}

/**
 * The commands that change a live organization, so take `--live` there.
 * Every other command reads, works offline, or, like logout, needs no
 * `--live` (CLI pass 2, finding 8). A test holds this list to the command
 * table's `readsOnly` and `offline` marks.
 */
export const LIVE_WRITES = [
  'signup',
  'login',
  'apps apply',
  'apps answer',
  'apps resend',
  'apps rotate-key',
  'apps rotate-secret',
  'apps add-key',
  'apps on',
  'apps off',
  'apps delete',
] as const;

/** True when `words`, a command and its arguments, start with a command of {@link LIVE_WRITES}. */
function changesLive(words: string): boolean {
  return LIVE_WRITES.some((command) => words === command || words.startsWith(`${command} `));
}

/**
 * A `siren` command line for a hint, with the flags that reach the same
 * Siren: the address flag the person typed, and `--live` when `live`. That
 * is the target's own `--live` for a command that changes a live
 * organization, and never for a read or an offline command, unless the
 * caller says otherwise. A hint that names a command a person cannot run as
 * printed is no help, so every hint that names a command is built here.
 */
export function commandLine(target: Pick<Target, 'addressFlag' | 'live'>, words: string, live: boolean = target.live && changesLive(words)): string {
  return `siren ${words}${target.addressFlag}${live ? ' --live' : ''}`;
}

/** What the tool calls an edition in a message. */
function editionName(edition: Edition): string {
  return edition === 'production' ? 'live' : 'sandbox';
}

/**
 * The guard that keeps a stored session on the Siren it was made for, run on
 * every command that sends anything with a session, after the target's
 * edition was read and before anything else is sent.
 *
 * - A session made for another address is refused. Sessions are kept by
 *   address, so only a file edited by hand gets here.
 * - A session made while the target reported another edition is refused, so
 *   a sandbox session never reaches a Siren that is now live, and a live one
 *   never reaches a Siren that is now a sandbox.
 *
 * Throws {@link CliRefusal} with one line: what the target is, what the
 * session was made for, and the `siren login` that makes a new one.
 */
export function assertSessionMatches(target: Target, session: { edition: Edition; baseUrl?: string }, edition: Edition): void {
  const login = commandLine(target, 'login', edition === 'production');
  if (session.baseUrl !== undefined && session.baseUrl !== target.baseUrl) {
    throw new CliRefusal(`The session stored for ${target.baseUrl} was made for ${session.baseUrl}, so nothing was sent with it. Run ${login} to sign in again.`);
  }
  if (session.edition !== edition) {
    throw new CliRefusal(
      `${target.baseUrl} is now a ${editionName(edition)} Siren, and your session was made when it was a ${editionName(session.edition)} one, ` +
        `so nothing was sent with it. Run ${login} to sign in again.`,
    );
  }
}

/**
 * The address with no trailing slash, or {@link CliUsageError} naming where
 * it came from: one `new Siren()` would refuse as `baseUrl`, or plain http to
 * a host that is not on this machine.
 */
function checkedAddress(given: string, source: string): string {
  const address = fullAddress(given);
  try {
    resolveBaseUrl(address);
  } catch {
    throw new CliUsageError(`${source} must be an http or https address such as ${SANDBOX_BASE_URL}, with no user name, query or fragment.`);
  }
  const url = new URL(address);
  if (url.protocol === 'http:' && !LOCAL_HOSTS.includes(url.hostname)) {
    throw new CliUsageError(
      `${source} must use https. The tool sends your password and session over it, so it takes plain http only for ${LOCAL_HOSTS.join(', ')}.`,
    );
  }
  return address.replace(/\/+$/, '');
}

/** The API path every Siren serves its routes under. */
const API_PATH = '/siren/v1';

/** `https://` before a bare host, and {@link API_PATH} after an address with no path. Anything else as given. */
function fullAddress(given: string): string {
  const trimmed = given.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return given;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return withScheme;
  return `${withScheme.replace(/\/+$/, '')}${API_PATH}`;
}

/**
 * The guard that keeps the sandbox and live apart, run on the edition the
 * target reports now, read at the start of every command that sends
 * anything, and before `signup` and `login` send a password.
 *
 * - An `edition` of `production` without `target.live` is refused: the
 *   person must type `--live` on every command that reaches a live
 *   organization, whatever address chose it.
 * - An `edition` of `sandbox` with `target.live` is refused, so `--live`
 *   always means a live organization.
 *
 * Throws {@link CliRefusal} with a message that names the address, the
 * edition, and `action`, what `--live` would let the command do.
 */
export function assertEditionAllowed(target: Target, edition: Edition, action = 'change a live organization'): void {
  if (edition === 'production' && !target.live) {
    throw new CliRefusal(`${target.baseUrl} is a live Siren. Add --live to ${action}.`);
  }
  if (edition === 'sandbox' && target.live) {
    throw new CliRefusal(`${target.baseUrl} is a sandbox Siren, and --live is only for a live one. Leave --live out.`);
  }
}

/** A command line the tool cannot run. `runCli` prints the message and the usage line and answers exit code 2. */
export class CliUsageError extends Error {
  /** The message without its guess, for the styled form, which shows the guess on its own line. */
  readonly headline: string;
  /** What the person likely meant, such as `siren apps apply` or `--email`. */
  readonly guesses: readonly string[];

  /** `message` alone, or a headline and guesses, which the plain form joins as "<headline> Did you mean "<guess>"?". */
  constructor(message: string, guesses: readonly string[] = [], quoted = true) {
    const mark = (guess: string) => (quoted ? `"${guess}"` : guess);
    super(guesses.length === 0 ? message : `${message} Did you mean ${guesses.map(mark).join(' or ')}?`);
    this.name = 'CliUsageError';
    this.headline = message;
    this.guesses = guesses;
  }
}

/**
 * The parts of a refusal beyond its headline (Alex's ruling M108): why it
 * happened, the command that fixes it with the words after it, a dim note
 * that always shows, and detail that shows only with --verbose.
 */
export interface RefusalParts {
  why?: string;
  /** A command to run, such as `siren login`, printed as "Run siren login <fixWords>." */
  fix?: string;
  /** The words before the command in place of "Run", such as "Check your inbox for the set-up email, or run". */
  fixLead?: string;
  fixWords?: string;
  note?: string;
  detail?: readonly string[];
}

/**
 * A command the tool refuses or that Siren refused. `runCli` prints it
 * through the style module and answers exit code 1. `message` is the plain
 * one-line form: the headline, the why, and "Run <fix> <fixWords>."
 */
export class CliRefusal extends Error {
  readonly headline: string;
  readonly parts: RefusalParts;

  constructor(headline: string, parts: RefusalParts = {}) {
    const fix = parts.fix === undefined ? [] : [`${parts.fixLead ?? 'Run'} ${parts.fix}${parts.fixWords === undefined ? '' : ` ${parts.fixWords}`}.`];
    super([headline, ...(parts.why === undefined ? [] : [parts.why]), ...fix].join(' '));
    this.name = 'CliRefusal';
    this.headline = headline;
    this.parts = parts;
  }
}

/**
 * The one line `--verbose` adds under an error from Siren: its HTTP status,
 * its code when it names one, and the host it came from, such as
 * `HTTP 401 · sandbox.sirenaffiliates.com`. Never a token or a body.
 */
export function httpDetail(error: { statusCode?: number; code?: string }, baseUrl: string | undefined): string[] {
  const parts = [
    ...(error.statusCode === undefined ? [] : [`HTTP ${error.statusCode}`]),
    ...(error.code === undefined ? [] : [error.code]),
    ...(baseUrl === undefined ? [] : [new URL(baseUrl).host]),
  ];
  return parts.length === 0 ? [] : [parts.join(' · ')];
}
