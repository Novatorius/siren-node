import type { HttpTransport } from '../http';
import type {
  BulkResult,
  CreateProgramGroupParams,
  ProgramGroup,
  ProgramGroupListParams,
  UpdateProgramGroupParams,
} from '../record-types';
import type { SirenList } from '../types';
import { ProgramGroupBulkAction } from '../taxonomy';
import { RecordsResource } from './records';
import type { RetrieveParams } from './records';

/**
 * Program groups (`/program-groups`): sets of programs that compete for the
 * same engagement, with a sorter that picks the winner.
 *
 * Reads retry. Every write and delete is sent once. Every id must be a
 * positive whole number, and a bad one throws `SirenError` before sending.
 */
export class ProgramGroupsResource<T = ProgramGroup> extends RecordsResource<T> {
  /** The filters `GET /program-groups` reads. {@link list} refuses any other key, `propertyId` included. */
  static readonly LIST_FILTERS = ['sorter', 's'] as const;

  constructor(http: HttpTransport) {
    super(http, '/program-groups');
  }

  /**
   * Lists one page of program groups with `GET /program-groups`. Filters:
   * `sorter` and `s` (search name and description). Sort with `orderBy` and
   * `order`.
   * Sends through `listRecords` with {@link LIST_FILTERS}: any other key
   * throws `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  override list(params: ProgramGroupListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 3 packet P9
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /**
   * Reads one program group with `GET /program-groups/{id}` through `retrieveRecord`, so it
   * takes `fields`, `include` and `propertyId`. Throws `NotFoundError` for an
   * unknown id.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 3 packet P9
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /** Creates a program group with `POST /program-groups`, sent once, and answers it. */
  create(params: CreateProgramGroupParams): Promise<T> {
    // Stub: slice 3 packet P9
    void params;
    return Promise.resolve({} as T);
  }

  /** Updates a program group with `PUT /program-groups/{id}`, sent once. `programs`, when sent, replaces the group's programs. */
  update(id: number, params: UpdateProgramGroupParams): Promise<T> {
    // Stub: slice 3 packet P9
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Deletes the program group for good with `DELETE /program-groups/{id}`,
   * sent once. Siren answers with no body, so this answers `null`.
   */
  delete(id: number): Promise<T | null> {
    // Stub: slice 3 packet P9
    void id;
    return Promise.resolve(null);
  }

  /** Runs a bulk action with `POST /program-groups/bulk`, sent once. Takes 1 to 500 ids. */
  bulk(action: ProgramGroupBulkAction, ids: readonly number[]): Promise<BulkResult> {
    // Stub: slice 3 packet P9
    void action;
    void ids;
    return Promise.resolve({});
  }
}
