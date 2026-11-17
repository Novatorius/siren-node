import type { HttpTransport } from '../http';
import type { Payout } from '../record-types';
import { RecordsResource, retrieveRecord } from './records';
import type { RetrieveParams } from './records';

/**
 * Payouts (`/payouts`): what Siren owes one collaborator in one currency,
 * inside a fulfillment. This resource only reads. Every payout write moves
 * money, so Siren keeps it for a signed-in admin.
 *
 * Takes an API key that holds `ledger:payouts:read`, or a dashboard
 * session's token. Payouts are not kept by store, so a key bound to one
 * store gets a `StoreKeyNotAllowedError`.
 *
 * `list()` is the reconciliation reader every ledger collection shares, and
 * passes its params through as filters: `id`, `fulfillmentId`,
 * `collaboratorId`, `status` and `currency`. Reads retry on a network error,
 * 429 or 5xx inside the client's `maxRetries`.
 */
export class PayoutsResource<T = Payout> extends RecordsResource<T> {
  constructor(http: HttpTransport) {
    super(http, '/payouts');
  }

  /**
   * Reads one payout with `GET /payouts/{id}` through `retrieveRecord`.
   * Siren answers its thirteen default fields unless `fields` names others,
   * and `include: 'extended'` adds the collaborator's name and email.
   * Throws `NotFoundError` for an unknown id, `SirenError` before sending
   * for an id that is not a positive whole number, and
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }
}
