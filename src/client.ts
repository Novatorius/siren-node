import { SirenError } from './errors';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  FetchHttpClient,
  HttpTransport,
} from './http';
import { ApiKeysResource } from './resources/api-keys';
import { EventsResource } from './resources/events';
import { ConversionsResource, RecordsResource, TransactionsResource } from './resources/records';
import { WebhooksResource } from './resources/webhooks';
import type { AccessTokenSource } from './auth/access-token-source';
import { StaticAccessToken } from './auth/static-access-token';
import type { HttpClient } from './http';
import type { SirenOptions } from './types';

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
  /** Conversions: list a page, or read one by id. An API key needs `ledger:conversions:read`. */
  readonly conversions: ConversionsResource;
  /** Transactions: list a page, or read one by id. An API key needs `ledger:transactions:read`. */
  readonly transactions: TransactionsResource;
  /** Reconciliation reader for obligations. An API key needs `ledger:obligations:read`. */
  readonly obligations: RecordsResource;
  /** Reconciliation reader for payouts. An API key needs `ledger:payouts:read`. */
  readonly payouts: RecordsResource;

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
   * with no user name or password in it (a string `new URL` parses), or
   * holds a `?`, a `#`, a space or a control character, so the string the
   * transport joins paths onto is the string that was checked,
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
    const given = (options ?? {}) as unknown as Record<string, unknown>;
    const http = new HttpTransport({
      tokens: resolveTokens(given.apiKey, given.accessToken),
      client: resolveHttpClient(given.httpClient),
      baseUrl: options?.baseUrl ?? DEFAULT_BASE_URL,
      timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
    });

    this.events = new EventsResource(http);
    this.webhooks = new WebhooksResource(http);
    this.apiKeys = new ApiKeysResource(http);
    this.conversions = new ConversionsResource(http);
    this.transactions = new TransactionsResource(http);
    this.obligations = new RecordsResource(http, '/obligations');
    this.payouts = new RecordsResource(http, '/payouts');
  }
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

/** An `AccessTokenSource` is any object with both methods. */
function isAccessTokenSource(value: unknown): value is AccessTokenSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  return typeof source.getAccessToken === 'function' && typeof source.refreshAccessToken === 'function';
}

/**
 * Answers the given `httpClient`, any object with a `send` function, or a
 * `FetchHttpClient` with no fetch of its own when the option is absent, so
 * it reads the global fetch at each send.
 */
function resolveHttpClient(httpClient: unknown): HttpClient {
  if (httpClient === undefined) return new FetchHttpClient();
  if (typeof httpClient === 'object' && httpClient !== null && typeof (httpClient as HttpClient).send === 'function') {
    return httpClient as HttpClient;
  }
  throw new SirenError('Siren: httpClient must be an object with a send function.');
}
