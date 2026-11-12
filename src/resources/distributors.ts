import { SirenError } from '../errors';
import type { HttpTransport } from '../http';
import type {
  BulkResult,
  CreateDistributorParams,
  CreditedMetric,
  Distributor,
  DistributorListParams,
  UpdateDistributorParams,
} from '../record-types';
import type { SirenList } from '../types';
import { DistributorBulkAction } from '../taxonomy';
import { bulkRecords, deleteRecord, listRecords, recordId, writeRecord } from './record-requests';
import { RecordsResource, retrieveRecord } from './records';
import type { RetrieveParams } from './records';

/** The most points one `creditMetric` call may credit. Siren refuses more. */
const MAX_METRIC_POINTS = 1_000_000_000_000;

/**
 * Distributors (`/distributors`): pools that share revenue among the
 * collaborators they cover, on a schedule.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * Every write is sent once, apart from the one resend after a 401 that
 * every request gets. Every id must be a positive whole number, or
 * `SirenError` is thrown before sending.
 *
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 *
 * Writes need the Essentials plan: without it Siren answers 403
 * `plan_required`, raised as `PermissionError`. A connected site's token
 * may read with `connect:records:read` and cannot write.
 */
export class DistributorsResource<T = Distributor> extends RecordsResource<T> {
  /** The filters `GET /distributors` reads. {@link list} refuses any other key, `propertyId` included. No filter takes an id, so there is no `ID_FILTERS`. */
  static readonly LIST_FILTERS = ['status', 's', 'metricType'] as const;

  /**
   * The fields {@link create} sends: the fifteen Siren's create route and the
   * listeners of its action event read (`CreateNewDistributor.php`,
   * `ValidatesDistributorFields.php`), which are the fifteen the PHP SDK
   * documents. `create` refuses any other key before sending.
   */
  static readonly CREATE_FIELDS = [
    'name',
    'description',
    'distributionResolver',
    'distributionPoolResolver',
    'status',
    'units',
    'revenuePercentage',
    'schedule',
    'engagementTypes',
    'collaboratorIds',
    'collaboratorGroupId',
    'transactionCompilers',
    'lineItemFilters',
    'postAllocationActions',
    'metricFilters',
  ] as const;

  constructor(http: HttpTransport) {
    super(http, '/distributors');
  }

  /**
   * Lists one page of distributors with `GET /distributors`. Filters:
   * `status` (exact match, a list means "any of"), `s` (search name and
   * description) and `metricType`. Deleted distributors are listed too, so
   * filter by `status` to leave them out. Sort with `orderBy` (`id`, `name`,
   * `status`, `dateCreated`) and `order`. Sends through `listRecords` with
   * {@link LIST_FILTERS}: any other key and an empty filter list throw
   * `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  override list(params: DistributorListParams = {}): Promise<SirenList<T>> {
    return listRecords<T>(this.http, this.path, params, DistributorsResource.LIST_FILTERS);
  }

  /**
   * Reads one distributor with `GET /distributors/{id}` through
   * `retrieveRecord`. The answer adds `schedule`, `engagementTypes`,
   * `transactionCompilers`, `revenuePercentage` and `lineItemFilters` to the
   * default fields. Throws `NotFoundError` for an unknown id, and
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }

  /**
   * Creates a distributor with `POST /distributors`, sent once, and answers
   * it, status 201. Siren answers 400, raised as `BadRequestError`, for a
   * field it refuses. Siren takes a second create as a new distributor, so
   * after a lost answer, search with `list({ s })` for the name before
   * sending again.
   *
   * Sends a new object holding only the {@link CREATE_FIELDS} that `params`
   * gives. Throws `SirenError` before sending when `params` holds any other
   * key, whatever its value, `undefined` included, with exactly
   * `distributors.create() cannot send "{key}". Siren's create route reads
   * only the fifteen fields in DistributorsResource.CREATE_FIELDS.`
   */
  async create(params: CreateDistributorParams): Promise<T> {
    // Stub: slice 4 fix packet F3 (the create allow lists).
    return writeRecord<T>(this.http, 'POST', this.path, params);
  }

  /**
   * Updates a distributor with `PUT /distributors/{id}`, sent once. Send
   * only the fields to change. Throws `NotFoundError` for an unknown id.
   * Sending it again after a lost answer sets the same values, so it is
   * safe.
   */
  async update(id: number, params: UpdateDistributorParams): Promise<T> {
    const path = `${this.path}/${recordId(id, 'distributors.update')}`;
    return writeRecord<T>(this.http, 'PUT', path, params);
  }

  /**
   * Deletes a distributor with `DELETE /distributors/{id}`, sent once. The
   * first call marks it `deleted` and answers it, and a second call removes
   * it and answers `null`. Throws `NotFoundError` for an unknown id. Do not
   * resend a lost first delete blindly, since a second call removes the
   * distributor for good. Read it with {@link retrieve} first: status
   * `deleted` means the first call worked, and `NotFoundError` means it is
   * gone.
   */
  async delete(id: number): Promise<T | null> {
    return deleteRecord<T>(this.http, `${this.path}/${recordId(id, 'distributors.delete')}`);
  }

  /**
   * Runs a bulk action with `POST /distributors/bulk`, sent once. Takes 1 to
   * 500 ids and no extra, since Siren reads only the action and ids.
   * `permanent_delete` deletes nothing unless every distributor is already
   * `deleted`, and answers 409, raised as `ConflictError`, when one is not.
   * Siren answers `{ success, affected }` and skips ids it cannot find, so
   * an `affected` lower than the number of ids sent means some were
   * skipped. A status action sets the same status again, so a resend after
   * a lost answer is safe, though `affected` may differ.
   */
  bulk(action: DistributorBulkAction, ids: readonly number[]): Promise<BulkResult> {
    return bulkRecords<BulkResult>(this.http, this.path, action, ids);
  }

  /**
   * Credits a manual metric to a collaborator on every active distributor
   * that counts manual metrics, with `POST /distributors/credit-metric`,
   * body `{ collaboratorId }` plus `points` when given, sent once: a second
   * send would credit twice, since Siren adds each credit to the
   * collaborator's metric, and Siren takes no idempotency key for it. No
   * SDK read shows the metric, so do not resend after a lost answer. Set it
   * aside for a person to check the distributor's metrics in Siren's
   * dashboard. `points` (a whole number from 1 to
   * 1,000,000,000,000) is needed for a distributor with no point value of
   * its own. Answers `{ success, credited, notCredited }`.
   *
   * Throws `SirenError` before sending when `collaboratorId` is not a
   * positive whole number or `points` is given and is not a whole number in
   * that range. Siren answers 422, raised as `ValidationError`, when nothing
   * was credited, and 404 when it has no such collaborator.
   */
  async creditMetric(collaboratorId: number, points?: number): Promise<CreditedMetric> {
    const body: { collaboratorId: number; points?: number } = {
      collaboratorId: recordId(collaboratorId, 'distributors.creditMetric', 'collaboratorId'),
    };
    if (points !== undefined) {
      if (!Number.isSafeInteger(points) || points < 1 || points > MAX_METRIC_POINTS) {
        const shown = typeof points === 'string' ? JSON.stringify(points) : String(points);
        throw new SirenError(
          `distributors.creditMetric needs points as a whole number from 1 to 1,000,000,000,000, and got ${shown}.`,
        );
      }
      body.points = points;
    }
    return writeRecord<CreditedMetric>(this.http, 'POST', `${this.path}/credit-metric`, body);
  }
}
