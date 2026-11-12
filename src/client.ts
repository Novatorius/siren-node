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
   * Throws `SirenError` when the options pass both `apiKey` and
   * `accessToken`, neither, an empty one, an `accessToken` that is neither a
   * string nor an `AccessTokenSource`, or an `httpClient` without a `send`
   * function. The message for a missing credential says an apiKey is
   * required and names `accessToken` as the other choice.
   *
   * `apiKey` and a string `accessToken` become a `StaticAccessToken`. An
   * `AccessTokenSource` is used as given. Requests go through `httpClient`,
   * or a `FetchHttpClient` when there is none.
   */
  constructor(options: SirenOptions) {
    // Stub: slice 2 packet P4. Until P4 lands, the client takes an apiKey
    // only and sends it as 0.3.0 did.
    if (!options || typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new SirenError(
        'Siren: an apiKey is required. Mint one in the Siren dashboard (Settings > API Keys).',
      );
    }
    const apiKey = options.apiKey;

    const http = new HttpTransport({
      tokens: { getAccessToken: () => apiKey, refreshAccessToken: () => null },
      client: new FetchHttpClient(),
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
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
