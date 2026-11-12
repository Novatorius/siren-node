import type { HttpTransport } from '../http';
import type {
  CollaboratorGroupMember,
  CollaboratorGroupMemberInput,
  CollaboratorGroupMemberListParams,
} from '../record-types';
import type { SirenList } from '../types';

/**
 * The members of a collaborator group (`/collaborator-groups/{id}/members`).
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * Every write is sent once. Every id must be a positive whole number, and a
 * bad one throws `SirenError` before sending.
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 */
export class CollaboratorGroupMembersResource {
  /** The filters the members list reads. {@link list} refuses any other key. */
  static readonly LIST_FILTERS = ['collaboratorId'] as const;
  /** The id filters its list reads, checked before sending: `collaboratorId` takes one id or a list, each a positive whole number. */
  static readonly ID_FILTERS = { many: ['collaboratorId'] } as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * Lists one page of a group's members with `GET
   * /collaborator-groups/{groupId}/members`. Filter: `collaboratorId`. Sort
   * with `orderBy` and `order`.
   * Sends through `listRecords` with {@link CollaboratorGroupMembersResource.LIST_FILTERS} and
   * {@link CollaboratorGroupMembersResource.ID_FILTERS}: any other key
   * and an empty filter list throw `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  list(groupId: number, params: CollaboratorGroupMemberListParams = {}): Promise<SirenList<CollaboratorGroupMember>> {
    // Stub: slice 3 packet P7
    void groupId;
    void params;
    void this.http;
    return Promise.resolve([] as unknown as SirenList<CollaboratorGroupMember>);
  }

  /**
   * Adds members, each `{ collaboratorId, metadata? }`, keeping the rest,
   * with `POST /collaborator-groups/{groupId}/members` and body
   * `{ members }`, sent once. Collaborators already in the group are
   * skipped. Answers the member rows Siren added, a bare array that is empty
   * when nobody was new. Throws `SirenError` before sending for an empty
   * list or a member whose `collaboratorId` is not a positive whole number.
   */
  add(groupId: number, members: readonly CollaboratorGroupMemberInput[]): Promise<CollaboratorGroupMember[]> {
    // Stub: slice 3 packet P7
    void groupId;
    void members;
    return Promise.resolve([]);
  }

  /**
   * Replaces the group's members with exactly this list, with `PUT
   * /collaborator-groups/{groupId}/members` and body `{ members }`, sent
   * once. An empty list removes every member. Answers the whole member set
   * after the change, a bare array. Throws `SirenError` before sending for
   * a member whose `collaboratorId` is not a positive whole number.
   */
  set(groupId: number, members: readonly CollaboratorGroupMemberInput[]): Promise<CollaboratorGroupMember[]> {
    // Stub: slice 3 packet P7
    void groupId;
    void members;
    return Promise.resolve([]);
  }

  /**
   * Removes one collaborator from the group with `DELETE
   * /collaborator-groups/{groupId}/members/{collaboratorId}`, sent once.
   * Siren answers 204, so this answers `null`. Siren answers 404 when the
   * collaborator is not a member, raised as `NotFoundError`, so a resend
   * after a lost answer that raises `NotFoundError` means the first one
   * removed them.
   */
  remove(groupId: number, collaboratorId: number): Promise<Record<string, unknown> | null> {
    // Stub: slice 3 packet P7
    void groupId;
    void collaboratorId;
    return Promise.resolve(null);
  }
}
