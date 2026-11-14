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
import { deleteRecord, listRecords, readObject, recordId, writeRecord } from './record-requests';
import { RecordsResource, retrieveRecord } from './records';
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
    return listRecords<T>(this.http, this.path, params, CollaboratorGroupsResource.LIST_FILTERS);
  }

  /**
   * Reads one group with `GET /collaborator-groups/{id}` through `retrieveRecord`, so it
   * takes `fields`, `include` and `propertyId`. Throws `NotFoundError` for an
   * unknown id.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }

  /**
   * Creates a group with `POST /collaborator-groups`, sent once, and answers
   * it. After a lost answer, search
   * with `list({ s })` for the name before sending again, since Siren takes a
   * second create as a new record.
   */
  create(params: CreateCollaboratorGroupParams): Promise<T> {
    return writeRecord<T>(this.http, 'POST', this.path, params);
  }

  /**
   * Updates a group's `name`, `description` or `structure` with `PUT
   * /collaborator-groups/{id}`, sent once. Sending it again after a lost answer
   * sets the same values, so it is safe.
   */
  async update(id: number, params: UpdateCollaboratorGroupParams): Promise<T> {
    const group = recordId(id, 'update');
    return writeRecord<T>(this.http, 'PUT', `${this.path}/${group}`, params);
  }

  /**
   * Deletes the group for good with `DELETE /collaborator-groups/{id}`, sent
   * once. Siren answers 204, so this answers `null`. A resend after a lost
   * answer raises `NotFoundError` once the group is gone, whoever removed
   * it, so treat that as done and `retrieve` first if the cause matters.
   */
  async delete(id: number): Promise<T | null> {
    const group = recordId(id, 'delete');
    return deleteRecord<T>(this.http, `${this.path}/${group}`);
  }

  /**
   * The group structures Siren supports, `{ options: [{ id, name,
   * description, providedWalkerCapabilities }] }`, from `GET
   * /collaborator-groups/structures`.
   */
  structures(): Promise<RegistryOptions> {
    return readObject<RegistryOptions>(this.http, `${this.path}/structures`);
  }
}
