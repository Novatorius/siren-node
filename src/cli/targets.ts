import { DEFAULT_BASE_URL, SANDBOX_BASE_URL } from '../http';
import type { Edition } from './session-auth';

/** The live deployment of Siren Cloud. */
export const LIVE_BASE_URL = DEFAULT_BASE_URL;
export { SANDBOX_BASE_URL };

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
 * - `--live` alone: {@link LIVE_BASE_URL}.
 * - `--sandbox`: {@link SANDBOX_BASE_URL}.
 * - `--base-url <url>`: that address, with or without `--live`, checked by
 *   the rules `new Siren()` applies to `baseUrl`.
 * - None of the three: `SIREN_BASE_URL` from the environment when set, else
 *   {@link SANDBOX_BASE_URL}. A command never reaches the live deployment
 *   unless the person typed `--live`.
 *
 * Throws {@link CliUsageError} for `--sandbox` with `--live` or with
 * `--base-url`, and for an address the rules refuse.
 *
 * Stub: answers the sandbox. Packet cli-session.
 */
export function resolveTarget(flags: TargetFlags, env: Readonly<Record<string, string | undefined>>): Target {
  void flags;
  void env;
  return { baseUrl: SANDBOX_BASE_URL, live: false };
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
 * edition. Stub: allows everything. Packet cli-session.
 */
export function assertEditionAllowed(target: Target, edition: Edition): void {
  void target;
  void edition;
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
