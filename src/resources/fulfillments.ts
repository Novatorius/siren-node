import { SirenError } from '../errors';
import type { HttpTransport } from '../http';
import type { Fulfillment, FulfillmentListParams } from '../record-types';
import type { SirenList } from '../types';
import { isDay } from './engagements';
import { listRecords } from './record-requests';
import { RecordsResource, retrieveRecord } from './records';
import type { RetrieveParams } from './records';

/**
 * Fulfillments (`/fulfillments`): the batches Siren groups payouts into.
 * This resource only reads. Making, changing and deleting a fulfillment
 * moves money, so Siren keeps those for a signed-in admin.
 *
 * Takes an API key that holds `ledger:fulfillments:read`, or a dashboard
 * session's token. Fulfillments are not kept by store, so a key bound to one
 * store gets a `StoreKeyNotAllowedError`. Reads retry on a network error,
 * 429 or 5xx inside the client's `maxRetries`. Every id must be a positive
 * whole number, or the method throws `SirenError` before sending.
 */
export class FulfillmentsResource<T = Fulfillment> extends RecordsResource<T> {
  /**
   * The filters `GET /fulfillments` reads (GetFulfillments.php and
   * PayoutStatusFilterMiddleware.php). {@link list} refuses any other key,
   * `propertyId` included.
   */
  static readonly LIST_FILTERS = ['status', 'payoutStatus', 'currency', 'from', 'to'] as const;

  constructor(http: HttpTransport) {
    super(http, '/fulfillments');
  }

  /**
   * Lists one page of fulfillments with `GET /fulfillments`, newest first by
   * default. Siren answers `id`, `status`, `dateCreated` and `dateModified`
   * unless `fields` names others. Filters: `status` (a list means "any of"),
   * `payoutStatus` (only fulfillments holding a payout in that status, and
   * `failed` finds the ones that need attention), `currency`, and `from` and
   * `to` (days, `YYYY-MM-DD`). Sort with `orderBy` (`id`, `status`,
   * `dateCreated`) and `order`.
   *
   * Siren reads a `from` or `to` that is not a day as no bound at all, so a
   * `from` or `to` that is not exactly `YYYY-MM-DD` naming a real calendar
   * day throws `SirenError` before sending, with exactly
   * `fulfillments.list() needs {key} as a day, YYYY-MM-DD, and got {value}.`
   * `{value}` is a string in JSON quotes and anything else through
   * `String()`.
   */
  override async list(params: FulfillmentListParams = {}): Promise<SirenList<T>> {
    // Each own key read once, so the day check and the query see the same values.
    params = { ...params };
    for (const key of ['from', 'to'] as const) {
      const value: unknown = (params as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (!isDay(value)) {
        const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
        throw new SirenError(`fulfillments.list() needs ${key} as a day, YYYY-MM-DD, and got ${shown}.`);
      }
    }
    return listRecords<T>(this.http, this.path, params, FulfillmentsResource.LIST_FILTERS);
  }

  /**
   * Reads one fulfillment with `GET /fulfillments/{id}` through
   * `retrieveRecord`. `include: 'extended'` adds the payout counts, the
   * total, the currency and each payout. Throws `NotFoundError` for an
   * unknown id, and `UnexpectedResponseError` when a 2xx body is not a JSON
   * object.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }
}
