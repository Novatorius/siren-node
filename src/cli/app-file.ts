import type { AppConversionType, AppFeatureDeclaration, CustomEventField, DeclareAppParams } from '../record-types';
import { FeatureKind } from '../taxonomy';
import { kindLabel, kindName } from './app-kinds';
import { suggestions } from './suggest';

/*
 * The app file, `siren.app.json`: a Siren recipe that holds one `apps`
 * stanza. Contract: docs/architecture/apps-cli.md, "The app file".
 *
 *   {
 *     "version": 1,
 *     "name": "Acme payouts",
 *     "description": "Pays collaborators through Acme's ledger.",
 *     "apps": {
 *       "acme-payouts": {
 *         "name": "Acme payouts",
 *         "url": "${SIREN_APP_URL}",
 *         "scopes": [],
 *         "events": [],
 *         "contacts": ["ops@example.com"],
 *         "features": {
 *           "notify-crm": { "kind": "postConversionAction", "name": "Tell the CRM" },
 *           "acme-ledger": { "kind": "payoutMethod", "name": "Acme ledger", "currencies": ["USD"] },
 *           "signup": {
 *             "kind": "customEvent",
 *             "name": "Newsletter signup",
 *             "fields": { "list": { "type": "string", "required": true } },
 *             "domains": ["example.com", "*.example.com"]
 *           }
 *         }
 *       }
 *     }
 *   }
 */

/**
 * The top `description` `apps init` and `apps pull` write, so a person who
 * opens the file learns it is a Siren recipe and what sends it (CLI pass 2,
 * finding 4, declined: the file keeps the recipe shape).
 */
export const RECIPE_NOTE = 'A Siren recipe that sets up one app. siren apps apply sends it to Siren.';

/** The file name `apps init` writes and `apps apply` reads when given none. */
export const APP_FILE_NAME = 'siren.app.json';

/**
 * One feature as the file declares it, keyed by its feature key in `items`.
 * The code calls a feature an item. Its kind and key lock once Siren makes
 * it, so a renamed key is a new feature and the old one is archived or
 * deleted.
 */
export interface AppFileItem {
  kind: FeatureKind;
  name: string;
  description?: string;
  currencies?: string[];
  answerWindowMinutes?: number;
  /** A metric calculation's setting: whether its score is an amount of money in the distributor's currency. */
  scoresMoney?: boolean;
  /** An incentive type's setting: the conversions it pays, each once, from sale, lead and renewal. */
  conversionTypes?: AppConversionType[];
  /** A custom event's fields: each field name to `{type, required}`. */
  fields?: Record<string, CustomEventField>;
  /**
   * A custom event's allowed domains, such as `example.com` or
   * `*.example.com`: the websites whose pages may send it from a visitor's
   * browser. Left out or empty, only the app's server may send it.
   */
  domains?: string[];
}

/** One app as the file declares it, keyed by its app key in `apps`. */
export interface AppFileApp {
  name: string;
  description?: string;
  /** The app's address. Left out, the app is key-only, and it may hold only custom events. */
  url?: string;
  scopes?: string[];
  events?: string[];
  /**
   * The problem contacts: email addresses Siren tells when something is
   * wrong with the app, at most ten. Left out, the app keeps the contacts it
   * has, such as ones a person added in the dashboard. With none, the org's
   * admins hear instead.
   */
  contacts?: string[];
  /** The app's features, each under its feature key. */
  features?: Record<string, AppFileItem>;
}

/** A checked app file, with every `${NAME}` already filled from the environment. */
export interface AppFile {
  /** The JSON schema an editor completes the file from, which the tool ignores. */
  $schema?: string;
  version: 1;
  /**
   * The slug of the organization the app belongs to, for a person in
   * several. The commands act there unless --org or SIREN_ORG names another.
   */
  org?: string;
  /** A recipe's name. The tool sends only the app's own name, which the dashboard shows. */
  name?: string;
  /** A recipe's description. The tool sends only the app's own. */
  description?: string;
  /** Exactly one app in the first step. */
  apps: Record<string, AppFileApp>;
}

/**
 * One problem with the file. `path` is the dotted key it sits at, such as
 * `apps.acme-payouts.features.notify-crm.kind`, or empty for the whole file.
 * `line` and `column` count from 1 and point at that key in the text, or at
 * the character JSON could not read.
 */
export interface AppFileProblem {
  path: string;
  line: number;
  column: number;
  message: string;
}

/**
 * Reads and checks an app file's text before anything is sent. Answers the
 * file, or every problem found, each naming its key and line. The rules are
 * in the architecture note, "The app file". `${NAME}` is filled from `env`
 * only in the app's `url` and only for a name that starts `SIREN_APP_`. A
 * placeholder anywhere else, any other name, or a name `env` lacks is a
 * problem at that key. `filled` lists the names it filled, never a value.
 *
 * A JSON mistake answers one problem, at the character the reader stopped
 * at, with the path empty. No problem's message holds a value from the file
 * or the environment, so printing the problems prints no filled address.
 */
export function parseAppFile(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): { file: AppFile; problems: []; filled: string[] } | { file: null; problems: AppFileProblem[] } {
  const reader = new JsonReader(text);
  let value: unknown;
  try {
    value = reader.readDocument();
  } catch (error) {
    if (error instanceof JsonMistake) return { file: null, problems: [error.problem] };
    throw error;
  }

  const check = new AppFileCheck(reader.places, env);
  const file = check.run(value);
  const problems = [...reader.problems, ...check.problems];
  if (file === null || problems.length > 0) return { file: null, problems };
  return { file, problems: [], filled: [...check.filled] };
}

/**
 * The declaration `PUT /apps/{key}` takes for the file's one app: its
 * fields as they are, and `items` turned from a map into a list in the
 * file's order, each with its `key`. A field the file leaves out stays out.
 */
export function declarationFor(file: AppFile): { key: string; params: DeclareAppParams } {
  const [key = ''] = Object.keys(file.apps);
  const app = file.apps[key] as AppFileApp;
  const params: DeclareAppParams = { name: app.name, ...(app.description === undefined ? {} : { description: app.description }) };
  if (app.url !== undefined) params.url = app.url;
  if (app.scopes !== undefined) params.scopes = [...app.scopes];
  if (app.events !== undefined) params.events = [...app.events];
  if (app.contacts !== undefined) params.contacts = storedContacts(app.contacts);
  if (app.features !== undefined) {
    params.features = Object.entries(app.features).map(([featureKey, item]) => {
      const declared: AppFeatureDeclaration = { kind: item.kind, key: featureKey, name: item.name };
      if (item.description !== undefined) declared.description = item.description;
      if (item.currencies !== undefined) declared.currencies = [...item.currencies];
      if (item.answerWindowMinutes !== undefined) declared.answerWindowMinutes = item.answerWindowMinutes;
      if (item.scoresMoney !== undefined) declared.scoresMoney = item.scoresMoney;
      if (item.conversionTypes !== undefined) declared.conversionTypes = CONVERSION_TYPES.filter((type) => item.conversionTypes!.includes(type));
      if (item.fields !== undefined) declared.fields = { ...item.fields };
      if (item.domains !== undefined) declared.domains = [...item.domains];
      return declared;
    });
  }
  return { key, params };
}

/**
 * Where `apps init` points `$schema`: the schema this version of the package
 * ships, on unpkg, which serves every npm package's files. It resolves from
 * any folder, with the tool installed globally, locally or run through npx.
 * Keep the version in step with package.json, as `CLI_VERSION` is.
 */
export const APP_FILE_SCHEMA_PATH = 'https://unpkg.com/@novatorius/siren@0.4.0/siren.app.schema.json';

/**
 * The text `apps init` writes: a file that passes {@link parseAppFile} once
 * `SIREN_APP_URL` is set, declaring the app `key` named `name` with one
 * Post-conversion action, `notify`, the plainest feature, and the schema an
 * editor completes the rest from.
 */
export function appFileTemplate(key: string, name: string, org?: string): string {
  const file = {
    $schema: APP_FILE_SCHEMA_PATH,
    version: 1,
    ...(org === undefined ? {} : { org }),
    description: RECIPE_NOTE,
    apps: {
      [key]: {
        name,
        url: '${SIREN_APP_URL}',
        features: {
          notify: { kind: 'postConversionAction', name: 'Tell my service about each approved conversion' },
        },
      },
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A place in the text, counted from 1. */
interface Place {
  line: number;
  column: number;
}

/** The keys a Siren recipe holds beside `version`, `name` and `description` (lib/Recipes/Core/recipe.schema.json). */
const RECIPE_KEYS = [
  'recipeId',
  'tracking',
  'commerce',
  'customEvents',
  'programs',
  'programGroups',
  'distributors',
  'collaboratorGroups',
  'collaborators',
  'products',
  'mappings',
  'currencies',
  'autofulfillers',
  'notifications',
];

/** The keys an app file holds at its top. */
export const TOP_FIELDS = ['$schema', 'version', 'org', 'name', 'description', 'apps'];

/** The fields `PUT /apps/{key}` reads (DeclareApp.php), with the features under `features` (contract/feature-rename.md, section 4). */
export const APP_FIELDS = ['name', 'description', 'url', 'scopes', 'events', 'contacts', 'features'];

/** The word an app's features went under before Alex's ruling M104, which a file may still hold and the tool refuses by name. */
const OLD_FEATURES_FIELD = 'items';

/** The most features an app may hold, `AppService::MAX_ITEMS`. */
export const MAX_FEATURES = 50;

/** The most problem contacts an app may hold, `AppService::MAX_CONTACTS`. */
export const MAX_CONTACTS = 10;

/** An email address in its plainest shape. Siren checks each one fully when the file is applied. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Problem contacts as Siren stores them: trimmed, lowercased, blanks left
 * out, each once, in the order given (`AppService::validatedContacts()`).
 */
export function storedContacts(contacts: readonly string[]): string[] {
  const clean: string[] = [];
  for (const contact of contacts) {
    const address = contact.trim().toLowerCase();
    if (address !== '' && !clean.includes(address)) clean.push(address);
  }
  return clean;
}

/** The fields Siren stores for a feature (AppService, "Items"). */
export const ITEM_FIELDS = ['kind', 'name', 'description', 'currencies', 'answerWindowMinutes', 'scoresMoney', 'conversionTypes', 'fields', 'domains'];

/**
 * The conversions an incentive type may pay, in the order Siren's kinds
 * catalog lists them (AppItemKindCatalog.php, the `conversionTypes` choices),
 * the order a declaration sends them in.
 */
export const CONVERSION_TYPES: readonly AppConversionType[] = ['sale', 'lead', 'renewal'];

/** The most allowed domains one custom event takes, `AllowedDomains::MAX_PATTERNS`. */
export const MAX_DOMAINS = 20;

/** One label of a host, as Siren's `AllowedDomains` reads it. */
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

/**
 * Siren's feature kinds (lib/Apps/Core/Enums/AppItemKinds.php), each once:
 * `FeatureKind.FulfillmentMethod` is an alias of `payoutMethod`.
 */
export const KINDS: readonly string[] = [...new Set<string>(Object.values(FeatureKind))];

/** The payout kind's old word, which Siren refuses since it took the documentation's. */
const OLD_PAYOUT_KIND = 'fulfillmentMethod';

/** The app keys Siren keeps for its own routes (`AppService::RESERVED_KEYS`). */
export const RESERVED_APP_KEYS = ['requests', 'events', 'scopes', 'kinds'];

/** An app or feature key, as Siren's `AppService::KEY_PATTERN` reads it, at most 64 characters. */
export const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The longest answer window Siren takes, `AppService::ANSWER_WINDOW_MAX_MINUTES`. */
export const MAX_ANSWER_WINDOW_MINUTES = 43200;

/** The hosts an app's url may reach over plain http, which only a local Cloud reaches. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];

/** One `${NAME}` placeholder. */
const PLACEHOLDER = /\$\{([^}]*)\}/g;

/** A run of string characters that need no escape. JSON refuses a raw control character, a line break included. */
const PLAIN = /[^"\\\u0000-\u001f]+/y;

/** A JSON number, exactly as JSON reads one. */
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The one-letter escapes JSON reads, and what each stands for. */
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((member) => typeof member === 'string');
}

/**
 * Why Siren would refuse this allowed domain, or null when it takes it.
 * Mirrors `AllowedDomains::problemWith()` on Siren: a host, lowercased, or
 * `*.` and a host of two labels or more.
 */
export function domainProblem(pattern: string): string | null {
  const domain = pattern.trim().toLowerCase();
  if (domain === '*') return 'a bare * would let every website send the event. Name a domain, such as example.com or *.example.com';
  if (domain.includes('/') || domain.includes(':')) return 'write the domain alone, such as shop.example.com, with no scheme, port or path';
  const wildcard = domain.startsWith('*.');
  const host = wildcard ? domain.slice(2) : domain;
  if (host.includes('*')) return 'a * may only lead a domain, as in *.example.com';
  if (host.length > 253 || !HOST.test(host)) return 'write a host name of letters, digits, dots and dashes, such as shop.example.com';
  if (wildcard && !host.includes('.')) return 'a * must lead a domain of two parts or more, such as *.example.com';
  return null;
}

function isKey(value: string): boolean {
  return value.length <= 64 && KEY.test(value);
}

/** True for an address Siren can send requests to: https, or http to a local Cloud's host. */
function isAppUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname));
}

/** Sets an own key as JSON.parse does, so a key such as `__proto__` stays a plain key. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The first JSON mistake in the text. The reader stops there. */
class JsonMistake extends Error {
  constructor(readonly problem: AppFileProblem) {
    super(problem.message);
  }
}

/**
 * A JSON reader that knows where each key sits. It reads what `JSON.parse`
 * reads and refuses what it refuses, at the line and column of the
 * character it stopped at, or of the string that holds a raw control
 * character. A key written twice in one object is a problem at the second
 * one, and the reader goes on.
 */
class JsonReader {
  /** The index of the next character to read. */
  at = 0;
  /** Keys written twice. */
  readonly problems: AppFileProblem[] = [];
  /** Where each dotted path's key sits, or for the whole file and a list member, its value. */
  readonly places = new Map<string, Place>();
  private readonly lineStarts: number[] = [0];

  constructor(private readonly text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\n') this.lineStarts.push(index + 1);
    }
  }

  /** The whole text as one value, with nothing after it. */
  readDocument(): unknown {
    const value = this.readValue('');
    this.skipSpace();
    if (this.at < this.text.length) this.fail(this.at, 'The file goes on after its JSON object ends.');
    return value;
  }

  /** The line and column of `index`. */
  placeOf(index: number): Place {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.lineStarts[middle] as number) <= index) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: index - (this.lineStarts[low] as number) + 1 };
  }

  private fail(index: number, message: string): never {
    throw new JsonMistake({ path: '', ...this.placeOf(index), message });
  }

  /** What sits at `index`, for a message. */
  private found(index: number): string {
    return index >= this.text.length ? 'the end of the file' : JSON.stringify(this.text[index]);
  }

  private skipSpace(): void {
    while (this.at < this.text.length && ' \t\n\r'.includes(this.text[this.at] as string)) this.at += 1;
  }

  /** Skips white space and answers the next character, moving past it, or `''` at the end. */
  private next(): string {
    this.skipSpace();
    const character = this.text.charAt(this.at);
    this.at += 1;
    return character;
  }

  private readValue(path: string): unknown {
    this.skipSpace();
    const start = this.at;
    if (!this.places.has(path)) this.places.set(path, this.placeOf(start));
    const character = this.text[start];
    if (character === '{') return this.readObject(path);
    if (character === '[') return this.readArray(path);
    if (character === '"') return this.readString();
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) return this.readNumber();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(word, start)) {
        this.at += word.length;
        return value;
      }
    }
    return this.fail(start, `JSON cannot hold ${this.found(start)} here. Write a string in double quotes, a number, an object, a list, true, false or null.`);
  }

  private readObject(path: string): Record<string, unknown> {
    this.at += 1;
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipSpace();
    if (this.text[this.at] === '}') {
      this.at += 1;
      return result;
    }
    for (;;) {
      this.skipSpace();
      const keyAt = this.at;
      if (this.text[keyAt] !== '"') this.fail(keyAt, `Expected a key in double quotes, and found ${this.found(keyAt)}.`);
      const key = this.readString();
      const keyPath = path === '' ? key : `${path}.${key}`;
      const twice = seen.has(key);
      if (twice) this.problems.push({ path: keyPath, ...this.placeOf(keyAt), message: `${keyPath} is written twice. Keep one.` });
      else this.places.set(keyPath, this.placeOf(keyAt));
      seen.add(key);

      if (this.next() !== ':') {
        this.at -= 1;
        this.fail(this.at, `Expected a colon after the key, and found ${this.found(this.at)}.`);
      }
      const value = this.readValue(keyPath);
      if (!twice) define(result, key, value);

      const next = this.next();
      if (next === '}') return result;
      if (next !== ',') {
        this.at -= 1;
        this.fail(this.at, `Expected a comma or a closing brace, and found ${this.found(this.at)}.`);
      }
    }
  }

  private readArray(path: string): unknown[] {
    this.at += 1;
    const items: unknown[] = [];
    this.skipSpace();
    if (this.text[this.at] === ']') {
      this.at += 1;
      return items;
    }
    for (;;) {
      items.push(this.readValue(`${path}.${items.length}`));
      const next = this.next();
      if (next === ']') return items;
      if (next !== ',') {
        this.at -= 1;
        this.fail(this.at, `Expected a comma or a closing bracket, and found ${this.found(this.at)}.`);
      }
    }
  }

  private readString(): string {
    const start = this.at;
    this.at += 1;
    let out = '';
    for (;;) {
      PLAIN.lastIndex = this.at;
      const run = PLAIN.exec(this.text);
      if (run !== null) {
        out += run[0];
        this.at += run[0].length;
      }
      const character = this.text[this.at];
      if (character === '"') {
        this.at += 1;
        return out;
      }
      if (character === undefined) this.fail(start, 'This string is not closed before the end of the file.');
      if (character !== '\\') {
        this.fail(start, 'This string holds a raw line break or another control character. Write it with a backslash escape, such as \\n.');
      }
      const escape = this.text[this.at + 1];
      if (escape !== undefined && escape in ESCAPES) {
        out += ESCAPES[escape];
        this.at += 2;
      } else if (escape === 'u' && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.at + 2, this.at + 6))) {
        out += String.fromCharCode(parseInt(this.text.slice(this.at + 2, this.at + 6), 16));
        this.at += 6;
      } else {
        this.fail(this.at, 'JSON does not read this backslash escape.');
      }
    }
  }

  private readNumber(): number {
    const start = this.at;
    NUMBER.lastIndex = start;
    const match = NUMBER.exec(this.text);
    if (match === null) this.fail(start, `JSON cannot read a number at ${this.found(start)}.`);
    this.at += match[0].length;
    return Number(match[0]);
  }
}

/**
 * The app file's rules, run on what the reader read. It fills `${NAME}` in
 * the app's url, collects every problem with its place, and answers the file
 * when the shape allows one.
 */
class AppFileCheck {
  readonly problems: AppFileProblem[] = [];
  /** The variables filled, by name, in the order first filled. */
  readonly filled = new Set<string>();
  /** Paths whose placeholder could not be filled, so their own checks would only repeat the problem. */
  private readonly unfilled = new Set<string>();

  constructor(
    private readonly places: ReadonlyMap<string, Place>,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  run(value: unknown): AppFile | null {
    if (!isObject(value)) {
      this.problem('', this.where(''), 'An app file is a JSON object.');
      return null;
    }
    const top = this.fill(value, '') as Record<string, unknown>;

    for (const key of Object.keys(top)) {
      if (TOP_FIELDS.includes(key)) continue;
      this.problem(
        key,
        this.where(key),
        RECIPE_KEYS.includes(key)
          ? `${key} is a recipe stanza, and an app file holds only apps for now. Keep ${key} in a recipe of its own.`
          : `${key} is not a recipe key. An app file holds ${TOP_FIELDS.join(', ')}.`,
      );
    }
    if (top.version !== 1) this.problem('version', this.where('version'), 'version is required, and must be 1.');
    if (top.$schema !== undefined && typeof top.$schema !== 'string') this.problem('$schema', this.where('$schema'), '$schema must be text.');
    if (top.org !== undefined && (typeof top.org !== 'string' || top.org.trim() === '')) {
      this.problem('org', this.where('org'), "org must be the slug of one of your organizations, such as acme. siren orgs lists them.");
    }
    if (top.name !== undefined && typeof top.name !== 'string') this.problem('name', this.where('name'), 'name must be text.');
    if (top.description !== undefined && typeof top.description !== 'string') this.problem('description', this.where('description'), 'description must be text.');

    const apps = top.apps;
    if (!isObject(apps)) {
      this.problem('apps', this.where('apps'), 'apps is required: an object that holds one app under its app key.');
      return null;
    }
    const appKeys = Object.keys(apps);
    if (appKeys.length === 0) {
      this.problem('apps', this.where('apps'), 'apps holds no app. Write the app under its app key, such as "acme-payouts": { ... }.');
    } else if (appKeys.length > 1) {
      // The env file beside the file holds one SIREN_API_KEY, so a folder holds one app.
      this.problem(
        'apps',
        this.where('apps'),
        `apps holds ${appKeys.length} apps, and a file holds one, since the env file beside it keeps that one app's key. Give each app a folder of its own.`,
      );
    }
    for (const appKey of appKeys) this.checkApp(appKey, apps[appKey]);
    return top as unknown as AppFile;
  }

  private checkApp(appKey: string, app: unknown): void {
    const path = `apps.${appKey}`;
    if (!isKey(appKey) || RESERVED_APP_KEYS.includes(appKey)) {
      this.problem(
        path,
        this.where(path),
        `${path}: an app key is lowercase letters and digits joined by single dashes, at most 64 characters, and never requests, events, scopes or kinds.`,
      );
    }
    if (!isObject(app)) {
      this.problem(path, this.where(path), `${path} must be an object.`);
      return;
    }
    for (const field of Object.keys(app)) {
      if (field === OLD_FEATURES_FIELD) {
        this.problem(`${path}.${field}`, this.where(`${path}.${field}`), `${path}.${field}: Siren calls an app's features "features" now. Write them under features.`);
      } else if (!APP_FIELDS.includes(field)) {
        this.problem(`${path}.${field}`, this.where(`${path}.${field}`), `${path}.${field} is not an app field. An app takes ${APP_FIELDS.join(', ')}.`);
      }
    }
    if (typeof app.name !== 'string' || app.name === '') {
      this.problem(`${path}.name`, this.where(`${path}.name`), `${path}.name is required, as text.`);
    }
    if (app.description !== undefined && typeof app.description !== 'string') {
      this.problem(`${path}.description`, this.where(`${path}.description`), `${path}.description must be text.`);
    }
    const urlPath = `${path}.url`;
    if (app.url !== undefined && !this.unfilled.has(urlPath) && (typeof app.url !== 'string' || !isAppUrl(app.url))) {
      this.problem(
        urlPath,
        this.where(urlPath),
        `${urlPath} must be an https address, or http to localhost, 127.0.0.1 or host.docker.internal for a local Cloud.`,
      );
    }
    for (const list of ['scopes', 'events']) {
      if (app[list] !== undefined && !isTextList(app[list])) {
        this.problem(`${path}.${list}`, this.where(`${path}.${list}`), `${path}.${list} must be a list of text.`);
      }
    }
    if (app.contacts !== undefined) this.checkContacts(`${path}.contacts`, app.contacts);
    const features = app.features;
    if (features === undefined) return;
    if (!isObject(features)) {
      this.problem(`${path}.features`, this.where(`${path}.features`), `${path}.features must be an object that holds each feature under its feature key.`);
      return;
    }
    const count = Object.keys(features).length;
    if (count > MAX_FEATURES) {
      this.problem(`${path}.features`, this.where(`${path}.features`), `${path}.features holds ${count} features, and an app may hold at most ${MAX_FEATURES}.`);
    }
    const needAddress = Object.values(features).some((item) => !isObject(item) || item.kind !== FeatureKind.CustomEvent);
    if (app.url === undefined && needAddress) {
      this.problem(
        `${path}.features`,
        this.where(`${path}.features`),
        `${path} has features and no url. Siren sends a feature its requests at the app's address, so add a url, or keep only custom events for a key-only app.`,
      );
    }
    for (const [featureKey, feature] of Object.entries(features)) this.checkItem(`${path}.features.${featureKey}`, featureKey, feature);
  }

  /** The problem contacts: a list of at most {@link MAX_CONTACTS} email addresses, counted once each. */
  private checkContacts(path: string, contacts: unknown): void {
    if (!isTextList(contacts)) {
      this.problem(path, this.where(path), `${path} must be a list of email addresses.`);
      return;
    }
    contacts.forEach((contact, index) => {
      const at = `${path}.${index}`;
      if (contact.trim() !== '' && !EMAIL.test(contact.trim())) this.problem(at, this.where(at), `${at} is not an email address.`);
    });
    if (storedContacts(contacts).length > MAX_CONTACTS) {
      this.problem(path, this.where(path), `${path} holds more than ${MAX_CONTACTS} addresses, and an app may have at most ${MAX_CONTACTS} problem contacts.`);
    }
  }

  private checkItem(path: string, itemKey: string, entry: unknown): void {
    if (!isKey(itemKey)) {
      this.problem(path, this.where(path), `${path}: a feature key is lowercase letters and digits joined by single dashes, at most 64 characters.`);
    }
    if (!isObject(entry)) {
      this.problem(path, this.where(path), `${path} must be an object.`);
      return;
    }
    for (const field of Object.keys(entry)) {
      if (!ITEM_FIELDS.includes(field)) {
        this.problem(`${path}.${field}`, this.where(`${path}.${field}`), `${path}.${field} is not a feature field. A feature takes ${ITEM_FIELDS.join(', ')}.`);
      }
    }
    if (entry.kind === OLD_PAYOUT_KIND) {
      this.problem(
        `${path}.kind`,
        this.where(`${path}.kind`),
        `${path}.kind fulfillmentMethod is the old name of this kind. Write payoutMethod, the word Siren and its documentation use.`,
      );
    } else if (typeof entry.kind !== 'string') {
      this.problem(`${path}.kind`, this.where(`${path}.kind`), `${path}.kind is required, as text, such as postConversionAction.`);
    } else if (!KINDS.includes(entry.kind)) {
      // CLI pass 2, finding 7: the nearest kind, not all of them in one line.
      const [guess] = suggestions(entry.kind, KINDS, /$^/);
      this.problem(
        `${path}.kind`,
        this.where(`${path}.kind`),
        guess === undefined
          ? `${path}.kind ${entry.kind} is not a kind. The schema lists every kind, and an editor completes them.`
          : `${path}.kind ${entry.kind} is not a kind. Did you mean ${guess}, ${/^[aeiou]/i.test(kindName(guess)) ? 'an' : 'a'} ${kindName(guess)}?`,
      );
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      this.problem(`${path}.name`, this.where(`${path}.name`), `${path}.name is required, as text.`);
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      this.problem(`${path}.description`, this.where(`${path}.description`), `${path}.description must be text.`);
    }
    // The old word names the same kind, so its currencies are checked as a payout method's are.
    if (entry.kind === FeatureKind.PayoutMethod || entry.kind === OLD_PAYOUT_KIND) {
      if (!isTextList(entry.currencies) || entry.currencies.length === 0) {
        this.problem(`${path}.currencies`, this.where(`${path}.currencies`), `${path}.currencies is required for a ${kindLabel(FeatureKind.PayoutMethod)}: a list of the currency codes it pays.`);
      }
    } else if (entry.currencies !== undefined) {
      this.problem(`${path}.currencies`, this.where(`${path}.currencies`), `${path}.currencies is only for a ${kindLabel(FeatureKind.PayoutMethod)}.`);
    }
    if (entry.kind === FeatureKind.MetricCalculation) {
      if (entry.scoresMoney !== undefined && typeof entry.scoresMoney !== 'boolean') {
        this.problem(`${path}.scoresMoney`, this.where(`${path}.scoresMoney`), `${path}.scoresMoney must be true or false.`);
      }
    } else if (entry.scoresMoney !== undefined) {
      this.problem(`${path}.scoresMoney`, this.where(`${path}.scoresMoney`), `${path}.scoresMoney is only for a ${kindLabel(FeatureKind.MetricCalculation)}.`);
    }
    if (entry.kind === FeatureKind.IncentiveType) {
      const types = entry.conversionTypes;
      if (
        !isTextList(types) ||
        types.length === 0 ||
        new Set(types).size !== types.length ||
        types.some((type) => !(CONVERSION_TYPES as readonly string[]).includes(type))
      ) {
        this.problem(
          `${path}.conversionTypes`,
          this.where(`${path}.conversionTypes`),
          `${path}.conversionTypes is required for an ${kindLabel(FeatureKind.IncentiveType)}: a list of the conversions it pays, each once, from ${CONVERSION_TYPES.join(', ')}.`,
        );
      }
    } else if (entry.conversionTypes !== undefined) {
      this.problem(`${path}.conversionTypes`, this.where(`${path}.conversionTypes`), `${path}.conversionTypes is only for an ${kindLabel(FeatureKind.IncentiveType)}.`);
    }
    this.checkCustomEventSettings(path, entry);
    const window = entry.answerWindowMinutes;
    if (window !== undefined && (!Number.isInteger(window) || (window as number) < 1 || (window as number) > MAX_ANSWER_WINDOW_MINUTES)) {
      this.problem(
        `${path}.answerWindowMinutes`,
        this.where(`${path}.answerWindowMinutes`),
        `${path}.answerWindowMinutes must be a whole number of minutes from 1 to ${MAX_ANSWER_WINDOW_MINUTES}.`,
      );
    }
  }

  /**
   * A custom event's `fields` and `domains`, which no other kind takes.
   * `fields` is an object of field name to `{type, required}`, and Siren
   * checks the types. Each domain passes {@link domainProblem}.
   */
  private checkCustomEventSettings(path: string, entry: Record<string, unknown>): void {
    const custom = entry.kind === FeatureKind.CustomEvent;
    for (const field of ['fields', 'domains']) {
      if (!custom && entry[field] !== undefined) {
        this.problem(`${path}.${field}`, this.where(`${path}.${field}`), `${path}.${field} is only for a ${kindLabel(FeatureKind.CustomEvent)}.`);
      }
    }
    if (!custom) return;
    const fields = entry.fields;
    if (fields !== undefined) {
      if (!isObject(fields)) {
        this.problem(`${path}.fields`, this.where(`${path}.fields`), `${path}.fields must be an object of each field's name to {"type": ..., "required": ...}.`);
      } else {
        for (const [name, field] of Object.entries(fields)) {
          const at = `${path}.fields.${name}`;
          if (!isObject(field) || typeof field.type !== 'string' || (field.required !== undefined && typeof field.required !== 'boolean')) {
            this.problem(at, this.where(at), `${at} must be {"type": ..., "required": true or false}, with type as text.`);
          }
        }
      }
    }
    const domains = entry.domains;
    if (domains === undefined) return;
    if (!isTextList(domains)) {
      this.problem(`${path}.domains`, this.where(`${path}.domains`), `${path}.domains must be a list of domains, such as ["example.com", "*.example.com"].`);
      return;
    }
    if (domains.length > MAX_DOMAINS) {
      this.problem(`${path}.domains`, this.where(`${path}.domains`), `${path}.domains holds ${domains.length} domains, and an event allows at most ${MAX_DOMAINS}.`);
    }
    domains.forEach((domain, index) => {
      const problem = domainProblem(domain);
      const at = `${path}.domains.${index}`;
      if (problem !== null) this.problem(at, this.where(at), `${at}: ${problem}.`);
    });
  }

  /** `value` with each `${NAME}` filled where the rules allow, and a problem where they do not. */
  private fill(value: unknown, path: string): unknown {
    if (typeof value === 'string') return this.fillText(value, path);
    if (Array.isArray(value)) return value.map((member, index) => this.fill(member, `${path}.${index}`));
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) define(out, key, this.fill(member, path === '' ? key : `${path}.${key}`));
    return out;
  }

  /**
   * Fills each `${NAME}` in the app's url from a set `SIREN_APP_` variable.
   * Anywhere else, or for any other name, or a name not set, it is a problem
   * that names the place and the variable, never a value.
   */
  private fillText(text: string, path: string): string {
    if (!text.includes('${')) return text;
    const where = this.where(path);
    const isUrl = /^apps\.[^.]+\.url$/.test(path);
    if (!isUrl) {
      this.problem(path, where, `${path} holds a \${...} placeholder. An app file fills one only in an app's url.`);
      this.unfilled.add(path);
      return text;
    }
    if (text.replace(PLACEHOLDER, '').includes('${')) {
      this.problem(path, where, `${path} holds a \${ that is not closed with }.`);
      this.unfilled.add(path);
      return text;
    }

    let complete = true;
    const filledText = text.replace(PLACEHOLDER, (_whole, name: string) => {
      if (!/^SIREN_APP_[A-Z0-9_]+$/.test(name)) {
        this.problem(path, where, `${path} names the variable ${name}. An app file fills only variables whose names start with SIREN_APP_.`);
        complete = false;
        return '';
      }
      const set = this.env[name];
      if (set === undefined || set === '') {
        this.problem(path, where, `${path} needs the environment variable ${name}, which is not set. Set it in your shell, or in .env beside the app file.`);
        complete = false;
        return '';
      }
      this.filled.add(name);
      return set;
    });
    if (!complete) this.unfilled.add(path);
    return filledText;
  }

  /** Where `path` sits, or the nearest key above it that the file has. */
  private where(path: string): Place {
    let at = path;
    for (;;) {
      const place = this.places.get(at);
      if (place !== undefined) return place;
      if (at === '') return { line: 1, column: 1 };
      const dot = at.lastIndexOf('.');
      at = dot < 0 ? '' : at.slice(0, dot);
    }
  }

  private problem(path: string, where: Place, message: string): void {
    this.problems.push({ path, line: where.line, column: where.column, message });
  }
}
