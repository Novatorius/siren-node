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
import { RecordsResource } from './records';
import type { RetrieveParams } from './records';

/**
 * Distributors (`/distributors`): pools that share revenue among the
 * collaborators they cover, on a schedule.
 *
 * Reads retry. Every write is sent once. Every id must be a positive whole
 * number, or `SirenError` is thrown before sending. Writes need the
 * Essentials plan: without it Siren answers 403 `plan_required`, raised as
 * `PermissionError`. A connected site's token may read with
 * `connect:records:read` and cannot write.
 */
export class DistributorsResource<T = Distributor> extends RecordsResource<T> {
  /** The filters `GET /distributors` reads. {@link list} refuses any other key, `propertyId` included. */
  static readonly LIST_FILTERS = ['status', 's', 'metricType'] as const;

  constructor(http: HttpTransport) {
    super(http, '/distributors');
  }

  /**
   * Lists one page of distributors with `GET /distributors`. Filters:
   * `status` (exact match, a list means "any of"), `s` (search name and
   * description) and `metricType`. Deleted distributors are listed too, so
   * filter by `status` to leave them out. Sort with `orderBy` (`id`, `name`,
   * `status`, `dateCreated`) and `order`. Sends through `listRecords` with
   * {@link LIST_FILTERS}.
   */
  override list(params: DistributorListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 4 packet P3
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /**
   * Reads one distributor with `GET /distributors/{id}` through
   * `retrieveRecord`. The answer adds `schedule`, `engagementTypes`,
   * `transactionCompilers`, `revenuePercentage` and `lineItemFilters` to the
   * default fields. Throws `NotFoundError` for an unknown id.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 4 packet P3
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /** Creates a distributor with `POST /distributors`, sent once, and answers it, status 201. */
  create(params: CreateDistributorParams): Promise<T> {
    // Stub: slice 4 packet P3
    void params;
    return Promise.resolve({} as T);
  }

  /** Updates a distributor with `PUT /distributors/{id}`, sent once. Send only the fields to change. */
  update(id: number, params: UpdateDistributorParams): Promise<T> {
    // Stub: slice 4 packet P3
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Deletes a distributor with `DELETE /distributors/{id}`, sent once. The
   * first call marks it `deleted` and answers it, and a second call removes
   * it and answers `null`.
   */
  delete(id: number): Promise<T | null> {
    // Stub: slice 4 packet P3
    void id;
    return Promise.resolve(null);
  }

  /**
   * Runs a bulk action with `POST /distributors/bulk`, sent once. Takes 1 to
   * 500 ids. `permanent_delete` deletes nothing unless every distributor is
   * already `deleted`, and answers 409, raised as `ConflictError`, when one
   * is not.
   */
  bulk(action: DistributorBulkAction, ids: readonly number[]): Promise<BulkResult> {
    // Stub: slice 4 packet P3
    void action;
    void ids;
    return Promise.resolve({});
  }

  /**
   * Credits a manual metric to a collaborator on every active distributor
   * that counts manual metrics, with `POST /distributors/credit-metric`,
   * body `{ collaboratorId }` plus `points` when given, sent once: a second
   * send would credit twice. `points` (a whole number from 1 to
   * 1,000,000,000,000) is needed for a distributor with no point value of
   * its own. Answers `{ success, credited, notCredited }`.
   *
   * Throws `SirenError` before sending when `collaboratorId` is not a
   * positive whole number or `points` is given and is not a whole number in
   * that range. Siren answers 422, raised as `ValidationError`, when nothing
   * was credited, and 404 when it has no such collaborator.
   */
  creditMetric(collaboratorId: number, points?: number): Promise<CreditedMetric> {
    // Stub: slice 4 packet P3
    void collaboratorId;
    void points;
    return Promise.resolve({});
  }
}
