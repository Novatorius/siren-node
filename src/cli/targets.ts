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
 * - None of the three: `SIREN_BASE_URL` from the environment when set, else
 *   {@link SANDBOX_BASE_URL}. A command never reaches the live deployment
 *   unless the person typed `--live`.
 *
 * Throws {@link CliUsageError} for `--sandbox` with `--live` or with
 * `--base-url`, and for an address the rules refuse, `SIREN_BASE_URL`
 * included, before anything is sent. No message quotes the address.
 */
export function resolveTarget(flags: TargetFlags, env: Readonly<Record<string, string | undefined>>): Target {
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
  } else {
    chosen = flags.live ? LIVE_BASE_URL : SANDBOX_BASE_URL;
    source = flags.live ? '--live' : 'the default';
  }

  return { baseUrl: checkedAddress(chosen, source), live: flags.live === true };
}

/**
 * The address with no trailing slash, or {@link CliUsageError} naming where
 * it came from: one `new Siren()` would refuse as `baseUrl`, or plain http to
 * a host that is not on this machine.
 */
function checkedAddress(address: string, source: string): string {
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

/**
 * The guard that keeps the sandbox and live apart, run before a command
 * sends anything that needs a session, and by `signup` and `login` before
 * they send a password.
 *
 * - An `edition` of `production` without `target.live` is refused: the
 *   person must type `--live` on every command that reaches a live
 *   organization, whatever address chose it.
 * - An `edition` of `sandbox` with `target.live` is refused, so `--live`
 *   always means a live organization.
 *
 * Throws {@link CliRefusal} with a message that names the address and the
 * edition.
 */
export function assertEditionAllowed(target: Target, edition: Edition): void {
  if (edition === 'production' && !target.live) {
    throw new CliRefusal(`${target.baseUrl} is a live Siren. Add --live to act on a live organization.`);
  }
  if (edition === 'sandbox' && target.live) {
    throw new CliRefusal(`${target.baseUrl} is a sandbox Siren, and --live is only for a live one. Leave --live out.`);
  }
}

/** A command line the tool cannot run. `runCli` prints the message and the usage line and answers exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** A command the tool refuses or that Siren refused. `runCli` prints the message and answers exit code 1. */
export class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefusal';
  }
}
