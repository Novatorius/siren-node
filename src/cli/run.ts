import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import * as apply from './commands/apply';
import * as listen from './commands/listen';
import * as logs from './commands/logs';
import * as appsTest from './commands/apps-test';
import * as fixtures from './commands/fixtures';
import * as simulate from './commands/simulate';
import * as conditionSets from './commands/condition-sets';
import * as enrollers from './commands/enrollers';
import * as notes from './commands/notes';
import * as recipes from './commands/recipes';
import { fieldProblems, fieldsLine } from './validation';
import * as trigger from './commands/trigger';
import * as requests from './commands/requests';
import * as records from './commands/resources';
import * as sandbox from './commands/sandbox';
import * as seed from './commands/seed';
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
  'listen',
  'trigger',
  'trigger ask',
  'logs tail',
  'simulate',
  'fixtures',
  'apps test',
  'sandbox create',
  'sandbox list',
  'sandbox reset',
  'sandbox inbox',
  'seed',
  'recipes preview',
  'recipes apply',
  'recipes status',
  'recipes imports',
  'recipes export',
  'recipes catalog',
  'recipes show',
  'recipes fetch',
  'notes',
  'notes add',
  'notes edit',
  'notes delete',
  'condition-sets list',
  'condition-sets get',
  'condition-sets matches',
  'condition-sets create',
  'condition-sets conditions',
  'enrollers list',
  'enrollers get',
  'enrollers log',
  'enrollers run',
  'enrollers create',
] as const;

/** One of {@link COMMANDS}. */
export type Command = (typeof COMMANDS)[number];

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * The headings `siren --help` lists the commands under, in order, as gh
 * groups its own. Developer tools holds listen, trigger, logs and the other
 * commands that test an app against Siren. Records holds the commands
 * generated from Siren's API, which {@link recordRows} lists.
 */
const GROUPS = ['Getting started', 'Apps', 'Requests', 'Developer tools', 'Sandbox', 'Recipes', 'Notes', 'Condition sets', 'Enrollers', 'Records', 'Account'] as const;

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
  /**
   * True for a write a live organization takes without `--live`, since it
   * changes no program, reward or payout, such as a note. LIVE_WRITES names
   * every other write.
   */
  liveSafe?: boolean;
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

/** The options `trigger` and `simulate` share. */
const ACTIVITY_OPTIONS: Options = {
  collaborator: { type: 'string' },
  program: { type: 'string' },
  amount: { type: 'string' },
  currency: { type: 'string' },
  add: { type: 'string', multiple: true },
};

const ACTIVITY_FLAGS: Readonly<Record<string, readonly [string, string]>> = {
  collaborator: ['--collaborator <id>', 'Who to credit, the oldest active one if left out'],
  program: ['--program <id>', 'Credit someone in this program'],
  amount: ['--amount <49.99>', "The sale's total or the refund's part, 10.00 by default"],
  currency: ['--currency <code>', "A currency code, the organization's own if left out"],
  add: ['--add <key=value>', 'Set one field of the event. Repeat it for more'],
};

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
  listen: {
    usage: 'listen [--forward-to <url>] [--app <key>] [--events <types>] [--json]',
    summary: "While it runs, send the app's asks, tells and events to a handler on this machine. Sandbox only.",
    group: 'Developer tools',
    short: 'Send the app\'s requests to this machine',
    options: { 'forward-to': { type: 'string' }, app: { type: 'string' }, events: { type: 'string' }, json: { type: 'boolean' } },
    sessionOnly: true,
    flags: {
      'forward-to': ['--forward-to <url>', "Where your handler runs, such as localhost:8787/siren. Defaults to the app file's localhost url."],
      app: ['--app <key>', 'The app to listen for. Defaults to the key in siren.app.json.'],
      events: ['--events <types>', 'Only these, as a comma list of event types and app.request.'],
      json: ['--json', 'Print one JSON object per line, for a script.'],
    },
    examples: ['siren listen --forward-to localhost:8787/siren', 'siren listen --app acme-payouts --events app.request --json'],
    positionals: [0, 0],
    run: listen.listen,
  },
  'logs tail': {
    usage: 'logs tail [flags]',
    summary: "Print what happens in the organization as it happens: app requests, deliveries, webhooks, events and API calls. Ctrl-C stops.",
    group: 'Developer tools',
    short: 'Watch requests, deliveries and API calls live',
    options: {
      app: { type: 'string' },
      feature: { type: 'string' },
      status: { type: 'string' },
      type: { type: 'string' },
      method: { type: 'string' },
      path: { type: 'string' },
      source: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      expand: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    flags: {
      app: ['--app <key>', "Only this app's entries"],
      feature: ['--feature <key>', "Only this feature's requests and deliveries"],
      status: ['--status <list>', 'ok, failed or refused, joined by commas'],
      type: ['--type <list>', 'request, delivery, webhook, event or api'],
      method: ['--method <verb>', 'Only API calls with this method'],
      path: ['--path <prefix>', 'Only API calls whose path starts so'],
      source: ['--source <list>', 'dashboard, api_key, app, cli or site'],
      since: ['--since <time>', 'Start back in time: 10m, 2h, 1d or an ISO time'],
      limit: ['--limit <n>', 'Stop after n entries'],
      expand: ['--expand', 'Show each entry\'s body'],
      json: ['--json', 'Print one JSON object a line, and nothing else'],
    },
    examples: ['siren logs tail --app acme-payouts --status failed', 'siren logs tail --since 1h --limit 50 --json'],
    positionals: [0, 0],
    readsOnly: true,
    run: logs.logsTail,
  },
  'apps test': {
    usage: 'apps test <key> [--json]',
    summary: "Send the app's address one signed test delivery, and print what it answered.",
    group: 'Developer tools',
    short: "Send the app's address a test delivery",
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren apps test acme-payouts'],
    positionals: [1, 1],
    run: appsTest.appsTest,
  },
  trigger: {
    usage: 'trigger <sale|refund|visit|event> [flags]',
    summary: 'Make a sale, refund, visit or custom event in a sandbox, and print who earns what and what each app was sent, or why it was sent nothing.',
    group: 'Developer tools',
    short: 'Make test activity in a sandbox',
    options: { ...ACTIVITY_OPTIONS, opportunity: { type: 'string' }, transaction: { type: 'string' }, approve: { type: 'boolean' }, wait: { type: 'string' }, json: { type: 'boolean' } },
    flags: {
      ...ACTIVITY_FLAGS,
      approve: ['--approve', 'Approve the sale\'s conversions too, so Siren tells the apps a program picks'],
      opportunity: ['--opportunity <id>', "A visit's opportunity to sell on, a new visit if left out"],
      transaction: ['--transaction <id>', 'The sale a refund undoes, the newest if left out'],
      wait: ['--wait <seconds>', "How long to wait on an app's answer, 30 by default"],
      json: JSON_FLAG,
    },
    examples: ['siren trigger sale --amount 49.99 --approve', 'siren trigger refund --transaction 3307'],
    positionals: [1, 1],
    run: trigger.trigger,
  },
  'trigger ask': {
    usage: 'trigger ask <app> <feature> [--wait <seconds>] [--yes] [--json]',
    summary: "Send one feature its kind's sample ask, marked as a test, and print the answer. Nothing acts on it.",
    group: 'Developer tools',
    short: "Send a feature a test ask",
    options: { wait: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: { wait: ['--wait <seconds>', 'How long to wait for the answer, 60 by default'], yes: ['--yes', 'Send a live sample without asking'], json: JSON_FLAG },
    examples: ['siren trigger ask acme-crm split-the-pool'],
    positionals: [2, 2],
    run: trigger.triggerAsk,
  },
  fixtures: {
    usage: 'fixtures <file.json> [--yes] [--json]',
    summary: "Run a file of trigger steps in order, each able to read an earlier step's answer.",
    group: 'Developer tools',
    short: 'Run a file of trigger steps',
    options: { yes: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: { yes: ['--yes', 'Send live sample asks without asking'], json: JSON_FLAG },
    examples: ['siren fixtures checkout.json'],
    positionals: [1, 1],
    run: fixtures.fixtures,
  },
  simulate: {
    usage: 'simulate [<scenario.json|->] [flags]',
    summary:
      "Run a scenario through your organization's setup, keep nothing, and print the transaction, what each program counted, conversions, obligations, and why. Give Beacon's scenario document, {recipe?, actions}, or write one with the flags. The tool never picks who referred the sale.",
    group: 'Developer tools',
    short: 'Show what a scenario would make, writing nothing',
    options: {
      'referred-by': { type: 'string' },
      direct: { type: 'boolean' },
      coupon: { type: 'string' },
      line: { type: 'string', multiple: true },
      close: { type: 'string' },
      'print-scenario': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    flags: {
      'referred-by': ['--referred-by <id|email>', 'Who referred the sale: an id, an export key, or an email or name'],
      direct: ['--direct', 'A sale nobody referred'],
      coupon: ['--coupon <code>', 'A coupon used on the sale'],
      line: ['--line <pairs>', 'A line item, such as "sku=TEE qty=2 price=25.00", repeatable. It also takes name, type, category, value and currency, the organization\'s own if left out'],
      close: ['--close <distributor>', "Close a distributor's period and show each share of the pot"],
      'print-scenario': ['--print-scenario', 'Print the scenario the flags write, and run nothing'],
      json: ['--json', "Print Siren's whole result"],
    },
    examples: ['siren simulate --referred-by 39 --line "sku=TEE qty=2 price=25.00"', 'siren simulate sale.json'],
    positionals: [0, 1],
    readsOnly: true,
    run: simulate.simulate,
  },
  'sandbox create': {
    usage: 'sandbox create --from <live org> [flags]',
    summary:
      "Copy a live organization's setup into a new sandbox organization: apps and their features, programs, groups and settings. Collaborators, keys, secrets and app addresses stay on the live Siren.",
    group: 'Sandbox',
    short: 'Copy a live setup into a sandbox',
    options: { from: { type: 'string' }, 'live-url': { type: 'string' }, name: { type: 'string' }, json: { type: 'boolean' } },
    flags: {
      from: ['--from <slug or id>', 'The live organization to copy'],
      'live-url': ['--live-url <url>', 'The live Siren, if not your one live session'],
      name: ['--name <name>', 'The new organization\'s name'],
      json: JSON_FLAG,
    },
    examples: ['siren sandbox create --from acme', 'siren sandbox create --from acme --live-url siren.acme.example'],
    positionals: [0, 0],
    run: sandbox.create,
  },
  'sandbox list': {
    usage: 'sandbox list [flags]',
    summary: 'List your sandbox organizations, and the live organization each was copied from.',
    group: 'Sandbox',
    short: 'List your sandbox organizations',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren sandbox list'],
    positionals: [0, 0],
    run: sandbox.list,
  },
  'sandbox reset': {
    usage: 'sandbox reset [flags]',
    summary:
      'Clear the sandbox organization\'s activity: conversions, obligations, transactions, payouts, requests and deliveries. Its setup stays. You type the slug to confirm.',
    group: 'Sandbox',
    short: 'Clear activity, keep setup',
    options: { confirm: { type: 'string' }, json: { type: 'boolean' } },
    flags: { confirm: ['--confirm <slug>', 'The slug, for when no terminal can ask'], json: JSON_FLAG },
    examples: ['siren sandbox reset --org acme-sandbox', 'siren sandbox reset --org acme-sandbox --confirm acme-sandbox'],
    positionals: [0, 0],
    run: sandbox.reset,
  },
  'sandbox inbox': {
    usage: 'sandbox inbox [<number>] [flags]',
    summary: 'List the emails the sandbox caught for the organization, or show one.',
    group: 'Sandbox',
    short: "Read the sandbox's caught emails",
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    flags: { limit: ['--limit <n>', 'How many to list, 1 to 100 (20)'], json: JSON_FLAG },
    examples: ['siren sandbox inbox --org acme-sandbox', 'siren sandbox inbox 31'],
    positionals: [0, 1],
    run: sandbox.inbox,
  },
  seed: {
    usage: 'seed [flags]',
    summary: 'Fill the sandbox organization with sample sales spread back over past months, and sample collaborators when it has too few.',
    group: 'Sandbox',
    short: 'Fill a sandbox with sample sales',
    options: {
      sales: { type: 'string' },
      collaborators: { type: 'string' },
      months: { type: 'string' },
      seed: { type: 'string' },
      'no-wait': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    flags: {
      sales: ['--sales <n>', 'Sales to send, 1 to 200 (50)'],
      collaborators: ['--collaborators <n>', 'Collaborators to credit, 1 to 25 (10)'],
      months: ['--months <n>', 'Months back to spread them, 1 to 6 (3)'],
      seed: ['--seed <n>', 'The same seed makes the same sales'],
      'no-wait': ['--no-wait', 'Queue the job and stop'],
      json: JSON_FLAG,
    },
    examples: ['siren seed --org acme-sandbox', 'siren seed --sales 120 --months 6'],
    positionals: [0, 0],
    run: seed.seed,
  },
  'recipes preview': {
    usage: 'recipes preview <file|-> [flags]',
    summary: "Show what a recipe would make in this organization, and write nothing. Siren checks it as apply does, so a recipe that previews cleanly applies. - reads it from standard input. Needs siren login: an API key can't use recipes yet.",
    group: 'Recipes',
    short: 'Show what a recipe would make',
    options: { 'configuration-only': { type: 'boolean' }, paused: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: {
      'configuration-only': ['--configuration-only', 'Leave out the people, mappings and group members'],
      paused: ['--paused', 'Make every program and distributor inactive'],
      json: ['--json', "Print Siren's preview as JSON"],
    },
    examples: ['siren recipes preview launch.recipe.json', 'siren recipes export | siren recipes preview -'],
    positionals: [1, 1],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesPreview,
  },
  'recipes apply': {
    usage: 'recipes apply <file|-> [flags]',
    summary: "Preview a recipe, ask, apply it, and follow the import to its end, then list each record it made by id. Siren applies the same recipe once, so a retry never imports it twice. Siren makes a recipe's programs, groups and distributors anew on each apply, so --again stops before it would copy one this organization has, unless --copy. Needs siren login: an API key can't apply recipes yet.",
    group: 'Recipes',
    short: 'Preview, ask, then apply a recipe',
    options: {
      yes: { type: 'boolean' },
      var: { type: 'string' },
      again: { type: 'boolean' },
      copy: { type: 'boolean' },
      'configuration-only': { type: 'boolean' },
      paused: { type: 'boolean' },
      'no-wait': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    flags: {
      yes: YES_FLAG,
      var: ['--var <key=id,…>', 'The record each of its variables uses, by id'],
      again: ['--again', 'Apply it again though it was applied before. Stops when that would copy a record here'],
      copy: ['--copy', 'With --again, make the copies anyway'],
      'configuration-only': ['--configuration-only', 'Leave out the people, mappings and group members'],
      paused: ['--paused', 'Make every program and distributor inactive'],
      'no-wait': ['--no-wait', 'Print the import id and stop, without following it'],
      json: ['--json', 'Print the preview, or the finished import, as JSON'],
    },
    examples: ['siren recipes apply launch.recipe.json', 'siren recipes show gold-partners | siren recipes apply - --yes'],
    positionals: [1, 1],
    sessionOnly: true,
    run: recipes.recipesApply,
  },
  'recipes status': {
    usage: 'recipes status <importId> [--json]',
    summary: 'Show one recipe import: how far each section got, the people added, updated, skipped and failed, and each failure.',
    group: 'Recipes',
    short: 'Show one recipe import',
    options: { json: { type: 'boolean' } },
    flags: { json: ['--json', 'Print the whole import, with every person, as JSON'] },
    examples: ['siren recipes status 7f3a9c'],
    positionals: [1, 1],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesStatus,
  },
  'recipes imports': {
    usage: 'recipes imports [--limit <n>] [--json]',
    summary: "List this organization's recent recipe imports, newest first.",
    group: 'Recipes',
    short: 'List recent recipe imports',
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    flags: { limit: ['--limit <n>', 'How many, 1 to 100. Siren sends 25 unless told'], json: JSON_FLAG },
    examples: ['siren recipes imports --limit 5'],
    positionals: [0, 0],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesImports,
  },
  'recipes export': {
    usage: 'recipes export [--include <sections>] [--sizes]',
    summary: "Print this organization's setup as a recipe, to save, edit, or apply elsewhere. What it leaves out, such as drafts, is named on standard error.",
    group: 'Recipes',
    short: "Print this organization's setup as a recipe",
    options: { include: { type: 'string' }, sizes: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: {
      include: ['--include <a,b>', 'Only these sections, such as programs,collaboratorGroups'],
      sizes: ['--sizes', 'Print how many records each section holds, and no recipe'],
      json: ['--json', 'With --sizes, print the counts as JSON'],
    },
    examples: ['siren recipes export > setup.recipe.json', 'siren recipes export --include programs,programGroups'],
    positionals: [0, 0],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesExport,
  },
  'recipes catalog': {
    usage: 'recipes catalog [filters] [--json]',
    summary: "List Beacon's ready-made recipes, with whether each fits this organization's store and plan.",
    group: 'Recipes',
    short: 'List ready-made recipes',
    options: {
      type: { type: 'string' },
      goal: { type: 'string' },
      tier: { type: 'string' },
      integrations: { type: 'string' },
      features: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
    flags: {
      type: ['--type <type>', 'Such as affiliate or referral'],
      goal: ['--goal <goal>', 'What the program is for'],
      tier: ['--tier <tier>', 'The plan it needs'],
      integrations: ['--integrations <a,b>', 'The stores and tools it works with'],
      features: ['--features <a,b>', 'The Siren features it needs'],
      search: ['--search <words>', 'Words in its name or description'],
      limit: ['--limit <n>', 'How many, 1 to 100'],
      json: JSON_FLAG,
    },
    examples: ['siren recipes catalog --type referral', 'siren recipes catalog --search partners'],
    positionals: [0, 0],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesCatalog,
  },
  'recipes show': {
    usage: 'recipes show <catalogId>',
    summary: 'Print one ready-made recipe from the catalog, to save, edit and apply.',
    group: 'Recipes',
    short: 'Print one ready-made recipe',
    options: {},
    flags: {},
    examples: ['siren recipes show gold-partners > partners.recipe.json'],
    positionals: [1, 1],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesShow,
  },
  'recipes fetch': {
    usage: 'recipes fetch <token|link>',
    summary: 'Print the recipe a Beacon handoff carries, from its token or the link Beacon gave.',
    group: 'Recipes',
    short: 'Print the recipe a Beacon handoff carries',
    options: {},
    flags: {},
    examples: ['siren recipes fetch <link> > beacon.recipe.json'],
    positionals: [1, 1],
    readsOnly: true,
    sessionOnly: true,
    run: recipes.recipesFetch,
  },
  notes: {
    usage: 'notes --on <type:id> [--search <words>] [--since <time>] [--limit <n>]',
    summary: "List a record's notes, newest first: the ones people wrote and the ones Siren writes as things happen. --on collaborator:1 names one record, and --on program reads every program's.",
    group: 'Notes',
    short: "List a record's notes",
    options: { on: { type: 'string', multiple: true }, search: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } },
    flags: {
      on: ['--on <type:id>', 'The record, such as collaborator:1, or a type alone'],
      search: ['--search <words>', 'Only notes that hold these words'],
      since: ['--since <time>', 'Only notes from then on: 2h, 7d, or a date'],
      limit: ['--limit <n>', 'How many, 1 to 100 (20)'],
      json: JSON_FLAG,
    },
    examples: ['siren notes --on collaborator:1', 'siren notes --on program:4 --since 7d --search payout'],
    positionals: [0, 0],
    readsOnly: true,
    run: notes.notesList,
  },
  'notes add': {
    usage: 'notes add <type:id> (<text> | --stdin)',
    summary: 'Add a note to a record. siren collaborators note 1 "Called about the March payout" is the same. A note changes no program, reward or payout, so a live organization takes it without --live.',
    group: 'Notes',
    short: 'Add a note to a record',
    options: { stdin: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: { stdin: ['--stdin', 'Read the text from standard input'], json: JSON_FLAG },
    examples: ['siren collaborators note 1 "Called about the March payout"', 'siren notes add program:4 --stdin < call.txt'],
    positionals: [1, 2],
    liveSafe: true,
    run: notes.notesAdd,
  },
  'notes edit': {
    usage: 'notes edit <id> (<text> | --stdin) [--revision <key>]',
    summary: "Change the text of a note you wrote. --revision sends the key siren notes --json shows, so Siren refuses the change when the note changed since.",
    group: 'Notes',
    short: 'Change a note you wrote',
    options: { stdin: { type: 'boolean' }, revision: { type: 'string' }, json: { type: 'boolean' } },
    flags: { stdin: ['--stdin', 'Read the text from standard input'], revision: ['--revision <key>', 'The revision you read, to refuse a stale change'], json: JSON_FLAG },
    examples: ['siren notes edit 42 "Called twice about the March payout"'],
    positionals: [1, 2],
    liveSafe: true,
    run: notes.notesEdit,
  },
  'notes delete': {
    usage: 'notes delete <id> [--yes]',
    summary: "Delete a note you wrote, or any note as an admin. The record's notes keep a line saying a note was deleted.",
    group: 'Notes',
    short: 'Delete a note',
    options: { yes: { type: 'boolean' } },
    flags: { yes: YES_FLAG },
    examples: ['siren notes delete 42 --yes'],
    positionals: [1, 1],
    liveSafe: true,
    run: notes.notesDelete,
  },
  'condition-sets list': {
    usage: 'condition-sets list [--json]',
    summary: 'List the condition sets, the saved lists of conditions Siren checks each day, such as joined in the last 30 days, with when Siren last checked each.',
    group: 'Condition sets',
    short: 'List the condition sets',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren condition-sets list'],
    positionals: [0, 0],
    readsOnly: true,
    run: conditionSets.conditionSetsList,
  },
  'condition-sets get': {
    usage: 'condition-sets get <id> [--json]',
    summary: "Show one condition set: its conditions in Siren's words, when Siren last checked it, and the enrollers that use it.",
    group: 'Condition sets',
    short: 'Show one condition set',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren condition-sets get 1'],
    positionals: [1, 1],
    readsOnly: true,
    run: conditionSets.conditionSetsGet,
  },
  'condition-sets matches': {
    usage: 'condition-sets matches (<id> | <file> | -) [--limit <n>] [--json]',
    summary: 'Count who matches a condition set now and name the first few. Given a file, or - for standard input, it counts who would match conditions not yet saved, and saves nothing.',
    group: 'Condition sets',
    short: 'Count and name who matches now',
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    flags: { limit: ['--limit <n>', 'How many people to name, 1 to 25 (5)'], json: JSON_FLAG },
    examples: ['siren condition-sets matches 1', 'siren condition-sets matches draft.json'],
    positionals: [1, 1],
    readsOnly: true,
    run: conditionSets.conditionSetsMatches,
  },
  'condition-sets create': {
    usage: 'condition-sets create (<file> | -) [--json]',
    summary: 'Make a condition set from JSON with name and conditions. siren condition-sets conditions lists the conditions and the values each takes, and siren condition-sets matches <file> counts its matches before you make it.',
    group: 'Condition sets',
    short: 'Make a condition set from JSON',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren condition-sets create joined-this-month.json'],
    positionals: [1, 1],
    run: conditionSets.conditionSetsCreate,
  },
  'condition-sets conditions': {
    usage: 'condition-sets conditions [--json]',
    summary: 'List the conditions a set can use, each with its sentence and the values it takes.',
    group: 'Condition sets',
    short: 'List the conditions a set can use',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren condition-sets conditions'],
    positionals: [0, 0],
    readsOnly: true,
    run: conditionSets.conditionSetsConditions,
  },
  'enrollers list': {
    usage: 'enrollers list [--status <status>] [--json]',
    summary: 'List the enrollers, the rules that add people to programs, distributors and groups, or take them out, when something happens to them.',
    group: 'Enrollers',
    short: 'List the enrollers',
    options: { status: { type: 'string' }, json: { type: 'boolean' } },
    flags: { status: ['--status <status>', 'Only enrollers in this status, such as active'], json: JSON_FLAG },
    examples: ['siren enrollers list', 'siren enrollers list --status active'],
    positionals: [0, 0],
    readsOnly: true,
    run: enrollers.enrollersList,
  },
  'enrollers get': {
    usage: 'enrollers get <id> [--json]',
    summary: 'Show one enroller: what starts it, what it does, and its latest log lines.',
    group: 'Enrollers',
    short: 'Show one enroller',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren enrollers get 1'],
    positionals: [1, 1],
    readsOnly: true,
    run: enrollers.enrollersGet,
  },
  'enrollers log': {
    usage: 'enrollers log <id> [--limit <n>] [--json]',
    summary: 'Show what an enroller did, newest first: who it added or took out, and why it skipped someone.',
    group: 'Enrollers',
    short: 'Show what an enroller did',
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    flags: { limit: ['--limit <n>', 'How many lines, 1 to 100 (20)'], json: JSON_FLAG },
    examples: ['siren enrollers log 1'],
    positionals: [1, 1],
    readsOnly: true,
    run: enrollers.enrollersLog,
  },
  'enrollers run': {
    usage: 'enrollers run <id> [--yes] [--json]',
    summary: "Run an enroller now on everyone who matches. It says how many people would move first, then asks. It moves people, so a live organization needs --live.",
    group: 'Enrollers',
    short: 'Run an enroller now',
    options: { yes: { type: 'boolean' }, json: { type: 'boolean' } },
    flags: { yes: YES_FLAG, json: JSON_FLAG },
    examples: ['siren enrollers run 2'],
    positionals: [1, 1],
    run: enrollers.enrollersRun,
  },
  'enrollers create': {
    usage: 'enrollers create (<file> | -) [--json]',
    summary: 'Make an enroller from JSON: name, triggerId and triggerArgs, and the programs, distributors or groups it adds people to or takes them out of. siren enrollers get <id> --json shows the fields.',
    group: 'Enrollers',
    short: 'Make an enroller from JSON',
    options: { json: { type: 'boolean' } },
    flags: { json: JSON_FLAG },
    examples: ['siren enrollers create welcome.json'],
    positionals: [1, 1],
    run: enrollers.enrollersCreate,
  },
};

/** The command table, for tests that hold other lists to it. */
export const COMMAND_SPECS: Readonly<Record<Command, Readonly<CommandSpec>>> = SPECS;

/** Every option any command takes, for the first read of the line, which finds the command. */
const ALL_OPTIONS: Options = Object.assign({ version: { type: 'boolean', short: 'v' } }, GLOBAL, records.OPTIONS, ...Object.values(SPECS).map((spec) => spec.options));

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

/** The record commands, generated from Siren's API, as the top help lists them. */
function recordRows(style: Style): string[] {
  return columns(
    [
      ['<resource> <op>', 'List, get, create, update or delete a record'],
      ['get <path>', 'Read any route, such as get /programs'],
      ['post <path>', 'Write to any route, and put, patch and delete'],
      ['resources', 'List the resources and their operations'],
    ],
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
    ...GROUPS.flatMap((group) =>
      group === 'Records'
        ? section(style, group, recordRows(style))
        : section(style, group, commandRows(style, COMMANDS.filter((command) => SPECS[command].group === group))),
    ),
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
/** The words that start a two-word command, such as `apps` in `siren apps list`. */
const GROUP_WORDS = ['apps', 'logs', 'sandbox', 'recipes', 'condition-sets', 'enrollers'] as const;

/** The text `siren recipes` prints: what recipes are for, and the commands. */
function recipesHelpText(style: Style): string {
  return [
    ...wrap("Preview and apply a recipe, a file that sets up programs, groups and people at once, follow its import, and export this organization's setup as one. Needs siren login: an API key can't use recipes yet.", style.width),
    '',
    ...section(style, 'Usage', ['  siren recipes <command> [flags]']),
    ...section(style, 'Recipes', commandRows(style, COMMANDS.filter((command) => command.startsWith('recipes ')))),
    ...section(style, 'Learn more', learnMore(style, true)),
  ].join('\n');
}

/** What `siren condition-sets` and `siren enrollers` print alone: what they are, and their commands. */
const GROUP_SUMMARIES = {
  'condition-sets': "Condition sets are saved lists of conditions Siren checks each day, such as joined in the last 30 days. See who matches one now, and make one from JSON. Siren's plan must include them.",
  enrollers: 'Enrollers add people to programs, distributors and groups, or take them out, when something happens to them. See what each does and did, and run one now. A Siren without enrollers says so.',
} as const;

function groupHelpText(style: Style, group: keyof typeof GROUP_SUMMARIES): string {
  return [
    ...wrap(GROUP_SUMMARIES[group], style.width),
    '',
    ...section(style, 'Usage', [`  siren ${group} <command> [flags]`]),
    ...section(style, group === 'enrollers' ? 'Enrollers' : 'Condition sets', commandRows(style, COMMANDS.filter((command) => command.startsWith(`${group} `)))),
    ...section(style, 'Learn more', learnMore(style, true)),
  ].join('\n');
}

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
  // A first word that is a command alone and starts a two-word one, such as trigger and trigger ask, is the two-word one when its second word matches.
  const pair = `${words[0] ?? ''} ${words[1] ?? ''}`.trim();
  if (words[0] !== 'apps' && (COMMANDS as readonly string[]).includes(pair)) return pair as Command;
  const name = (GROUP_WORDS as readonly string[]).includes(words[0] ?? '') ? `${words[0]} ${words[1] ?? ''}`.trim() : (words[0] ?? '');
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
  const group: CommandUnknown['group'] = (words[0] === 'apps' || words[0] === 'recipes') && words.length > 1 ? `siren ${words[0]}` : 'siren';
  const word = group === 'siren' ? name : (words[1] ?? '');
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
  let name: string | undefined;
  let login = 'siren login';
  // What a refusal names: the arguments typed after the command, and its hint command lines.
  let typedArgs: readonly string[] = [];
  let hintCommand = (words: string) => `siren ${words}`;
  // The Siren a failed command was talking to, for the line --verbose adds.
  let targetUrl: string | undefined;
  // Stills the first-run welcome when the command ends, if no output stilled it first.
  let settle = async () => undefined as void;
  try {
    let loose = parseArgs({ args: [...argv], options: ALL_OPTIONS, strict: false, allowPositionals: true });
    // siren collaborators note 1 "…" is siren notes add collaborator:1 "…".
    const rewritten = notes.noteShorthand(argv, loose.positionals);
    if (rewritten !== argv) {
      argv = rewritten;
      loose = parseArgs({ args: [...argv], options: ALL_OPTIONS, strict: false, allowPositionals: true });
    }
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
    if (words[0] === 'recipes' && words.length === 1) {
      io.stdout(recipesHelpText(styleFor(io, 'stdout', {})));
      return 0;
    }
    if ((words[0] === 'condition-sets' || words[0] === 'enrollers') && words.length === 1) {
      io.stdout(groupHelpText(styleFor(io, 'stdout', {}), words[0]));
      return 0;
    }

    const record = records.commandFor(words);
    if (record !== undefined) {
      name = record.name;
      spec = record.spec;
    } else {
      const named = commandNamed(words);
      name = named;
      spec = SPECS[named];
    }
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
      : new CommandContext(io, resolveTarget(flags, io.env, await remembered(io)), spec.readsOnly === true || spec.liveSafe === true, spec.sessionOnly === true ? name : undefined, [name, ...args].join(' '));
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
function asRefusal(error: unknown, baseUrl: string | undefined, typed: { name: string | undefined; args: readonly string[]; command: (words: string) => string }): CliRefusal {
  if (error instanceof CliRefusal) return error;
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Siren: /, '');
  const host = baseUrl === undefined ? 'Siren' : hostName(baseUrl);
  if (error instanceof ConnectionError) {
    return new CliRefusal(`Lost the connection to ${host}.`, { why: message, fixText: 'Try again. --verbose shows the request.', detail: httpDetail(error, baseUrl) });
  }
  if (!(error instanceof SirenError)) {
    // --verbose adds the stack, which is what support needs from a fault inside the tool.
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack.split('\n').slice(1).map((line) => line.trimEnd()) : [];
    return new CliRefusal('Something went wrong inside the tool.', { why: message, fixText: 'Run it again with --verbose, and send the output to Siren support.', detail: stack });
  }
  const detail = httpDetail(error, baseUrl);
  // A validation failure on any hand-written command gets the same rows as a generated one.
  const problems = fieldProblems(error);
  if (problems.length > 0) {
    return new CliRefusal(`${host} refused it.`, {
      why: fieldsLine(problems),
      problems,
      problemsAs: 'rows',
      ...(typed.name === undefined ? { fixText: 'Fix them and run again.' } : { fixLead: `Fix ${problems.length === 1 ? 'it' : 'them'} and run again.`, fix: `siren ${typed.name} --help`, fixWords: 'lists what it takes' }),
      detail,
    });
  }
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
    readonly group: 'siren' | 'siren apps' | 'siren recipes',
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
