import type { HttpTransport } from '../http';
import type {
  CollaboratorGroupMember,
  CollaboratorGroupMemberInput,
  CollaboratorGroupMemberListParams,
} from '../record-types';
import { SirenError } from '../errors';
import type { SirenList } from '../types';
import { deleteRecord, listRecords, recordId, writeList } from './record-requests';

/**
 * Returns `members` as a checked list for `add` or `set`. Throws `SirenError`
 * before sending when `members` is not an array, when it is empty and
 * `allowEmpty` is false, when a member is not an object, or when a member's
 * `collaboratorId` is not a positive whole number.
 */
export function checkedMembers(
  members: unknown,
  method: string,
  allowEmpty: boolean,
): CollaboratorGroupMemberInput[] {
  if (!Array.isArray(members)) {
    throw new SirenError(`${method} needs members as a list.`);
  }
  if (!allowEmpty && members.length === 0) {
    throw new SirenError(`${method} needs at least one member.`);
  }
  for (const member of members) {
    if (typeof member !== 'object' || member === null || Array.isArray(member)) {
      throw new SirenError(`${method} needs each member as an object with a collaboratorId.`);
    }
    recordId((member as { collaboratorId?: unknown }).collaboratorId, method, 'collaboratorId');
  }
  return members as CollaboratorGroupMemberInput[];
}

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
  async list(groupId: number, params: CollaboratorGroupMemberListParams = {}): Promise<SirenList<CollaboratorGroupMember>> {
    const group = recordId(groupId, 'list', 'groupId');
    return listRecords<CollaboratorGroupMember>(
      this.http,
      `/collaborator-groups/${group}/members`,
      params,
      CollaboratorGroupMembersResource.LIST_FILTERS,
      CollaboratorGroupMembersResource.ID_FILTERS,
    );
  }

  /**
   * Adds members, each `{ collaboratorId, metadata? }`, keeping the rest,
   * with `POST /collaborator-groups/{groupId}/members` and body
   * `{ members }`, sent once. Collaborators already in the group are
   * skipped. Answers the member rows Siren added, a bare array that is empty
   * when nobody was new, so a resend after a lost answer is safe and
   * answers only the rows still missing. Throws `SirenError` before sending
   * for an empty list or a member whose `collaboratorId` is not a positive
   * whole number.
   */
  async add(groupId: number, members: readonly CollaboratorGroupMemberInput[]): Promise<CollaboratorGroupMember[]> {
    const group = recordId(groupId, 'add', 'groupId');
    const checked = checkedMembers(members, 'add', false);
    return writeList<CollaboratorGroupMember>(this.http, 'POST', `/collaborator-groups/${group}/members`, { members: checked });
  }

  /**
   * Replaces the group's members with exactly this list, with `PUT
   * /collaborator-groups/{groupId}/members` and body `{ members }`, sent
   * once. An empty list removes every member. Answers the whole member set
   * after the change, a bare array. Sending it again after a lost answer sets the same values, so it is safe. Throws `SirenError`
   * before sending for a member whose `collaboratorId` is not a positive
   * whole number.
   */
  async set(groupId: number, members: readonly CollaboratorGroupMemberInput[]): Promise<CollaboratorGroupMember[]> {
    const group = recordId(groupId, 'set', 'groupId');
    const checked = checkedMembers(members, 'set', true);
    return writeList<CollaboratorGroupMember>(this.http, 'PUT', `/collaborator-groups/${group}/members`, { members: checked });
  }

  /**
   * Removes one collaborator from the group with `DELETE
   * /collaborator-groups/{groupId}/members/{collaboratorId}`, sent once.
   * Siren answers 204, so this answers `null`. Siren answers 404 when the
   * collaborator is not a member or the group is gone, raised as
   * `NotFoundError`. After a lost answer, treat a `NotFoundError` on the
   * resend as the removal being done, and read the group first if the cause
   * matters.
   */
  async remove(groupId: number, collaboratorId: number): Promise<Record<string, unknown> | null> {
    const group = recordId(groupId, 'remove', 'groupId');
    const member = recordId(collaboratorId, 'remove', 'collaboratorId');
    return deleteRecord<Record<string, unknown>>(this.http, `/collaborator-groups/${group}/members/${member}`);
  }
}
