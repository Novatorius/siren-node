import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import * as apply from './commands/apply';
import * as requests from './commands/requests';
import * as session from './commands/session';
import { CommandContext, tokenRefusal } from './context';
import type { CommandHandler } from './context';
import { CredentialStore } from './credentials';
import { firstRun, welcome } from './hook';
import type { HookCard } from './hook';
import type { CliIo } from './io';
import { CliRefusal, CliUsageError, LIVE_BASE_URL, commandLine, hostName, httpDetail, resolveTarget } from './targets';
import { nearest } from './suggest';
import { Style, clean, hanging, styleFor, wrapWords } from './style';
import { ConnectionError, NotFoundError, SirenError } from '../errors';
import { SANDBOX_BASE_URL } from '../http';
import type { Target } from './targets';

/**
 * The version `siren --version` prints, the package's.
 */
export { CLI_VERSION } from './version';
import { CLI_VERSION } from './version';

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
  'apps init',
  'apps apply',
  'apps diff',
  'apps pull',
  'apps list',
  'apps show',
  'apps scopes',
  'apps events',
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

/** The headings `siren --help` lists the commands under, in order. */
const GROUPS = ['Getting started', 'Apps', 'Requests', 'Account'] as const;

/** One command's line: its options, how many arguments follow its words, and its body. */
interface CommandSpec {
  /** The command with its arguments and options, as `--help` prints it. */
  usage: string;
  summary: string;
  /** The heading `siren --help` lists it under. */
  group: (typeof GROUPS)[number];
  /** The few words `siren --help` prints beside it, with no full stop. */
  short: string;
  options: Options;
  /** Each option as `--help` shows it, such as `--email <address>`, and one line about it. Every key of `options` has one. */
  flags: Readonly<Record<string, readonly [string, string]>>;
  /** One or two command lines that do something real. */
  examples: readonly string[];
  /** The fewest and the most arguments after the command words. */
  positionals: readonly [number, number];
  /** True for a command that sends nothing and so needs no Siren address. */
  offline?: boolean;
  /** True for a command that changes nothing, which a live organization serves without `--live`. */
  readsOnly?: boolean;
  /** True for a command whose route takes no personal access token, so it needs a signed-in session even with SIREN_TOKEN set. */
  sessionOnly?: boolean;
  run: CommandHandler;
}

/** The options every command takes. */
const GLOBAL: Options = {
  sandbox: { type: 'boolean' },
  live: { type: 'boolean' },
  'base-url': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean' },
  org: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

/** The shared options as every command's `--help` shows them. */
const GLOBAL_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['--sandbox', "Use Siren's sandbox, whatever you logged in to last"],
  ['--live', 'Log in to or change a live organization'],
  ['--base-url <url>', 'Use another Siren, such as siren.example.com'],
  ['--org <slug>', 'The organization to act in, when you have several'],
  ['-q, --quiet', 'Skip the logo animation'],
  ['--verbose', 'Show the detail behind an error'],
  ['-h, --help', 'Show help for a command'],
];

/** "--sandbox, --live, … and --help": each global flag's long name. */
function globalFlagNames(): string {
  const names = GLOBAL_FLAGS.map(([flag]) => /--[a-z-]+/.exec(flag)?.[0] ?? flag);
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Where `siren --help` sends a person for more. */
const GUIDE_URL = 'https://github.com/Novatorius/siren-node#command-line-tool';

const APP_FILE_FLAG = ['--app-file <path>', 'The app file beside the env file, if apply saved none'] as const;
const YES_FLAG = ['--yes', 'Skip the question. Needed with no terminal'] as const;
const JSON_FLAG = ['--json', 'Print JSON for a script, and nothing else'] as const;

const SPECS: Record<Command, CommandSpec> = {
  signup: {
    usage: 'signup [flags]',
    summary: 'Make an organization on Siren and log in to it.',
    group: 'Getting started',
    short: 'Make an organization on Siren',
    options: { 'org-name': { type: 'string' }, email: { type: 'string' }, 'password-stdin': { type: 'boolean' }, 'accept-terms': { type: 'boolean' } },
    flags: {
      'org-name': ['--org-name <name>', "The new organization's name, asked when left out"],
      email: ['--email <address>', 'Your email address, asked when left out'],
      'password-stdin': ['--password-stdin', 'Read the password from standard input'],
      'accept-terms': ['--accept-terms', "Accept Siren's Terms of Service and Privacy Policy"],
    },
    examples: ['siren signup', 'siren signup --org-name "Acme" --email dev@acme.example'],
    positionals: [0, 0],
    run: session.signup,
  },
  login: {
    usage: 'login [flags]',
    summary: 'Log in by approving a code in your browser.',
    group: 'Getting started',
    short: 'Log in to Siren in your browser',
    options: { password: { type: 'boolean' }, email: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
    flags: {
      password: ['--password', 'Log in with your email and password, with no browser'],
      'password-stdin': ['--password-stdin', 'Read the password from standard input, for scripts'],
      email: ['--email <address>', 'The email for --password, asked when left out'],
    },
    examples: ['siren login', 'siren login --password'],
    positionals: [0, 0],
    run: session.login,
  },
  logout: {
    usage: 'logout',
    summary: 'Log out, and forget the session on this machine.',
    group: 'Account',
    short: 'Log out, and forget the session here',
    options: {},
    flags: {},
    examples: ['siren logout'],
    positionals: [0, 0],
    run: session.logout,
  },
  whoami: {
    usage: 'whoami [flags]',
    summary: 'Show which credential the commands use, who it acts as, and on which Siren.',
    group: 'Account',
    short: 'Show who you are logged in as',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren whoami', 'siren whoami --json'],
    positionals: [0, 0],
    readsOnly: true,
    run: session.whoami,
  },
  orgs: {
    usage: 'orgs [flags]',
    summary: 'List your organizations, marking the one --org, SIREN_ORG or the app file picks.',
    group: 'Account',
    short: 'List your organizations',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren orgs', 'siren orgs --json'],
    positionals: [0, 0],
    readsOnly: true,
    sessionOnly: true,
    run: session.orgs,
  },

  'apps init': {
    usage: 'apps init [flags]',
    summary: 'Write siren.app.json here, and keep the env files apply writes out of git.',
    group: 'Getting started',
    short: 'Write siren.app.json in this folder',
    options: { key: { type: 'string' }, name: { type: 'string' } },
    flags: {
      key: ['--key <app key>', "The app's key, such as acme-payouts. Default: the folder"],
      name: ['--name <name>', 'The name the dashboard shows. Default: the key'],
    },
    examples: ['siren apps init', 'siren apps init --key acme-payouts --name "Acme payouts"'],
    positionals: [0, 0],
    offline: true,
    run: apply.appsInit,
  },
  'apps apply': {
    usage: 'apps apply [file] [flags]',
    summary: 'Show what siren.app.json changes, ask, then declare the app and save its key beside the file.',
    group: 'Getting started',
    short: 'Declare the app on Siren and save its key',
    options: { yes: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: { yes: YES_FLAG, json: ['--json', 'Print the plan and the app as JSON'] },
    examples: ['siren apps apply', 'siren apps apply --live --yes'],
    positionals: [0, 1],
    run: apply.appsApply,
  },
  'apps pull': {
    usage: 'apps pull <key> [file] [flags]',
    summary: 'Write siren.app.json from an app on Siren, so apply and diff can manage it from this folder.',
    group: 'Apps',
    short: 'Write siren.app.json from an app on Siren',
    options: { yes: { type: 'boolean' }, json: { type: 'boolean' }, 'url-env': { type: 'boolean' } },
    flags: {
      'url-env': ['--url-env', 'Write ${SIREN_APP_URL} in place of the url'],
      yes: ['--yes', 'Replace the file without asking'],
      json: ['--json', 'Print where it wrote and the file as JSON'],
    },
    examples: ['siren apps pull acme-payouts', 'siren apps pull acme-payouts --url-env'],
    positionals: [1, 2],
    readsOnly: true,
    run: apply.appsPull,
  },
  'apps diff': {
    usage: 'apps diff [file] [flags]',
    summary: 'Show what apply would change, and send nothing. Exits 0 when the file matches Siren and 3 when it differs.',
    group: 'Apps',
    short: 'Show what apply would change',
    options: { json: { type: 'boolean' } },
    flags: { json: ['--json', 'Print the plan as JSON, with the same exit codes'] },
    examples: ['siren apps diff', 'siren apps diff --json'],
    positionals: [0, 1],
    readsOnly: true,
    run: apply.appsDiff,
  },
  'apps scopes': {
    usage: 'apps scopes [flags]',
    summary: "List the scopes an app's key may hold on this Siren, for \"scopes\" in siren.app.json.",
    group: 'Apps',
    short: "List the scopes an app's key may hold",
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren apps scopes', 'siren apps scopes --json'],
    positionals: [0, 0],
    readsOnly: true,
    run: apply.appsScopes,
  },
  'apps events': {
    usage: 'apps events [flags]',
    summary: 'List the events Siren can send an app, for "events" in siren.app.json.',
    group: 'Apps',
    short: 'List the events Siren can send an app',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren apps events', 'siren apps events --json'],
    positionals: [0, 0],
    readsOnly: true,
    run: apply.appsEvents,
  },
  'apps list': {
    usage: 'apps list [flags]',
    summary: 'List the apps and their features.',
    group: 'Apps',
    short: 'List the apps',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren apps list', 'siren apps list --json'],
    positionals: [0, 0],
    readsOnly: true,
    run: apply.appsList,
  },
  'apps show': {
    usage: 'apps show [key] [flags]',
    summary: 'Show one app and its features.',
    group: 'Apps',
    short: 'Show one app and its features',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren apps show acme-payouts'],
    positionals: [0, 1],
    readsOnly: true,
    run: apply.appsShow,
  },
  'apps requests': {
    usage: 'apps requests [<request id>] [flags]',
    summary: 'List what Siren sent the apps, or show one request with each send and answer.',
    group: 'Requests',
    short: 'List what Siren sent, or show one request',
    options: { app: { type: 'string' }, all: { type: 'boolean' }, attention: { type: 'boolean' }, follow: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: {
      app: ['--app <key>', "Only this app's requests. In an app's folder, siren.app.json's app is the default"],
      all: ['--all', "Every app's requests, in an app's folder too"],
      attention: ['--attention', 'Only requests that need a person'],
      follow: ['--follow', 'Keep watching, and print each change. Ctrl-C stops'],
      json: ['--json', 'With a request id: the whole request, its app and feature keys, and its sends, as JSON'],
    },
    examples: ['siren apps requests --follow', 'siren apps requests <id> --json > request.json'],
    positionals: [0, 1],
    readsOnly: true,
    run: requests.appsRequests,
  },
  'apps answer': {
    usage: 'apps answer <request id> (--body <json> | --file <path>)',
    summary: 'Answer an ask by hand, as a signed-in admin.',
    group: 'Requests',
    short: 'Answer an ask by hand',
    options: { body: { type: 'string' }, file: { type: 'string' } },
    flags: {
      body: ['--body <json>', 'The answer, as JSON with a text outcome'],
      file: ['--file <path>', 'A file that holds the answer as JSON'],
    },
    examples: ['siren apps answer apr_0123456789abcdef0123456789abcdef --file answer.json'],
    positionals: [1, 1],
    sessionOnly: true,
    run: requests.appsAnswer,
  },
  'apps resend': {
    usage: 'apps resend <request id>',
    summary: 'Send a request again.',
    group: 'Requests',
    short: 'Send a request again',
    options: {},
    flags: {},
    examples: ['siren apps resend apr_0123456789abcdef0123456789abcdef'],
    positionals: [1, 1],
    run: requests.appsResend,
  },
  'apps rotate-key': {
    usage: 'apps rotate-key <key> [flags]',
    summary: 'Give the app a new key, revoke the old one, and save it where apply saved the first.',
    group: 'Apps',
    short: 'Replace the app\'s key and revoke the old one',
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    flags: { 'app-file': APP_FILE_FLAG, yes: YES_FLAG },
    examples: ['siren apps rotate-key acme-payouts'],
    positionals: [1, 1],
    run: apply.appsRotateKey,
  },
  'apps rotate-secret': {
    usage: 'apps rotate-secret <key> [flags]',
    summary: "Give the app's address a new signing secret, and save it where apply saved the first.",
    group: 'Apps',
    short: 'Replace the address\'s signing secret',
    options: { 'app-file': { type: 'string' }, yes: { type: 'boolean' } },
    flags: { 'app-file': APP_FILE_FLAG, yes: YES_FLAG },
    examples: ['siren apps rotate-secret acme-payouts'],
    positionals: [1, 1],
    run: apply.appsRotateSecret,
  },
  'apps add-key': {
    usage: 'apps add-key <key> [flags]',
    summary: 'Make a key for an app that holds none, and save it where apply saved the first.',
    group: 'Apps',
    short: 'Make a key for an app that has none',
    options: { 'app-file': { type: 'string' } },
    flags: { 'app-file': APP_FILE_FLAG },
    examples: ['siren apps add-key acme-payouts'],
    positionals: [1, 1],
    run: apply.appsAddKey,
  },
  'apps on': {
    usage: 'apps on <key>',
    summary: 'Turn the app on.',
    group: 'Apps',
    short: 'Turn the app on',
    options: {},
    flags: {},
    examples: ['siren apps on acme-payouts'],
    positionals: [1, 1],
    run: apply.appsOn,
  },
  'apps off': {
    usage: 'apps off <key>',
    summary: 'Turn the app off. Siren stops calling it.',
    group: 'Apps',
    short: 'Turn the app off',
    options: {},
    flags: {},
    examples: ['siren apps off acme-payouts'],
    positionals: [1, 1],
    run: apply.appsOff,
  },
  'apps delete': {
    usage: 'apps delete <key> --yes',
    summary: 'Delete the app and revoke its key. It cannot be undone.',
    group: 'Apps',
    short: 'Delete the app and revoke its key',
    options: { yes: { type: 'boolean' } },
    flags: { yes: ['--yes', 'Say you mean it. The command refuses without it.'] },
    examples: ['siren apps delete acme-payouts --yes'],
    positionals: [1, 1],
    run: apply.appsDelete,
  },
};

/** The command table, for tests that hold other lists to it. */
export const COMMAND_SPECS: Readonly<Record<Command, Readonly<CommandSpec>>> = SPECS;

/** Every option any command takes, for the first read of the line, which finds the command. */
const ALL_OPTIONS: Options = Object.assign({ version: { type: 'boolean', short: 'v' } }, GLOBAL, ...Object.values(SPECS).map((spec) => spec.options));

/** `text` broken into lines of at most `width` characters, at spaces. */
const wrap = wrapWords;

/** The widest a flag or command name may be and keep its words beside it. A longer one gets a line of its own. */
const NAME_ROOM = 30;

/**
 * Two aligned columns under a heading, as gh prints them: the left one
 * padded to `column`, styled by `name`, and the right one wrapped beneath
 * itself to `width`, the terminal's width. A left side too long for the
 * column, such as a flag with a long list of values, takes a line of its
 * own with its words under it, so one long flag never squeezes the rest
 * (CLI review round 1, C20).
 */
function columns(rows: ReadonlyArray<readonly [string, string]>, column: number, name: (text: string) => string, width: number): string[] {
  const fits = rows.filter(([left]) => left.length + 4 <= NAME_ROOM);
  const at = Math.max(column, ...fits.map(([left]) => left.length + 4));
  return rows.flatMap(([left, right]) => {
    const [first = '', ...rest] = wrap(right, Math.max(width - at, 20));
    const under = rest.map((line) => `${' '.repeat(at)}${line}`);
    if (left.length + 4 > at) return [`  ${name(left)}`, `${' '.repeat(at)}${first}`, ...under];
    return [`  ${name(left)}${' '.repeat(at - 2 - left.length)}${first}`, ...under];
  });
}

/** A help section: its heading in capitals, bold in a terminal, then its lines and a blank line. */
function section(style: Style, heading: string, lines: readonly string[]): string[] {
  return [style.bold(heading.toUpperCase()), ...lines, ''];
}

/** The commands of `group` that `commands` holds, one aligned line each. */
function commandRows(style: Style, commands: readonly Command[]): string[] {
  return columns(
    commands.map((command) => [command, SPECS[command].short] as const),
    22,
    (text) => style.bold(text),
    style.width,
  );
}

/** The lines of LEARN MORE. */
function learnMore(style: Style, perCommand: boolean): string[] {
  return [
    ...(perCommand ? [`  Run ${style.command('siren <command> --help')} for a command's flags and examples.`] : []),
    `  Read the guide at ${GUIDE_URL}`,
  ];
}

/** The text `siren --help` prints, modeled on gh's help. */
function helpText(style: Style): string {
  return [
    'Declare Siren apps, and watch and answer what Siren sends them.',
    '',
    ...section(style, 'Usage', ['  siren <command> [flags]']),
    ...GROUPS.flatMap((group) => section(style, group, commandRows(style, COMMANDS.filter((command) => SPECS[command].group === group)))),
    ...section(style, 'Flags', columns([...GLOBAL_FLAGS, ['-v, --version', 'Show the version']], 22, (text) => text, style.width)),
    ...section(
      style,
      'Environment',
      columns(
        [
          ['SIREN_BASE_URL', 'The Siren to use when no flag names one'],
          ['SIREN_ORG', 'The organization to act in, when no flag names one'],
          ['SIREN_TOKEN', 'A personal access token, for scripts and CI'],
          ['SIREN_DEBUG=1', 'The same as --verbose'],
          ['NO_COLOR, CI', 'Plain output, and no logo animation'],
        ],
        22,
        (text) => text,
        style.width,
      ),
    ),
    ...section(style, 'Examples', ['  $ siren login', '  $ siren apps init', '  $ siren apps apply']),
    ...section(style, 'Learn more', learnMore(style, true)),
  ].join('\n');
}

/** The text `siren apps` prints: the app and request commands, in the same shape. */
function appsHelpText(style: Style): string {
  const apps = COMMANDS.filter((command) => command.startsWith('apps ') && SPECS[command].group !== 'Requests');
  const requests = COMMANDS.filter((command) => SPECS[command].group === 'Requests');
  return [
    'Declare an app, change it, and watch and answer what Siren sends it.',
    '',
    ...section(style, 'Usage', ['  siren apps <command> [flags]']),
    ...section(style, 'Apps', commandRows(style, apps)),
    ...section(style, 'Requests', commandRows(style, requests)),
    ...section(style, 'Learn more', learnMore(style, true)),
  ].join('\n');
}

/** The text `siren <command> --help` prints: the same shape, with its own flags and examples. */
function commandHelp(style: Style, spec: CommandSpec): string {
  const own = Object.values(spec.flags);
  return [
    ...wrap(spec.summary, style.width),
    '',
    ...section(style, 'Usage', [`  siren ${spec.usage}`]),
    ...(own.length > 0 ? section(style, 'Flags', columns(own, 22, (text) => text, style.width)) : []),
    // CLI pass 3: the global flags once by name, since siren --help explains each.
    ...section(style, 'Global flags', wrap(`${globalFlagNames()} work with every command. siren --help explains them.`, style.width - 2).map((line) => `  ${line}`)),
    ...section(style, 'Examples', spec.examples.map((example) => `  ${style.dim('$')} ${example}`)),
    ...section(style, 'Learn more', learnMore(style, false)),
  ].join('\n');
}

/** What `siren` alone shows beside the logo: where you stand, and the three commands that come next. */
async function statusCard(io: CliIo, target: Target): Promise<HookCard> {
  const store = new CredentialStore(io.configDir);
  const token = io.env.SIREN_TOKEN !== undefined && io.env.SIREN_TOKEN !== '';
  const kept = token ? null : await store.get(target.baseUrl).catch(() => null);
  const next: Array<readonly [string, string]> = kept || token
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
  // CLI pass 3, should-fix 9: the first screen a newcomer sees takes the marks and colors every other screen has.
  const style = styleFor(io, 'stdout', {});
  const host = hostName(target.baseUrl);
  const isDefault = target.baseUrl === SANDBOX_BASE_URL || target.baseUrl === LIVE_BASE_URL;
  const where = token
    ? ['SIREN_TOKEN is set, so commands act with it.', ...(isDefault ? [] : [`Siren: ${host}`])]
    : kept
      ? [style.success(`Logged in as ${style.bold(clean(kept.email))}.`), `Siren: ${host}, ${kept.edition === 'production' ? style.amber('live') : 'a sandbox'}.`]
      : [style.warning('Not logged in. Run siren login to log in.'), ...(isDefault ? [] : [`Siren: ${host}`])];
  return { version: CLI_VERSION, where, next, footer: 'siren --help lists every command.' };
}


/** The command a line names, from its words, or {@link CliUsageError} with the nearest real one. */
function commandNamed(words: readonly string[]): Command {
  const name = words[0] === 'apps' ? `apps ${words[1] ?? ''}`.trim() : (words[0] ?? '');
  if ((COMMANDS as readonly string[]).includes(name)) return name as Command;
  // A name cut short, such as apps rotate, names every command it starts. Otherwise the nearest by edit distance.
  // CLI pass 3, should-fix 6: "app list" means apps list, so a group word near apps is read as apps with the rest of the line.
  if (words[0] !== 'apps' && words.length > 1 && nearest(words[0] ?? '', ['apps']) === 'apps') {
    const asApps = `apps ${words[1]}`;
    const guess = (COMMANDS as readonly string[]).includes(asApps) ? asApps : nearest(asApps, COMMANDS);
    throw new CommandUnknown('siren', words[0] ?? '', guess === undefined ? [] : [guess]);
  }
  const started = name.length >= 3 ? COMMANDS.filter((command) => command.startsWith(name)) : [];
  const guesses = started.length > 0 && started.length <= 4 ? started : [nearest(name, COMMANDS)].filter((guess) => guess !== undefined);
  const group = words[0] === 'apps' && words.length > 1 ? 'siren apps' : 'siren';
  const word = group === 'siren apps' ? (words[1] ?? '') : name;
  throw new CommandUnknown(group, word, guesses);
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
  let login = 'siren login';
  // What a refusal names: the arguments typed after the command, and its hint command lines.
  let typedArgs: readonly string[] = [];
  let hintCommand = (words: string) => `siren ${words}`;
  // The Siren a failed command was talking to, for the line --verbose adds.
  let targetUrl: string | undefined;
  // Stills the first-run welcome when the command ends, if no output stilled it first.
  let settle = async () => undefined as void;
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
        io.stdout(helpText(styleFor(io, 'stdout', {})));
        return 0;
      }
      const flags = targetFlags(values);
      const target = resolveTarget(flags, io.env, await remembered(io));
      return await welcome(io, hookFlags(values), await statusCard(io, target));
    }
    if (words[0] === 'apps' && words.length === 1) {
      io.stdout(appsHelpText(styleFor(io, 'stdout', {})));
      return 0;
    }

    name = commandNamed(words);
    spec = SPECS[name];
    if (wantsHelp) {
      io.stdout(commandHelp(styleFor(io, 'stdout', {}), spec));
      return 0;
    }

    const { values, positionals } = read(argv, { ...GLOBAL, ...spec.options }, `siren ${name}`, spec);
    const args = positionals.slice(name.split(' ').length);
    typedArgs = args;
    if (args.length < spec.positionals[0] || args.length > spec.positionals[1]) {
      const most = spec.positionals[1];
      const range = spec.positionals[0] === most ? String(most) : `${spec.positionals[0]} to ${most}`;
      throw new CliUsageError(`siren ${name} takes ${range} ${most === 1 ? 'argument' : 'arguments'}, and got ${args.length}.`);
    }

    // A login plays the logo itself, beside its code or its prompts. Any other command starts at once,
    // with the first-run welcome beside it, never before it (Alex, 2026-11-27: "the animation should not block").
    const ownsLogo = name === 'login' && (session.usesBrowserSignIn(values) || values.password === true);
    if (!ownsLogo) {
      const welcome = await firstRun(io, hookFlags(values), CLI_VERSION);
      io = welcome.io;
      settle = welcome.settle;
    }
    const flags = targetFlags(values);
    const context = spec.offline
      ? null
      : new CommandContext(io, resolveTarget(flags, io.env, await remembered(io)), spec.readsOnly === true, spec.sessionOnly === true ? name : undefined, [name, ...args].join(' '));
    if (context !== null) context.orgFlag = typeof values.org === 'string' ? values.org : undefined;
    targetUrl = context?.target.baseUrl;
    // A command that sends nothing names the Siren the next command would reach, the one logged in to included,
    // so init's Next keeps --live after a live login (CLI pass 3, should-fix 11). A target it can't settle keeps the flags as typed.
    const typedTarget = { live: flags.live, addressFlag: flags.baseUrl !== undefined ? ` --base-url ${flags.baseUrl}` : flags.sandbox ? ' --sandbox' : '' };
    const hintTarget =
      context?.target ??
      (await Promise.resolve()
        .then(async () => {
          const kept = await remembered(io);
          const target = resolveTarget(flags, io.env, kept);
          return { ...target, live: target.live || (kept?.live === true && kept.baseUrl === target.baseUrl) };
        })
        .catch(() => typedTarget));
    const command = (words: string) => commandLine(hintTarget, words);
    hintCommand = context === null ? command : (words: string) => context.command(words);
    login = command('login');
    const kept = async () => {
      try {
        const target = context?.target ?? resolveTarget(flags, io.env, await remembered(io));
        return await new CredentialStore(io.configDir).get(target.baseUrl);
      } catch {
        return null;
      }
    };
    return await spec.run({ context, io, values: values as Record<string, string | boolean | undefined>, args, command, kept });
  } catch (error) {
    const style = styleFor(io, 'stderr', { json: argv.includes('--json') });
    if (error instanceof CommandUnknown) {
      // Catalog mockup 5: the word in bold, the nearest command, and where help is. No usage block.
      const help = error.group === 'siren apps' ? 'siren apps --help lists the app commands.' : 'siren --help lists them.';
      if (!style.rich) {
        io.stderr(`siren: ${error.message}\n${help}\n`);
        return 2;
      }
      // CLI pass 3, should-fix 15: a command typo and a flag typo share one shape, the three parts of every error.
      const lines = [style.failure(`${error.group} has no command ${style.bold(`"${error.word}"`)}.`)];
      if (error.guesses.length > 0) {
        lines.push(style.wrap('  ', help), style.wrap(`${style.green('›')} `, `Did you mean ${error.guesses.map((one) => style.command(`siren ${one}`)).join(' or ')}?`));
      } else {
        lines.push(style.wrap('  ', 'The tool knows no command by that name.'), style.wrap(`${style.green('›')} `, `Run ${style.command(help.split(' lists')[0]!)} to list them.`));
      }
      io.stderr(`${lines.join('\n')}\n`);
      return 2;
    }
    if (error instanceof CliUsageError) {
      const usage = spec === undefined ? 'Run siren --help to see the commands.' : `Usage: siren ${spec.usage}`;
      const fix =
        error.guesses.length > 0
          ? `Did you mean ${error.guesses.map((one) => style.command(one.startsWith('-') ? one : `siren ${one}`)).join(' or ')}?`
          : `Run ${style.command(spec === undefined || name === undefined ? 'siren --help' : `siren ${name} --help`)} to see ${spec === undefined ? 'the commands' : 'its options'}.`;
      io.stderr(
        style.rich
          ? `${[style.failure(error.headline), style.wrap('  ', usage), style.wrap(`${style.green('›')} `, fix)].join('\n')}\n`
          : `siren: ${error.message}\n${usage}\n`,
      );
      return 2;
    }
    const verbose = argv.includes('--verbose') || io.env.SIREN_DEBUG === '1';
    io.stderr(style.error(tokenRefusal(error, login) ?? asRefusal(error, targetUrl, { name, args: typedArgs, command: hintCommand }), verbose));
    return 1;
  } finally {
    await settle();
  }
}

/**
 * Any error as a refusal the style module prints: a `CliRefusal` as it is,
 * an error from Siren with its message as the headline and its status and
 * code as detail, and anything else by its message.
 */
function asRefusal(error: unknown, baseUrl: string | undefined, typed: { name: Command | undefined; args: readonly string[]; command: (words: string) => string }): CliRefusal {
  if (error instanceof CliRefusal) return error;
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Siren: /, '');
  const host = baseUrl === undefined ? 'Siren' : hostName(baseUrl);
  if (error instanceof ConnectionError) {
    return new CliRefusal(`Lost the connection to ${host}.`, { why: message, fixText: 'Try again. --verbose shows the request.', detail: httpDetail(error, baseUrl) });
  }
  if (!(error instanceof SirenError)) {
    return new CliRefusal('Something went wrong inside the tool.', { why: message, fixText: 'Run it again with --verbose, and send the output to Siren support.' });
  }
  const detail = httpDetail(error, baseUrl);
  // Siren's 404s name no key or id, so the tool names the one typed (CLI pass 3, should-fix 10).
  const [first] = typed.args;
  if (error instanceof NotFoundError && first !== undefined && typed.name?.startsWith('apps ') === true) {
    if (/^apr_/.test(first) || error.code === 'app_request_not_found') {
      return new CliRefusal(`This organization has no request ${first}.`, { why: 'Siren found none with that id.', fix: typed.command('apps requests'), fixWords: 'to list the latest', detail });
    }
    return new CliRefusal(`This organization has no app ${first}.`, { why: 'Siren found none with that key.', fix: typed.command('apps list'), fixWords: 'to list the apps', detail });
  }
  if (error.statusCode !== undefined && error.statusCode >= 500) {
    return new CliRefusal(`${host} had a problem answering.`, { why: message, fixText: 'Try again in a minute. --verbose shows what Siren answered.', detail });
  }
  return new CliRefusal(message, { why: `${host} refused it, so nothing more was sent.`, fixText: 'Fix what it names, then run the command again. --verbose shows the code.', detail });
}

/** A command name the tool does not know, with the group it was typed in and the nearest real commands. */
class CommandUnknown extends CliUsageError {
  constructor(
    readonly group: 'siren' | 'siren apps',
    readonly word: string,
    guesses: readonly string[],
  ) {
    super(`${group} has no command "${word}".`, guesses);
  }
}

/** The flags that choose a Siren, from a strict read. */
function targetFlags(values: Record<string, unknown>) {
  return { sandbox: values.sandbox === true, live: values.live === true, baseUrl: typeof values['base-url'] === 'string' ? values['base-url'] : undefined };
}

/** The Siren the last sign-in was for, and whether it is live, or undefined. A file the tool would refuse names none here, and the command refuses it later. */
async function remembered(io: CliIo): Promise<{ baseUrl: string; live: boolean } | undefined> {
  // A personal access token goes only to the Siren the command line or SIREN_BASE_URL names.
  if (io.env.SIREN_TOKEN !== undefined && io.env.SIREN_TOKEN !== '') return undefined;
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
      throw new CliUsageError(`There is no option ${typed} for ${line}.`, guess === undefined ? [] : [guess], false);
    }
    const missing = /^Option '(?:-\w, )?(--[\w-]+) <value>' argument missing/.exec(message);
    if (missing) throw new CliUsageError(`${missing[1]} needs a value.`);
    const extra = /^Option '(?:-\w, )?(--[\w-]+)' does not take an argument/.exec(message);
    if (extra) throw new CliUsageError(`${extra[1]} takes no value.`);
    throw new CliUsageError(message);
  }
}
