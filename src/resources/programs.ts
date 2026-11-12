import type { HttpTransport } from '../http';
import type {
  BulkResult,
  CreateProgramParams,
  Program,
  ProgramCurrency,
  ProgramListParams,
  RegistryOptions,
  StatusTypes,
  UpdateProgramParams,
} from '../record-types';
import type { SirenList } from '../types';
import { ProgramBulkAction } from '../taxonomy';
import { RecordsResource } from './records';
import type { RetrieveParams } from './records';

/**
 * Programs (`/programs`): the incentive rules that turn engagements into
 * rewards.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * Every write and delete is sent once. Every id must be a positive whole
 * number, and a bad one throws `SirenError` before sending.
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 */
export class ProgramsResource<T = Program> extends RecordsResource<T> {
  /** The filters `GET /programs` reads. {@link list} refuses any other key, `propertyId` included. */
  static readonly LIST_FILTERS = [
    'status',
    'incentiveType',
    'incentiveResolverType',
    'units',
    's',
    'programGroupId',
    'engagementType',
  ] as const;
  /** The id filters its list reads, checked before sending: `programGroupId` takes one id, each a positive whole number. */
  static readonly ID_FILTERS = { one: ['programGroupId'] } as const;

  constructor(http: HttpTransport) {
    super(http, '/programs');
  }

  /**
   * Lists one page of programs with `GET /programs`. Filters: `status`,
   * `incentiveType`, `incentiveResolverType`, `units` (exact match, a list
   * means "any of"), `s` (search name and description) and
   * `programGroupId`. Sort with `orderBy` and `order`.
   * Sends through `listRecords` with {@link LIST_FILTERS} and {@link ID_FILTERS}: any other key
   * and an empty filter list throw `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  override list(params: ProgramListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 3 packet P8
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /**
   * Reads one program with `GET /programs/{id}` through `retrieveRecord`, so it
   * takes `fields`, `include` and `propertyId`. Throws `NotFoundError` for an
   * unknown id.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 3 packet P8
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Creates a program with `POST /programs`, sent once, and answers it.
   * After a lost answer, search
   * with `list({ s })` for the name before sending again, since Siren takes a
   * second create as a new record.
   */
  create(params: CreateProgramParams): Promise<T> {
    // Stub: slice 3 packet P8
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Updates a program with `PUT /programs/{id}`, sent once. Send only the
   * fields to change. Sending it again after a lost answer sets the same
   * values, so it is safe.
   */
  update(id: number, params: UpdateProgramParams): Promise<T> {
    // Stub: slice 3 packet P8
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Deletes a program with `DELETE /programs/{id}`, sent once. The first
   * call marks it `deleted` and answers it, and a second call removes it and
   * answers `null`. After a lost answer, `retrieve` the program before sending
   * again: a second delete of a program the first one marked deleted removes
   * it for good. A program with status `deleted` means the first send
   * worked, and `NotFoundError` means it is gone.
   */
  delete(id: number): Promise<T | null> {
    // Stub: slice 3 packet P8
    void id;
    return Promise.resolve(null);
  }

  /**
   * Runs a bulk action with `POST /programs/bulk`, sent once. Takes 1 to 500
   * ids. A status action sets the same status again, and `permanent_delete`
   * takes only deleted programs and skips ones already gone, so a resend
   * after a lost answer is safe, though `affected` may differ.
   */
  bulk(action: ProgramBulkAction, ids: readonly number[]): Promise<BulkResult> {
    // Stub: slice 3 packet P8
    void action;
    void ids;
    return Promise.resolve({});
  }

  /** The program statuses Siren accepts, `{ options, tones }`, from `GET /programs/status-types`. */
  statusTypes(): Promise<StatusTypes> {
    // Stub: slice 3 packet P8
    return Promise.resolve({ options: {} });
  }

  /**
   * The incentive resolvers a program can use, `{ options: [{ id, name }] }`,
   * from `GET /programs/incentive-types`.
   */
  incentiveTypes(): Promise<RegistryOptions> {
    // Stub: slice 3 packet P8
    return Promise.resolve({ options: [] });
  }

  /**
   * The currencies a program can pay in, from `GET /programs/currency-types`,
   * which answers a bare array. Throws `UnexpectedResponseError` when a 2xx
   * body is not a JSON array.
   */
  currencyTypes(): Promise<ProgramCurrency[]> {
    // Stub: slice 3 packet P8
    return Promise.resolve([]);
  }
}
