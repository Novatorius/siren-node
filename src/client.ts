import { SirenError } from './errors';
import { DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, HttpClient } from './http';
import { ApiKeysResource } from './resources/api-keys';
import { EventsResource } from './resources/events';
import { RecordsResource } from './resources/records';
import { WebhooksResource } from './resources/webhooks';
import type { SirenOptions } from './types';

/**
 * The Siren API client.
 *
 * ```ts
 * import { Siren } from '@siren/sdk';
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
 */
export class Siren {
  /** Ingest commerce/tracking events — the primary integration point. */
  readonly events: EventsResource;
  /** Verify inbound webhook signatures and manage subscriptions. */
  readonly webhooks: WebhooksResource;
  /** Manage API keys. */
  readonly apiKeys: ApiKeysResource;
  /** Reconciliation reader for conversions. */
  readonly conversions: RecordsResource;
  /** Reconciliation reader for transactions. */
  readonly transactions: RecordsResource;
  /** Reconciliation reader for obligations. */
  readonly obligations: RecordsResource;
  /** Reconciliation reader for payouts. */
  readonly payouts: RecordsResource;

  constructor(options: SirenOptions) {
    if (!options || typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new SirenError(
        'Siren: an apiKey is required. Mint one in the Siren dashboard (Settings > API Keys).',
      );
    }

    const http = new HttpClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });

    this.events = new EventsResource(http);
    this.webhooks = new WebhooksResource(http);
    this.apiKeys = new ApiKeysResource(http);
    this.conversions = new RecordsResource(http, '/conversions');
    this.transactions = new RecordsResource(http, '/transactions');
    this.obligations = new RecordsResource(http, '/obligations');
    this.payouts = new RecordsResource(http, '/payouts');
  }
}
