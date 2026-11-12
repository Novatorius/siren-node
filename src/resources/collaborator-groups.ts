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
 * Reads retry. Every write and delete is sent once. Every id must be a
 * positive whole number, and a bad one throws `SirenError` before sending.
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
   * throws `SirenError` before sending, and a 2xx that is not a list throws
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

  /** Creates a group with `POST /collaborator-groups`, sent once, and answers it. */
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
   * once. Siren answers with no body, so this answers `null`.
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
