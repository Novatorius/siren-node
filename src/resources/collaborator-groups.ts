import type { HttpTransport } from '../http';
import type {
  CollaboratorGroup,
  CollaboratorGroupListParams,
  CreateCollaboratorGroupParams,
  RecordReadParams,
  RegistryOptions,
  UpdateCollaboratorGroupParams,
} from '../record-types';
import type { SirenList } from '../types';
import { CollaboratorGroupMembersResource } from './collaborator-group-members';
import { RecordsResource } from './records';

/**
 * Collaborator groups (`/collaborator-groups`): named sets of collaborators
 * that programs and distributors can target. Members live on
 * {@link members}.
 *
 * Reads retry. Every write and delete is sent once. Every id must be a
 * positive whole number, and a bad one throws `SirenError` before sending.
 */
export class CollaboratorGroupsResource<T = CollaboratorGroup> extends RecordsResource<T> {
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
   */
  override list(params: CollaboratorGroupListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 3 packet P6
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /** Reads one group with `GET /collaborator-groups/{id}`. `fields` chooses the fields. */
  retrieve(id: number, params: RecordReadParams = {}): Promise<T> {
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
