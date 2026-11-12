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
 * Reads retry. Every write and delete is sent once. Every id must be a
 * positive whole number, and a bad one throws `SirenError` before sending.
 */
export class ProgramsResource<T = Program> extends RecordsResource<T> {
  /** The filters `GET /programs` reads. {@link list} refuses any other key, `propertyId` included. */
  static readonly LIST_FILTERS = ['status', 'incentiveType', 'incentiveResolverType', 'units', 's', 'programGroupId'] as const;

  constructor(http: HttpTransport) {
    super(http, '/programs');
  }

  /**
   * Lists one page of programs with `GET /programs`. Filters: `status`,
   * `incentiveType`, `incentiveResolverType`, `units` (exact match, a list
   * means "any of"), `s` (search name and description) and
   * `programGroupId`. Sort with `orderBy` and `order`.
   * Sends through `listRecords` with {@link LIST_FILTERS}: any other key
   * throws `SirenError` before sending, and a 2xx that is not a list throws
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

  /** Creates a program with `POST /programs`, sent once, and answers it. */
  create(params: CreateProgramParams): Promise<T> {
    // Stub: slice 3 packet P8
    void params;
    return Promise.resolve({} as T);
  }

  /** Updates a program with `PUT /programs/{id}`, sent once. Send only the fields to change. */
  update(id: number, params: UpdateProgramParams): Promise<T> {
    // Stub: slice 3 packet P8
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Deletes a program with `DELETE /programs/{id}`, sent once. The first
   * call marks it `deleted` and answers it, and a second call removes it and
   * answers `null`.
   */
  delete(id: number): Promise<T | null> {
    // Stub: slice 3 packet P8
    void id;
    return Promise.resolve(null);
  }

  /** Runs a bulk action with `POST /programs/bulk`, sent once. Takes 1 to 500 ids. */
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
