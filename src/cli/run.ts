import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import * as apply from './commands/apply';
import * as requests from './commands/requests';
import * as session from './commands/session';
import { CommandContext } from './context';
import type { CommandHandler } from './context';
import type { CliIo } from './io';
import { CliUsageError, commandLine, resolveTarget } from './targets';

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
  'apps rotate-key',
  'apps rotate-secret',
  'apps on',
  'apps off',
  'apps delete',
] as const;

/** One of {@link COMMANDS}. */
export type Command = (typeof COMMANDS)[number];

type Options = NonNullable<ParseArgsConfig['options']>;

/** One command's line: its options, how many arguments follow its words, and its body. */
interface CommandSpec {
  /** The command with its arguments and options, as `--help` prints it. */
  usage: string;
  summary: string;
  options: Options;
  /** The fewest and the most arguments after the command words. */
  positionals: readonly [number, number];
  /** True for a command that sends nothing and so needs no Siren address. */
  offline?: boolean;
  run: CommandHandler;
}

/** The options every command takes. */
const GLOBAL: Options = {
  sandbox: { type: 'boolean' },
  live: { type: 'boolean' },
  'base-url': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const SPECS: Record<Command, CommandSpec> = {
  signup: {
    usage: 'signup [--org-name <name>] [--email <address>] [--password-stdin] [--accept-terms]',
    summary: 'Make an organization on Siren and sign in to it.',
    options: { 'org-name': { type: 'string' }, email: { type: 'string' }, 'password-stdin': { type: 'boolean' }, 'accept-terms': { type: 'boolean' } },
    positionals: [0, 0],
    run: session.signup,
  },
  login: {
    usage: 'login [--email <address>] [--org <slug or id>] [--password-stdin]',
    summary: 'Sign in, and keep the session for the other commands.',
    options: { email: { type: 'string' }, org: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
    positionals: [0, 0],
    run: session.login,
  },
  logout: { usage: 'logout', summary: 'Sign out, and forget the session on this machine.', options: {}, positionals: [0, 0], run: session.logout },
  orgs: { usage: 'orgs', summary: 'List your organizations, * on the one in use.', options: {}, positionals: [0, 0], run: session.orgs },
  use: { usage: 'use <slug or id>', summary: 'Switch to another of your organizations.', options: {}, positionals: [1, 1], run: session.use },
  'apps init': {
    usage: 'apps init [--key <app key>] [--name <name>]',
    summary: 'Write siren.app.json here, and keep .env.* files out of git.',
    options: { key: { type: 'string' }, name: { type: 'string' } },
    positionals: [0, 0],
    offline: true,
    run: apply.appsInit,
  },
  'apps apply': {
    usage: 'apps apply [file] [--yes]',
    summary: 'Show what siren.app.json changes, ask, then declare the app and save its key beside the file.',
    options: { yes: { type: 'boolean' } },
    positionals: [0, 1],
    run: apply.appsApply,
  },
  'apps list': { usage: 'apps list [--json]', summary: 'List the apps and their items.', options: { json: { type: 'boolean' } }, positionals: [0, 0], run: apply.appsList },
  'apps show': { usage: 'apps show <key> [--json]', summary: 'Show one app and its items.', options: { json: { type: 'boolean' } }, positionals: [1, 1], run: apply.appsShow },
  'apps requests': {
    usage: 'apps requests [<request id>] [--app <key>] [--attention] [--follow]',
    summary: 'List what Siren sent the apps, or show one request with each send and answer.',
    options: { app: { type: 'string' }, attention: { type: 'boolean' }, follow: { type: 'boolean' } },
    positionals: [0, 1],
    run: requests.appsRequests,
  },
  'apps answer': {
    usage: 'apps answer <request id> (--body <json> | --file <path>)',
    summary: 'Answer an ask by hand, as a signed-in admin.',
    options: { body: { type: 'string' }, file: { type: 'string' } },
    positionals: [1, 1],
    run: requests.appsAnswer,
  },
  'apps resend': { usage: 'apps resend <request id>', summary: 'Send a request again.', options: {}, positionals: [1, 1], run: requests.appsResend },
  'apps rotate': {
    usage: 'apps rotate <key>',
    summary: 'Gone: run apps rotate-key or apps rotate-secret, since the key and the secret change apart.',
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    positionals: [1, 1],
    offline: true,
    run: apply.appsRotate,
  },
  'apps rotate-key': {
    usage: 'apps rotate-key <key> [--app-file <path>] [--yes]',
    summary: 'Give the app a new key, revoke the old one, and save it where apply saved the first.',
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    positionals: [1, 1],
    run: apply.appsRotateKey,
  },
  'apps rotate-secret': {
    usage: 'apps rotate-secret <key> [--app-file <path>] [--yes]',
    summary: "Give the app's address a new signing secret, and save it where apply saved the first.",
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    positionals: [1, 1],
    run: apply.appsRotateSecret,
  },
  'apps on': { usage: 'apps on <key>', summary: 'Turn the app on.', options: {}, positionals: [1, 1], run: apply.appsOn },
  'apps off': { usage: 'apps off <key>', summary: 'Turn the app off. Siren stops calling it.', options: {}, positionals: [1, 1], run: apply.appsOff },
  'apps delete': {
    usage: 'apps delete <key> --yes',
    summary: 'Delete the app and revoke its key. It cannot be undone.',
    options: { yes: { type: 'boolean' } },
    positionals: [1, 1],
    run: apply.appsDelete,
  },
};

/** Every option any command takes, for the first read of the line, which finds the command. */
const ALL_OPTIONS: Options = Object.assign({ version: { type: 'boolean' } }, GLOBAL, ...Object.values(SPECS).map((spec) => spec.options));

/** The text `siren --help` prints. */
function helpText(): string {
  return [
    'Usage: siren <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  siren ${SPECS[command].usage}\n      ${SPECS[command].summary}`),
    '',
    'Every command takes --sandbox, --live, --base-url <url> and --help.',
    'With none of them it talks to SIREN_BASE_URL, else the sandbox. A live organization needs --live.',
    '',
  ].join('\n');
}

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
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let spec: CommandSpec | undefined;
  try {
    const first = read(argv, ALL_OPTIONS);
    const words = first.positionals;
    if (words.length === 0) {
      if (first.values.version === true) {
        io.stdout(`${CLI_VERSION}\n`);
        return 0;
      }
      if (first.values.help === true) {
        io.stdout(helpText());
        return 0;
      }
      throw new CliUsageError('Name a command.');
    }

    const name = words[0] === 'apps' ? `apps ${words[1] ?? ''}`.trim() : (words[0] ?? '');
    spec = (SPECS as Record<string, CommandSpec | undefined>)[name];
    if (spec === undefined) throw new CliUsageError(`There is no command "${name}".`);
    if (first.values.help === true) {
      io.stdout(`Usage: siren ${spec.usage}\n${spec.summary}\n`);
      return 0;
    }

    const { values, positionals } = read(argv, { ...GLOBAL, ...spec.options });
    const args = positionals.slice(name.split(' ').length);
    if (args.length < spec.positionals[0] || args.length > spec.positionals[1]) {
      throw new CliUsageError(`siren ${name} takes ${spec.positionals[0] === spec.positionals[1] ? spec.positionals[0] : `${spec.positionals[0]} to ${spec.positionals[1]}`} arguments, and got ${args.length}.`);
    }

    const flags = { sandbox: values.sandbox === true, live: values.live === true, baseUrl: typeof values['base-url'] === 'string' ? values['base-url'] : undefined };
    const context = spec.offline ? null : new CommandContext(io, resolveTarget(flags, io.env));
    // A command that sends nothing checks no address, so its hints repeat the flags as typed.
    const hintTarget = context?.target ?? {
      live: flags.live,
      addressFlag: flags.baseUrl !== undefined ? ` --base-url ${flags.baseUrl}` : flags.sandbox ? ' --sandbox' : '',
    };
    const command = (words: string) => commandLine(hintTarget, words);
    return await spec.run({ context, io, values: values as Record<string, string | boolean | undefined>, args, command });
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`siren: ${error.message}\n${spec === undefined ? 'Run siren --help to see the commands.' : `Usage: siren ${spec.usage}`}\n`);
      return 2;
    }
    io.stderr(`siren: ${(error instanceof Error ? error.message : String(error)).replace(/^Siren: /, '')}\n`);
    return 1;
  }
}

/** Reads the line with these options, strict, or throws {@link CliUsageError} with `parseArgs`'s reason. */
function read(argv: readonly string[], options: Options) {
  try {
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}
