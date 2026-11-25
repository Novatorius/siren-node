import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import * as apply from './commands/apply';
import * as requests from './commands/requests';
import * as session from './commands/session';
import { CommandContext, shortAddress, tokenRefusal } from './context';
import type { CommandHandler } from './context';
import { CredentialStore } from './credentials';
import { firstRun, welcome } from './hook';
import type { HookCard } from './hook';
import type { CliIo } from './io';
import { CliRefusal, CliUsageError, LIVE_BASE_URL, commandLine, resolveTarget } from './targets';
import { Style, styleFor, wrapWords } from './style';
import { SirenError } from '../errors';
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
    usage: 'orgs',
    summary: 'List your organizations, * on the one in use.',
    group: 'Account',
    short: 'List your organizations',
    options: {},
    flags: {},
    examples: ['siren orgs'],
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
    options: { yes: { type: 'boolean' } },
    flags: { yes: YES_FLAG },
    examples: ['siren apps apply', 'siren apps apply --live --yes'],
    positionals: [0, 1],
    run: apply.appsApply,
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
    usage: 'apps show <key> [flags]',
    summary: 'Show one app and its features.',
    group: 'Apps',
    short: 'Show one app and its features',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren apps show acme-payouts'],
    positionals: [1, 1],
    readsOnly: true,
    run: apply.appsShow,
  },
  'apps requests': {
    usage: 'apps requests [<request id>] [flags]',
    summary: 'List what Siren sent the apps, or show one request with each send and answer.',
    group: 'Requests',
    short: 'List what Siren sent, or show one request',
    options: { app: { type: 'string' }, attention: { type: 'boolean' }, follow: { type: 'boolean' } },
    flags: {
      app: ['--app <key>', "Only this app's requests"],
      attention: ['--attention', 'Only requests that need a person'],
      follow: ['--follow', 'Keep watching, and print each change. Ctrl-C stops'],
    },
    examples: ['siren apps requests --follow', 'siren apps requests --app acme-payouts --attention'],
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

/** Every option any command takes, for the first read of the line, which finds the command. */
const ALL_OPTIONS: Options = Object.assign({ version: { type: 'boolean', short: 'v' } }, GLOBAL, ...Object.values(SPECS).map((spec) => spec.options));

/** The widest a help line may be, so nothing wraps in an 80-column terminal. */
const HELP_WIDTH = 80;

/** `text` broken into lines of at most `width` characters, at spaces. */
const wrap = wrapWords;

/**
 * Two aligned columns under a heading, as gh prints them: the left one
 * padded to `column`, styled by `name`, and the right one wrapped beneath
 * itself so no line passes {@link HELP_WIDTH}.
 */
function columns(rows: ReadonlyArray<readonly [string, string]>, column: number, name: (text: string) => string): string[] {
  const at = Math.max(column, ...rows.map(([left]) => left.length + 4));
  return rows.flatMap(([left, right]) => {
    const [first = '', ...rest] = wrap(right, HELP_WIDTH - at);
    return [`  ${name(left)}${' '.repeat(at - 2 - left.length)}${first}`, ...rest.map((line) => `${' '.repeat(at)}${line}`)];
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
    ...section(style, 'Flags', columns([...GLOBAL_FLAGS, ['-v, --version', 'Show the version']], 22, (text) => text)),
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
    ...wrap(spec.summary, HELP_WIDTH),
    '',
    ...section(style, 'Usage', [`  siren ${spec.usage}`]),
    ...(own.length > 0 ? section(style, 'Flags', columns(own, 22, (text) => text)) : []),
    ...section(style, 'Global flags', columns(GLOBAL_FLAGS, 22, (text) => text)),
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
  const host = shortAddress(target.baseUrl);
  const isDefault = target.baseUrl === SANDBOX_BASE_URL || target.baseUrl === LIVE_BASE_URL;
  const where = token
    ? ['SIREN_TOKEN is set, so commands act with it.', ...(isDefault ? [] : [`Siren: ${host}`])]
    : kept
      ? [`Logged in as ${kept.email}.`, `Siren: ${host}, ${kept.edition === 'production' ? 'live' : 'a sandbox'}.`]
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
  throw new CliUsageError(`There is no command "${name}".`, guesses);
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
    if (args.length < spec.positionals[0] || args.length > spec.positionals[1]) {
      throw new CliUsageError(`siren ${name} takes ${spec.positionals[0] === spec.positionals[1] ? spec.positionals[0] : `${spec.positionals[0]} to ${spec.positionals[1]}`} arguments, and got ${args.length}.`);
    }

    const flags = targetFlags(values);
    const context = spec.offline
      ? null
      : new CommandContext(io, resolveTarget(flags, io.env, await remembered(io)), spec.readsOnly === true, spec.sessionOnly === true ? name : undefined);
    if (context !== null) context.orgFlag = typeof values.org === 'string' ? values.org : undefined;
    // A command that sends nothing checks no address, so its hints repeat the flags as typed.
    const hintTarget = context?.target ?? {
      live: flags.live,
      addressFlag: flags.baseUrl !== undefined ? ` --base-url ${flags.baseUrl}` : flags.sandbox ? ' --sandbox' : '',
    };
    const command = (words: string) => commandLine(hintTarget, words);
    login = command('login');
    // A browser sign-in plays the logo animation when the approval lands, so the first run waits for that moment.
    const playsAtApproval = name === 'login' && session.usesBrowserSignIn(values);
    if (!playsAtApproval && !(await firstRun(io, hookFlags(values), CLI_VERSION))) return 130;
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
    if (error instanceof CliUsageError) {
      const usage = spec === undefined ? 'Run siren --help to see the commands.' : `Usage: siren ${spec.usage}`;
      const guess =
        error.guesses.length === 0
          ? []
          : [`  ${style.next(`Did you mean ${error.guesses.map((one) => style.command(one.startsWith('-') ? one : `siren ${one}`)).join(' or ')}?`)}`];
      io.stderr(style.rich ? `${[style.failure(error.headline), ...guess, `  ${style.dim(usage)}`].join('\n')}\n` : `siren: ${error.message}\n${usage}\n`);
      return 2;
    }
    const verbose = argv.includes('--verbose') || io.env.SIREN_DEBUG === '1';
    io.stderr(style.error(tokenRefusal(error, login) ?? asRefusal(error), verbose));
    return 1;
  }
}

/**
 * Any error as a refusal the style module prints: a `CliRefusal` as it is,
 * an error from Siren with its message as the headline and its status and
 * code as detail, and anything else by its message.
 */
function asRefusal(error: unknown): CliRefusal {
  if (error instanceof CliRefusal) return error;
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Siren: /, '');
  if (!(error instanceof SirenError)) return new CliRefusal(message);
  const detail = [
    ...(error.statusCode === undefined ? [] : [`HTTP status: ${error.statusCode}`]),
    ...(error.code === undefined ? [] : [`Error code: ${error.code}`]),
  ];
  return new CliRefusal(message, { detail });
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
