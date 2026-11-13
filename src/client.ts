import { SirenError } from './errors';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  FetchHttpClient,
  HttpTransport,
} from './http';
import { ApiKeysResource } from './resources/api-keys';
import { CollaboratorGroupsResource } from './resources/collaborator-groups';
import { CollaboratorsResource } from './resources/collaborators';
import { CreditsResource } from './resources/credits';
import { CustomCurrenciesResource } from './resources/custom-currencies';
import { DistributorsResource } from './resources/distributors';
import { EngagementsResource } from './resources/engagements';
import { EventsResource } from './resources/events';
import { MappingsResource } from './resources/mappings';
import { OpportunitiesResource } from './resources/opportunities';
import { ProgramGroupsResource } from './resources/program-groups';
import { ProgramsResource } from './resources/programs';
import { ConversionsResource, RecordsResource, TransactionsResource } from './resources/records';
import { SettingsResource } from './resources/settings';
import { WebhooksResource } from './resources/webhooks';
import type { AccessTokenSource } from './auth/access-token-source';
import { StaticAccessToken } from './auth/static-access-token';
import type { HttpClient } from './http';
import type { SirenOptions } from './types';

/** The longest wait a Node timer holds. A longer one fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The Siren API client.
 *
 * ```ts
 * import { Siren } from '@novatorius/siren';
 *
 * const siren = new Siren({ apiKey: process.env.SIREN_API_KEY! });
 *
 * const { opportunityId } = await siren.events.sale({
 *   source: 'stripe',
 *   externalId: 'cs_test_a1b2c3',
 *   total: 49.99,
 *   trackingId: 4021,
 * });
 * ```
 *
 * A connected store passes its OAuth grant as `accessToken` instead, and the
 * client refreshes it once after a 401:
 *
 * ```ts
 * const siren = new Siren({
 *   accessToken: new CallbackAccessTokenSource(
 *     () => store.accessToken(),
 *     (rejected) => store.refresh(rejected),
 *   ),
 * });
 * ```
 */
export class Siren {
  /** Ingest commerce/tracking events — the primary integration point. */
  readonly events: EventsResource;
  /** Verify inbound webhook signatures and manage subscriptions. */
  readonly webhooks: WebhooksResource;
  /** Manage API keys. Takes a signed-in dashboard session's token. */
  readonly apiKeys: ApiKeysResource;
  /** Conversions: list, read, write and recover a lost create. An API key reads with `ledger:conversions:read`. */
  readonly conversions: ConversionsResource;
  /** Transactions: list, read, write and recover a lost credit. An API key reads with `ledger:transactions:read`. */
  readonly transactions: TransactionsResource;
  /** Reconciliation reader for obligations. An API key needs `ledger:obligations:read`. */
  readonly obligations: RecordsResource;
  /** Reconciliation reader for payouts. An API key needs `ledger:payouts:read`. */
  readonly payouts: RecordsResource;
  /** Collaborators, with their codes at `aliases` and program enrollments at `enrollments`. */
  readonly collaborators: CollaboratorsResource;
  /** Collaborator groups, with their members at `members`. */
  readonly collaboratorGroups: CollaboratorGroupsResource;
  /** Programs, and the status, incentive and currency vocabularies they use. */
  readonly programs: ProgramsResource;
  /** Program groups, the sets of programs that compete for one engagement. */
  readonly programGroups: ProgramGroupsResource;
  /** Opportunities, a tracked visitor's chance to convert: list, read and update. */
  readonly opportunities: OpportunitiesResource;
  /** Engagements, a collaborator's claim on an opportunity in one program. Read only. */
  readonly engagements: EngagementsResource;
  /** Distributors, the revenue pools shared among collaborators on a schedule. */
  readonly distributors: DistributorsResource;
  /** Custom currencies, such as points and store credit, keyed by code. */
  readonly customCurrencies: CustomCurrenciesResource;
  /** Store credit: balances, the ledger behind them and checkout holds. */
  readonly credits: CreditsResource;
  /** Links between collaborators and records outside Siren, such as WordPress users. */
  readonly mappings: MappingsResource;
  /** The organization settings Siren shares with a connected site. */
  readonly settings: SettingsResource;

  /**
   * Reads only the options object's own properties: `apiKey`,
   * `accessToken`, `httpClient`, `baseUrl`, `timeout` and `maxRetries`. A
   * value the object inherits, from `Object.prototype` or any other
   * prototype, counts as absent, so prototype pollution cannot choose the
   * host, the HTTP client, the credential or the retry policy through these
   * reads. Fetch reads options of its own, so a host that cannot rule out
   * pollution passes its own `httpClient`, one that does not send through
   * the global `fetch` or that sets its own dispatcher. An object with no
   * prototype works as well. Each option is read once, so a getter cannot
   * pass a check with one value and be used with another.
   *
   * The values themselves are read as they are, so a token source or client
   * class keeps its methods on its prototype. A method counts only when the
   * value or a prototype other than `Object.prototype` holds it, so a
   * `send`, `getAccessToken` or `refreshAccessToken` that only
   * `Object.prototype` supplies is missing, and the option is refused.
   *
   * Throws `SirenError` when the options pass both `apiKey` and
   * `accessToken`, neither, an empty one, an `accessToken` that is neither a
   * string nor an `AccessTokenSource`, or an `httpClient` without a `send`
   * function, `null` included. An option given as `undefined` counts as
   * absent, and an empty string counts as given, so an empty `apiKey` beside
   * an `accessToken` is refused as both. The message for a missing
   * credential says an apiKey is required and names `accessToken` as the
   * other choice. No message carries a credential.
   *
   * Also throws `SirenError` when `baseUrl` is not an http or https URL
   * with no user name or password in it (a string `new URL` parses), does
   * not start with `http://` or `https://` and a host with no `%`, or holds
   * a `?`, a `#`, a backslash, an `@` or any character outside visible
   * ASCII, U+0021 to U+007E. The check reads the raw string, so the string
   * the transport joins paths onto is the string that was checked, and an
   * international host must come in punycode. It also throws when
   * `timeout` is not a number from 1 to 2147483647 (the longest wait a
   * timer holds), or `maxRetries` is not a whole number of 0 or more, with
   * no ceiling. NaN, Infinity, `null` and any value of the wrong type are
   * refused, and a fraction of a millisecond is allowed. Each message names
   * the option, what it takes ("an http or https URL", "from 1 to
   * 2147483647", "a whole number of 0 or more") and what it got: the number
   * itself, or the type of any other value, never a string's text. Absent,
   * they default to `DEFAULT_BASE_URL`, 30000 and 2. Unknown option names
   * are ignored.
   *
   * `apiKey` and a string `accessToken` become a `StaticAccessToken`. An
   * `AccessTokenSource` is used as given. Requests go through `httpClient`,
   * or a `FetchHttpClient` when there is none.
   */
  constructor(options: SirenOptions) {
    const http = createHttpTransport(options);

    this.events = new EventsResource(http);
    this.webhooks = new WebhooksResource(http);
    this.apiKeys = new ApiKeysResource(http);
    this.conversions = new ConversionsResource(http);
    this.transactions = new TransactionsResource(http);
    this.obligations = new RecordsResource(http, '/obligations');
    this.payouts = new RecordsResource(http, '/payouts');
    this.collaborators = new CollaboratorsResource(http);
    this.collaboratorGroups = new CollaboratorGroupsResource(http);
    this.programs = new ProgramsResource(http);
    this.programGroups = new ProgramGroupsResource(http);
    this.opportunities = new OpportunitiesResource(http);
    this.engagements = new EngagementsResource(http);
    this.distributors = new DistributorsResource(http);
    this.customCurrencies = new CustomCurrenciesResource(http);
    this.credits = new CreditsResource(http);
    this.mappings = new MappingsResource(http);
    this.settings = new SettingsResource(http);
  }
}

/**
 * Builds the transport a client sends through, from the options `new Siren()`
 * takes, by the rules its constructor documents. `Siren` and `SirenConnect`
 * both call it, so the two clients never disagree about an option.
 *
 * @internal
 */
export function createHttpTransport(options: SirenOptions): HttpTransport {
  const given: unknown = options ?? {};
  const apiKey = ownOption(given, 'apiKey');
  const accessToken = ownOption(given, 'accessToken');
  const httpClient = ownOption(given, 'httpClient');
  const baseUrl = ownOption(given, 'baseUrl');
  const timeout = ownOption(given, 'timeout');
  const maxRetries = ownOption(given, 'maxRetries');

  return new HttpTransport({
    tokens: resolveTokens(apiKey, accessToken),
    client: resolveHttpClient(httpClient),
    baseUrl: resolveBaseUrl(baseUrl),
    timeout: resolveTimeout(timeout),
    maxRetries: resolveMaxRetries(maxRetries),
  });
}

/**
 * Turns the `apiKey` and `accessToken` options into the transport's token
 * source. An option given as `undefined` is absent. Exactly one must be
 * given, and no message quotes either value.
 */
function resolveTokens(apiKey: unknown, accessToken: unknown): AccessTokenSource {
  const hasKey = apiKey !== undefined;
  const hasToken = accessToken !== undefined;
  if (hasKey && hasToken) {
    throw new SirenError('Siren: pass either apiKey or accessToken, not both.');
  }
  if (hasToken) {
    if (typeof accessToken === 'string' && accessToken.length > 0) return new StaticAccessToken(accessToken);
    if (isAccessTokenSource(accessToken)) return accessToken;
    throw new SirenError(
      'Siren: accessToken must be a non-empty string or an AccessTokenSource with getAccessToken and refreshAccessToken.',
    );
  }
  if (typeof apiKey === 'string' && apiKey.length > 0) return new StaticAccessToken(apiKey);
  throw new SirenError(
    'Siren: an apiKey is required. Mint one in the Siren dashboard (Settings > API Keys), or pass an accessToken.',
  );
}

/**
 * Answers the option `name` when the options object holds it itself, else
 * `undefined`. It never reads an inherited value, and it reads an own value
 * once, so a getter runs a single time. It works on an object with no
 * prototype, since it calls `hasOwnProperty` from `Object.prototype`.
 *
 * @internal
 */
export function ownOption(options: unknown, name: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(options, name)) return undefined;
  return (options as Record<string, unknown>)[name];
}

/**
 * True when `value` is an object whose `name` is a function held by the
 * object itself or by a prototype other than `Object.prototype`. The walk
 * stops at the first object that holds `name`, which is the one a call would
 * use, so a non-function there hides a function further up.
 */
function holdsMethod(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  for (let holder: object | null = value; holder !== null && holder !== Object.prototype; holder = Object.getPrototypeOf(holder)) {
    if (Object.prototype.hasOwnProperty.call(holder, name)) {
      return typeof (value as Record<string, unknown>)[name] === 'function';
    }
  }
  return false;
}

/** An `AccessTokenSource` is any object that holds both methods. */
function isAccessTokenSource(value: unknown): value is AccessTokenSource {
  return holdsMethod(value, 'getAccessToken') && holdsMethod(value, 'refreshAccessToken');
}

/**
 * Answers the given `httpClient`, any object that holds a `send` function,
 * or a `FetchHttpClient` with no fetch of its own when the option is absent,
 * so it reads the global fetch at each send.
 *
 * @internal
 */
export function resolveHttpClient(httpClient: unknown): HttpClient {
  if (httpClient === undefined) return new FetchHttpClient();
  if (holdsMethod(httpClient, 'send')) return httpClient as HttpClient;
  throw new SirenError('Siren: httpClient must be an object with a send function.');
}

/**
 * Answers `baseUrl`, or `DEFAULT_BASE_URL` when it is absent. Refuses any
 * value that is not a string, that holds a character outside visible ASCII
 * (U+0021 to U+007E) or a `?`, `#`, backslash or `@`, that does not start
 * with `http://` or `https://` and a host with no `%`, or that `new URL`
 * does not parse with the http or https scheme and an empty user name and
 * password. The message names that range, the backslash and the `@`, and
 * never quotes the value, and the error carries no `cause`. `name` is the
 * option the message names, `baseUrl` unless another option takes the same
 * rule.
 *
 * @internal
 */
export function resolveBaseUrl(baseUrl: unknown, name = 'baseUrl'): string {
  if (baseUrl === undefined) return DEFAULT_BASE_URL;
  if (typeof baseUrl === 'string' && isHttpUrl(baseUrl)) return baseUrl;
  throw new SirenError(
    `Siren: ${name} must be an http or https URL of visible ASCII, U+0021 to U+007E, that starts with http:// or https:// and a host with no %, and holds no user name, password, query, fragment, backslash or @. It got ${described(baseUrl)}.`,
  );
}

/** True for a string the transport can join paths onto and send a token to. */
function isHttpUrl(text: string): boolean {
  if (/[^\u0021-\u007e]|[?#\\@]/.test(text)) return false;
  if (!/^https?:\/\/[^/%]+(?:\/|$)/i.test(text)) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
}

/**
 * Answers `timeout`, or `fallback` when it is absent, `DEFAULT_TIMEOUT_MS`
 * unless the caller has another default.
 *
 * @internal
 */
export function resolveTimeout(timeout: unknown, fallback: number = DEFAULT_TIMEOUT_MS): number {
  if (timeout === undefined) return fallback;
  if (typeof timeout === 'number' && timeout >= 1 && timeout <= MAX_TIMEOUT_MS) return timeout;
  throw new SirenError(
    `Siren: timeout must be a number of milliseconds from 1 to ${MAX_TIMEOUT_MS}. It got ${described(timeout)}.`,
  );
}

/** Answers `maxRetries`, or `DEFAULT_MAX_RETRIES` when it is absent. It has no ceiling. */
function resolveMaxRetries(maxRetries: unknown): number {
  if (maxRetries === undefined) return DEFAULT_MAX_RETRIES;
  if (typeof maxRetries === 'number' && Number.isInteger(maxRetries) && maxRetries >= 0) return maxRetries;
  throw new SirenError(`Siren: maxRetries must be a whole number of 0 or more. It got ${described(maxRetries)}.`);
}

/**
 * What a refused option got, for its message: a number as `String(value)`,
 * `null` as "null", and the type of anything else, so a string's text, which
 * might be a credential, never reaches the message.
 */
function described(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return value === null ? 'null' : typeof value;
}
