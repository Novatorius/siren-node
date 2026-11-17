import type { CliIo } from './io';

/**
 * The version `siren --version` prints, the package's.
 */
export const CLI_VERSION = '0.3.0';

/**
 * The commands, in the order `siren --help` lists them. The architecture
 * note (docs/architecture/apps-cli.md, "The commands") says what each one
 * sends and prints.
 */
export const COMMANDS = [
  'signup',
  'login',
  'logout',
  'orgs',
  'use',
  'apps init',
  'apps apply',
  'apps list',
  'apps show',
  'apps requests',
  'apps answer',
  'apps resend',
  'apps rotate',
  'apps on',
  'apps off',
  'apps delete',
] as const;

/**
 * Runs one `siren` command line and answers its exit code: 0 when it did
 * what was asked, 1 when Siren or the tool refused it, 2 for a command line
 * it cannot read. Every refusal is one line on standard error, and nothing
 * is sent once a check before sending fails.
 *
 * Options are read with `node:util` `parseArgs`, strict, so an unknown
 * flag is a usage error. Every command takes `--sandbox`, `--live` and
 * `--base-url <url>` (see `resolveTarget`), and `--help`.
 *
 * It never prints a password, a session token, an app's API key beyond its
 * 16-character prefix, or a signing secret, except the one case the
 * architecture note names: a key and secret that Siren showed once and the
 * env file could not hold.
 *
 * Stub: prints nothing and answers 0. Packets cli-session, cli-apply and
 * cli-requests build it.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  void argv;
  void io;
  return 0;
}
