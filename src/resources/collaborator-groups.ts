import type { HttpTransport } from '../http';
import type {
  CollaboratorGroup,
  CollaboratorGroupListParams,
  CreateCollaboratorGroupParams,
  RegistryOptions,
  UpdateCollaboratorGroupParams,
} from '../record-types';
import type { SirenList } from '../types';
import { CollaboratorGroupMembersResource } from './collaborator-group-members';
import { RecordsResource } from './records';
import type { RetrieveParams } from './records';

/**
 * Collaborator groups (`/collaborator-groups`): named sets of collaborators
 * that programs and distributors can target. Members live on
 * {@link members}.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * Every write and delete is sent once. Every id must be a positive whole
 * number, and a bad one throws `SirenError` before sending.
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 */
export class CollaboratorGroupsResource<T = CollaboratorGroup> extends RecordsResource<T> {
  /** The filters `GET /collaborator-groups` reads. {@link list} refuses any other key, `propertyId` included. */
  static readonly LIST_FILTERS = ['structure', 's'] as const;

  /** The members of a group. */
  readonly members: CollaboratorGroupMembersResource;

  constructor(http: HttpTransport) {
    super(http, '/collaborator-groups');
    this.members = new CollaboratorGroupMembersResource(http);
  }

  /**
   * Lists one page of groups with `GET /collaborator-groups`. Filters:
   * `structure` and `s` (search name and description). Sort with `orderBy`
   * and `order`.
   * Sends through `listRecords` with {@link LIST_FILTERS}: any other key
   * and an empty filter list throw `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  override list(params: CollaboratorGroupListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 3 packet P6
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /**
   * Reads one group with `GET /collaborator-groups/{id}` through `retrieveRecord`, so it
   * takes `fields`, `include` and `propertyId`. Throws `NotFoundError` for an
   * unknown id.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 3 packet P6
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Creates a group with `POST /collaborator-groups`, sent once, and answers
   * it. After a lost answer, search
   * with `list({ s })` for the name before sending again, since Siren takes a
   * second create as a new record.
   */
  create(params: CreateCollaboratorGroupParams): Promise<T> {
    // Stub: slice 3 packet P6
    void params;
    return Promise.resolve({} as T);
  }

  /** Updates a group's `name`, `description` or `structure` with `PUT /collaborator-groups/{id}`, sent once. */
  update(id: number, params: UpdateCollaboratorGroupParams): Promise<T> {
    // Stub: slice 3 packet P6
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Deletes the group for good with `DELETE /collaborator-groups/{id}`, sent
   * once. Siren answers 204, so this answers `null`. A resend after a lost
   * answer raises `NotFoundError` when the first one worked.
   */
  delete(id: number): Promise<T | null> {
    // Stub: slice 3 packet P6
    void id;
    return Promise.resolve(null);
  }

  /**
   * The group structures Siren supports, `{ options: [{ id, name,
   * description, providedWalkerCapabilities }] }`, from `GET
   * /collaborator-groups/structures`.
   */
  structures(): Promise<RegistryOptions> {
    // Stub: slice 3 packet P6
    return Promise.resolve({ options: [] });
  }
}
