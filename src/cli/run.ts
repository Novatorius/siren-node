import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import * as apply from './commands/apply';
import * as requests from './commands/requests';
import * as session from './commands/session';
import { CommandContext } from './context';
import type { CommandHandler } from './context';
import { CredentialStore } from './credentials';
import { firstRun, welcome } from './hook';
import type { HookCard } from './hook';
import type { CliIo } from './io';
import { CliUsageError, LIVE_BASE_URL, commandLine, resolveTarget } from './targets';
import { SANDBOX_BASE_URL } from '../http';
import type { Target } from './targets';

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
  'whoami',
  'orgs',
  'use',
  'apps init',
  'apps apply',
  'apps list',
  'apps show',
  'apps requests',
  'apps answer',
  'apps resend',
  'apps rotate-key',
  'apps rotate-secret',
  'apps add-key',
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
  /** The heading `siren --help` lists it under. */
  group: 'Your session' | 'Your apps' | 'Requests';
  options: Options;
  /** Each option as `--help` shows it, such as `--email <address>`, and one line about it. Every key of `options` has one. */
  flags: Readonly<Record<string, readonly [string, string]>>;
  /** One command line that does something real. */
  example: string;
  /** The fewest and the most arguments after the command words. */
  positionals: readonly [number, number];
  /** True for a command that sends nothing and so needs no Siren address. */
  offline?: boolean;
  /** True for a command that changes nothing, which a live organization serves without `--live`. */
  readsOnly?: boolean;
  run: CommandHandler;
}

/** The options every command takes. */
const GLOBAL: Options = {
  sandbox: { type: 'boolean' },
  live: { type: 'boolean' },
  'base-url': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
};

/** The shared options as every command's `--help` shows them. */
const GLOBAL_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['--sandbox', "Talk to Siren's sandbox, whatever you signed in to last."],
  ['--live', 'Sign in to or change a live organization. Reads of one need no flag.'],
  ['--base-url <url>', 'Talk to another Siren, such as siren.example.com.'],
  ['-q, --quiet', 'Skip the logo animation.'],
  ['-h, --help', 'Show this help.'],
];

const APP_FILE_FLAG = ['--app-file <path>', 'The app file whose folder holds the env file, when apply never saved one.'] as const;
const YES_FLAG = ['--yes', 'Skip the question. Needed when there is no terminal to ask in.'] as const;
const JSON_FLAG = ['--json', 'Print JSON for a script, and nothing else.'] as const;

const SPECS: Record<Command, CommandSpec> = {
  signup: {
    usage: 'signup [--org-name <name>] [--email <address>] [--password-stdin] [--accept-terms]',
    summary: 'Make an organization on Siren and sign in to it.',
    group: 'Your session',
    options: { 'org-name': { type: 'string' }, email: { type: 'string' }, 'password-stdin': { type: 'boolean' }, 'accept-terms': { type: 'boolean' } },
    flags: {
      'org-name': ['--org-name <name>', "The new organization's name. Asked when left out."],
      email: ['--email <address>', 'Your email address. Asked when left out.'],
      'password-stdin': ['--password-stdin', 'Read the password from standard input, for scripts.'],
      'accept-terms': ['--accept-terms', "Accept Siren's Terms of Service and Privacy Policy without being asked."],
    },
    example: 'siren signup --org-name "Acme" --email dev@acme.example',
    positionals: [0, 0],
    run: session.signup,
  },
  login: {
    usage: 'login [--email <address>] [--org <slug or id>] [--password-stdin]',
    summary: 'Sign in, and use this Siren for the commands after it.',
    group: 'Your session',
    options: { email: { type: 'string' }, org: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
    flags: {
      email: ['--email <address>', 'The email you sign in with. Asked when left out.'],
      org: ['--org <slug or id>', 'The organization to use, when you belong to several. Asked when left out.'],
      'password-stdin': ['--password-stdin', 'Read the password from standard input, for scripts.'],
    },
    example: 'siren login --email dev@acme.example',
    positionals: [0, 0],
    run: session.login,
  },
  logout: {
    usage: 'logout',
    summary: 'Sign out, and forget the session on this machine.',
    group: 'Your session',
    options: {},
    flags: {},
    example: 'siren logout',
    positionals: [0, 0],
    run: session.logout,
  },
  whoami: {
    usage: 'whoami [--json]',
    summary: 'Show who you are signed in as, in which organization, on which Siren. Sends nothing.',
    group: 'Your session',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    example: 'siren whoami',
    positionals: [0, 0],
    readsOnly: true,
    run: session.whoami,
  },
  orgs: {
    usage: 'orgs',
    summary: 'List your organizations, * on the one in use.',
    group: 'Your session',
    options: {},
    flags: {},
    example: 'siren orgs',
    positionals: [0, 0],
    readsOnly: true,
    run: session.orgs,
  },
  use: {
    usage: 'use <slug or id>',
    summary: 'Switch to another of your organizations.',
    group: 'Your session',
    options: {},
    flags: {},
    example: 'siren use acme-two',
    positionals: [1, 1],
    readsOnly: true,
    run: session.use,
  },
  'apps init': {
    usage: 'apps init [--key <app key>] [--name <name>]',
    summary: 'Write siren.app.json here, and keep the env files apply writes out of git.',
    group: 'Your apps',
    options: { key: { type: 'string' }, name: { type: 'string' } },
    flags: {
      key: ['--key <app key>', "The app's key, lowercase words joined by dashes. Defaults to this folder's name."],
      name: ['--name <name>', 'The name the dashboard shows. Defaults to the key.'],
    },
    example: 'siren apps init --key acme-payouts --name "Acme payouts"',
    positionals: [0, 0],
    offline: true,
    run: apply.appsInit,
  },
  'apps apply': {
    usage: 'apps apply [file] [--yes]',
    summary: 'Show what siren.app.json changes, ask, then declare the app and save its key beside the file.',
    group: 'Your apps',
    options: { yes: { type: 'boolean' } },
    flags: { yes: YES_FLAG },
    example: 'siren apps apply',
    positionals: [0, 1],
    run: apply.appsApply,
  },
  'apps list': {
    usage: 'apps list [--json]',
    summary: 'List the apps and their features.',
    group: 'Your apps',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    example: 'siren apps list',
    positionals: [0, 0],
    readsOnly: true,
    run: apply.appsList,
  },
  'apps show': {
    usage: 'apps show <key> [--json]',
    summary: 'Show one app and its features.',
    group: 'Your apps',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    example: 'siren apps show acme-payouts',
    positionals: [1, 1],
    readsOnly: true,
    run: apply.appsShow,
  },
  'apps requests': {
    usage: 'apps requests [<request id>] [--app <key>] [--attention] [--follow]',
    summary: 'List what Siren sent the apps, or show one request with each send and answer.',
    group: 'Requests',
    options: { app: { type: 'string' }, attention: { type: 'boolean' }, follow: { type: 'boolean' } },
    flags: {
      app: ['--app <key>', "Only this app's requests."],
      attention: ['--attention', 'Only requests that need a person.'],
      follow: ['--follow', 'Keep watching, and print each request as it changes. Ctrl-C stops.'],
    },
    example: 'siren apps requests --follow',
    positionals: [0, 1],
    readsOnly: true,
    run: requests.appsRequests,
  },
  'apps answer': {
    usage: 'apps answer <request id> (--body <json> | --file <path>)',
    summary: 'Answer an ask by hand, as a signed-in admin.',
    group: 'Requests',
    options: { body: { type: 'string' }, file: { type: 'string' } },
    flags: {
      body: ['--body <json>', 'The answer, as JSON with a text outcome.'],
      file: ['--file <path>', 'A file that holds the answer as JSON.'],
    },
    example: 'siren apps answer apr_0123456789abcdef0123456789abcdef --body \'{"outcome":"paid"}\'',
    positionals: [1, 1],
    run: requests.appsAnswer,
  },
  'apps resend': {
    usage: 'apps resend <request id>',
    summary: 'Send a request again.',
    group: 'Requests',
    options: {},
    flags: {},
    example: 'siren apps resend apr_0123456789abcdef0123456789abcdef',
    positionals: [1, 1],
    run: requests.appsResend,
  },
  'apps rotate-key': {
    usage: 'apps rotate-key <key> [--app-file <path>] [--yes]',
    summary: 'Give the app a new key, revoke the old one, and save it where apply saved the first.',
    group: 'Your apps',
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    flags: { 'app-file': APP_FILE_FLAG, yes: YES_FLAG },
    example: 'siren apps rotate-key acme-payouts',
    positionals: [1, 1],
    run: apply.appsRotateKey,
  },
  'apps rotate-secret': {
    usage: 'apps rotate-secret <key> [--app-file <path>] [--yes]',
    summary: "Give the app's address a new signing secret, and save it where apply saved the first.",
    group: 'Your apps',
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    flags: { 'app-file': APP_FILE_FLAG, yes: YES_FLAG },
    example: 'siren apps rotate-secret acme-payouts',
    positionals: [1, 1],
    run: apply.appsRotateSecret,
  },
  'apps add-key': {
    usage: 'apps add-key <key> [--app-file <path>]',
    summary: 'Make a key for an app that holds none, and save it where apply saved the first.',
    group: 'Your apps',
    options: { 'app-file': { type: 'string' } },
    flags: { 'app-file': APP_FILE_FLAG },
    example: 'siren apps add-key acme-payouts --app-file ./siren.app.json',
    positionals: [1, 1],
    run: apply.appsAddKey,
  },
  'apps on': {
    usage: 'apps on <key>',
    summary: 'Turn the app on.',
    group: 'Your apps',
    options: {},
    flags: {},
    example: 'siren apps on acme-payouts',
    positionals: [1, 1],
    run: apply.appsOn,
  },
  'apps off': {
    usage: 'apps off <key>',
    summary: 'Turn the app off. Siren stops calling it.',
    group: 'Your apps',
    options: {},
    flags: {},
    example: 'siren apps off acme-payouts',
    positionals: [1, 1],
    run: apply.appsOff,
  },
  'apps delete': {
    usage: 'apps delete <key> --yes',
    summary: 'Delete the app and revoke its key. It cannot be undone.',
    group: 'Your apps',
    options: { yes: { type: 'boolean' } },
    flags: { yes: ['--yes', 'Say you mean it. The command refuses without it.'] },
    example: 'siren apps delete acme-payouts --yes',
    positionals: [1, 1],
    run: apply.appsDelete,
  },
};

/** Every option any command takes, for the first read of the line, which finds the command. */
const ALL_OPTIONS: Options = Object.assign({ version: { type: 'boolean', short: 'v' } }, GLOBAL, ...Object.values(SPECS).map((spec) => spec.options));

/** The commands of one group, each with its usage and summary, as the top help lists them. */
function listing(commands: readonly Command[]): string[] {
  const lines: string[] = [];
  for (const group of ['Your session', 'Your apps', 'Requests'] as const) {
    const members = commands.filter((command) => SPECS[command].group === group);
    if (members.length === 0) continue;
    lines.push(`${group}:`, ...members.map((command) => `  siren ${SPECS[command].usage}\n      ${SPECS[command].summary}`), '');
  }
  return lines;
}

/** The text `siren --help` prints. */
function helpText(): string {
  return [
    'Usage: siren <command> [options]',
    '',
    ...listing(COMMANDS),
    'Every command takes --sandbox, --live, --base-url <url>, --quiet and --help.',
    'With none of them it talks to SIREN_BASE_URL, else the Siren you signed in to, else the sandbox.',
    'Changing a live organization needs --live. Run siren help <command> for its options and an example.',
    "Siren's logo animation plays the first time you run the tool. --quiet, NO_COLOR or CI skips it.",
    '',
  ].join('\n');
}

/** The text `siren apps` prints: the apps and requests commands. */
function appsHelpText(): string {
  return ['Usage: siren apps <command> [options]', '', ...listing(COMMANDS.filter((command) => command.startsWith('apps '))), 'Run siren help apps <command> for its options and an example.', ''].join('\n');
}

/** The text `siren <command> --help` prints: usage, what it does, each option, the shared ones, and an example. */
function commandHelp(spec: CommandSpec): string {
  const own = Object.values(spec.flags);
  const width = Math.max(...[...own, ...GLOBAL_FLAGS].map(([flag]) => flag.length)) + 2;
  const row = ([flag, about]: readonly [string, string]) => `  ${flag.padEnd(width)}${about}`;
  return [
    `Usage: siren ${spec.usage}`,
    spec.summary,
    '',
    ...(own.length > 0 ? ['Options:', ...own.map(row), ''] : []),
    'Every command also takes:',
    ...GLOBAL_FLAGS.map(row),
    '',
    'Example:',
    `  ${spec.example}`,
    '',
  ].join('\n');
}

/** A Siren's address without `https://`, and without `/siren/v1` when it ends there, for a line a person reads. */
function shortAddress(baseUrl: string): string {
  return baseUrl.replace(/^https:\/\//, '').replace(/\/siren\/v1$/, '');
}

/** What `siren` alone shows beside the logo: where you stand, and the three commands that come next. */
async function statusCard(io: CliIo, target: Target): Promise<HookCard> {
  const store = new CredentialStore(io.configDir);
  const kept = await store.get(target.baseUrl).catch(() => null);
  const next: Array<readonly [string, string]> = kept
    ? [
        ['siren apps init', 'write siren.app.json in this folder'],
        ['siren apps apply', 'declare the app on Siren and save its key'],
        ['siren apps requests --follow', 'watch what Siren sends it'],
      ]
    : [
        ['siren login', 'log in, or siren signup to make an organization'],
        ['siren apps init', 'write siren.app.json in this folder'],
        ['siren apps apply', 'declare the app on Siren and save its key'],
      ];
  const host = shortAddress(target.baseUrl);
  const isDefault = target.baseUrl === SANDBOX_BASE_URL || target.baseUrl === LIVE_BASE_URL;
  const where = kept
    ? [`Logged in as ${kept.email} to ${kept.orgName}.`, `Siren: ${host}, ${kept.edition === 'production' ? 'live' : 'a sandbox'}.`]
    : ['Not logged in. Run siren login to log in.', ...(isDefault ? [] : [`Siren: ${host}`])];
  return { version: CLI_VERSION, where, next, footer: 'siren --help lists every command.' };
}

/** The nearest of `choices` to `typed` by edit distance, when it is near enough to be a typo. */
function nearest(typed: string, choices: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const choice of choices) {
    const distance = editDistance(typed, choice);
    if (distance < bestDistance) {
      best = choice;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(typed.length / 3)) ? best : undefined;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The command a line names, from its words, or {@link CliUsageError} with the nearest real one. */
function commandNamed(words: readonly string[]): Command {
  const name = words[0] === 'apps' ? `apps ${words[1] ?? ''}`.trim() : (words[0] ?? '');
  if ((COMMANDS as readonly string[]).includes(name)) return name as Command;
  // A name cut short, such as apps rotate, names every command it starts. Otherwise the nearest by edit distance.
  const started = name.length >= 3 ? COMMANDS.filter((command) => command.startsWith(name)) : [];
  const guesses = started.length > 0 ? started : [nearest(name, COMMANDS)].filter((guess) => guess !== undefined);
  throw new CliUsageError(`There is no command "${name}".${guesses.length === 0 ? '' : ` Did you mean ${guesses.map((guess) => `"${guess}"`).join(' or ')}?`}`);
}

/**
 * Runs one `siren` command line and answers its exit code: 0 when it did
 * what was asked, 1 when Siren or the tool refused it, 2 for a command line
 * it cannot read, and 130 after Ctrl-C during the hook. Every refusal is one
 * line on standard error, and nothing is sent once a check before sending
 * fails.
 *
 * The line is read twice with `node:util` `parseArgs`: loosely, to find the
 * command, then strictly with that command's options, so an unknown flag is
 * a usage error that names the nearest real one. Every command takes
 * `--sandbox`, `--live`, `--base-url <url>` (see `resolveTarget`), `--quiet`
 * and `--help`. `siren` alone shows the hook and where you stand, `siren
 * apps` lists the apps commands, and `siren help [command]`, `siren
 * version` and `-v` work as their flags do.
 *
 * It never prints a password, a session token, an app's API key beyond its
 * 16-character prefix, or a signing secret, except the one case the
 * architecture note names: a key and secret that Siren showed once and the
 * env file could not hold.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let spec: CommandSpec | undefined;
  let name: Command | undefined;
  try {
    const loose = parseArgs({ args: [...argv], options: ALL_OPTIONS, strict: false, allowPositionals: true });
    let words = loose.positionals;
    let wantsHelp = loose.values.help === true;
    if (words[0] === 'help') {
      words = words.slice(1);
      wantsHelp = true;
    }

    if (words.length === 0 || (words[0] === 'version' && words.length === 1)) {
      const { values } = read(argv.filter((arg) => arg !== 'help' && arg !== 'version'), { ...GLOBAL, version: ALL_OPTIONS.version!, json: { type: 'boolean' } }, 'siren');
      if (values.version === true || words[0] === 'version') {
        io.stdout(`${CLI_VERSION}\n`);
        return 0;
      }
      if (wantsHelp) {
        io.stdout(helpText());
        return 0;
      }
      const flags = targetFlags(values);
      const target = resolveTarget(flags, io.env, await remembered(io));
      return await welcome(io, hookFlags(values), await statusCard(io, target));
    }
    if (words[0] === 'apps' && words.length === 1) {
      io.stdout(appsHelpText());
      return 0;
    }

    name = commandNamed(words);
    spec = SPECS[name];
    if (wantsHelp) {
      io.stdout(commandHelp(spec));
      return 0;
    }

    const { values, positionals } = read(argv, { ...GLOBAL, ...spec.options }, `siren ${name}`, spec);
    const args = positionals.slice(name.split(' ').length);
    if (args.length < spec.positionals[0] || args.length > spec.positionals[1]) {
      throw new CliUsageError(`siren ${name} takes ${spec.positionals[0] === spec.positionals[1] ? spec.positionals[0] : `${spec.positionals[0]} to ${spec.positionals[1]}`} arguments, and got ${args.length}.`);
    }

    const flags = targetFlags(values);
    const context = spec.offline ? null : new CommandContext(io, resolveTarget(flags, io.env, await remembered(io)), spec.readsOnly === true);
    // A command that sends nothing checks no address, so its hints repeat the flags as typed.
    const hintTarget = context?.target ?? {
      live: flags.live,
      addressFlag: flags.baseUrl !== undefined ? ` --base-url ${flags.baseUrl}` : flags.sandbox ? ' --sandbox' : '',
    };
    const command = (words: string) => commandLine(hintTarget, words);
    if (!(await firstRun(io, hookFlags(values), CLI_VERSION))) return 130;
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

/** The flags that choose a Siren, from a strict read. */
function targetFlags(values: Record<string, unknown>) {
  return { sandbox: values.sandbox === true, live: values.live === true, baseUrl: typeof values['base-url'] === 'string' ? values['base-url'] : undefined };
}

/** The Siren the last sign-in was for, and whether it is live, or undefined. A file the tool would refuse names none here, and the command refuses it later. */
async function remembered(io: CliIo): Promise<{ baseUrl: string; live: boolean } | undefined> {
  const current = await new CredentialStore(io.configDir).current().catch(() => null);
  return current === null ? undefined : { baseUrl: current.baseUrl, live: current.session.edition === 'production' };
}

/** The flags that keep the hook still. */
function hookFlags(values: Record<string, unknown>) {
  return { quiet: values.quiet === true, json: values.json === true };
}

/**
 * Reads the line with these options, strict, or throws {@link CliUsageError}
 * in the tool's words: an unknown option with the nearest real one, an
 * option missing its value, or a switch given one.
 */
function read(argv: readonly string[], options: Options, line: string, spec?: CommandSpec) {
  try {
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /^Unknown option '([^']+)'/.exec(message);
    if (unknown) {
      const typed = unknown[1]!;
      const names = Object.keys(options).filter((option) => option !== 'version' || spec === undefined).map((option) => `--${option}`);
      const guess = typed.startsWith('--') ? nearest(typed, names) : undefined;
      throw new CliUsageError(`There is no option ${typed} for ${line}.${guess === undefined ? '' : ` Did you mean ${guess}?`}`);
    }
    const missing = /^Option '(?:-\w, )?(--[\w-]+) <value>' argument missing/.exec(message);
    if (missing) throw new CliUsageError(`${missing[1]} needs a value.`);
    const extra = /^Option '(?:-\w, )?(--[\w-]+)' does not take an argument/.exec(message);
    if (extra) throw new CliUsageError(`${extra[1]} takes no value.`);
    throw new CliUsageError(message);
  }
}
