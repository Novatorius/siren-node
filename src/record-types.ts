import type { CollaboratorStatus, ProgramGroupSorter, ProgramStatus } from './taxonomy';
import type { ListParams } from './types';

/*
 * Wire types for the record resources: collaborators, their
 * codes and enrollments, collaborator groups and their members, programs and
 * program groups. Siren Cloud owns these shapes. The field names match the
 * bodies its controllers build and the Siren PHP SDK's docblocks.
 *
 * A record read answers only the fields a caller asks for with `fields`, so
 * every field but `id` is optional, and the index signature keeps a field
 * this SDK does not name yet.
 */

/** Sort direction for a record list. */
export type RecordSortOrder = 'ASC' | 'DESC';

/**
 * Parameters every record list takes. Page with `page` and `perPage`, which
 * the SDK turns into Siren's `number` and `offset`, or pass `number` and
 * `offset` yourself. `fields` picks the returned fields, as a list or a
 * comma-separated string. Each resource's own params add the filters its
 * route reads, and a list value is sent comma-separated, which Siren reads
 * as "any of". A key the route does not read, and an empty filter list,
 * throw `SirenError`.
 */
export interface RecordListParams extends Pick<ListParams, 'page' | 'perPage' | 'number' | 'offset'> {
  /** The column to sort by. Each resource names the columns its route accepts. */
  orderBy?: string;
  /** `ASC` or `DESC`. */
  order?: RecordSortOrder;
  /** The fields to return, as a list or a comma-separated string. */
  fields?: ReadonlyArray<string> | string;
}

/** What a bulk action answers: `{ success: true, affected }`. */
export interface BulkResult {
  success?: boolean;
  /**
   * How many records the action changed. Siren skips ids it cannot find or
   * fails to change and still answers 200, so compare this with the number
   * of ids sent.
   */
  affected?: number;
  [field: string]: unknown;
}

/** A status vocabulary, such as `collaborators.statusTypes()` answers: each status with its label, and its tone. */
export interface StatusTypes {
  options: Record<string, string>;
  tones?: Record<string, string>;
  [field: string]: unknown;
}

/** One entry of a registry list, such as an incentive resolver or a group structure. */
export interface RegistryOption {
  id: string;
  name?: string;
  description?: string;
  [field: string]: unknown;
}

/** A registry list, such as `programs.incentiveTypes()` answers. */
export interface RegistryOptions {
  options: RegistryOption[];
  [field: string]: unknown;
}

/** A referral code Siren offers for a new collaborator. */
export interface GeneratedReferralCode {
  code: string;
  [field: string]: unknown;
}

/** A currency a program can pay in, as `programs.currencyTypes()` lists it. */
export interface ProgramCurrency {
  id: string;
  symbol?: string;
  position?: string;
  name?: string;
  scale?: number;
  decimalPlaces?: number;
  type?: string;
  [field: string]: unknown;
}

// ---------------------------------------------------------------------------
// Collaborators

/** A collaborator: an affiliate, partner or referrer a program pays. */
export interface Collaborator {
  id: number;
  status?: CollaboratorStatus | (string & {});
  fullName?: string;
  nickname?: string;
  email?: string;
  /** On a read, as ISO 8601 with an offset, such as `2026-01-15T10:30:00+00:00`. */
  createdDate?: string;
  /** On a read, as ISO 8601 with an offset. */
  modifiedDate?: string;
  /** On a write's answer, as Siren stores it, such as `2026-10-16 12:00:00`. */
  dateCreated?: string;
  /** On a write's answer, as Siren stores it. */
  dateModified?: string;
  /** The current tracking code, or `null`. A default field of `retrieve()`. */
  referralCode?: string | null;
  [field: string]: unknown;
}

/** Filters and sorting for `collaborators.list()`. */
export interface CollaboratorListParams extends RecordListParams {
  id?: number | ReadonlyArray<number>;
  status?: CollaboratorStatus | ReadonlyArray<CollaboratorStatus>;
  fullName?: string | ReadonlyArray<string>;
  nickname?: string | ReadonlyArray<string>;
  email?: string | ReadonlyArray<string>;
  /** Searches name, nickname, email and tracking codes. */
  s?: string;
  /** Collaborators enrolled in this program: one id, never a list, since Siren reads it as one whole number. */
  programId?: number;
  /** Collaborators this distributor covers: one id, never a list. */
  distributorId?: number;
  orderBy?: 'id' | 'status' | 'fullName' | 'nickname' | 'email' | 'dateCreated' | 'dateModified';
}

/** The fields `collaborators.create()` sends. */
export interface CreateCollaboratorParams {
  fullName: string;
  nickname: string;
  email: string;
  /** `active`, `inactive` or `pending` on create. */
  status: CollaboratorStatus;
  /** The tracking code. Siren generates one when it is left out. */
  trackingId?: string;
  /** Program ids. A list that is sent is the whole new set. */
  programs?: number[];
  /** Distributor ids. A list that is sent is the whole new set. */
  distributors?: number[];
  /** Collaborator group ids. A list that is sent is the whole new set. */
  groups?: number[];
}

/** The fields `collaborators.createPending()` sends, the way a connected site must. */
export interface CreatePendingCollaboratorParams {
  fullName: string;
  nickname: string;
  email: string;
  trackingId?: string;
}

/** The fields `collaborators.update()` sends. Send only the fields to change. */
export interface UpdateCollaboratorParams extends Partial<Omit<CreateCollaboratorParams, 'status'>> {
  /** Any status but `deleted` and `invited`, which Siren sets itself. */
  status?: CollaboratorStatus;
  /**
   * The collaborator's custom fields, keyed by lower-case letters, digits and
   * underscores. An empty value removes the key.
   */
  fields?: Record<string, string>;
}

/** The fields `collaborators.updateDetails()` sends, the way a connected site must. */
export interface UpdateCollaboratorDetailsParams {
  fullName?: string;
  nickname?: string;
}

// ---------------------------------------------------------------------------
// Collaborator aliases (tracking and coupon codes)

/** One code on `/collaborator-aliases`, with the plain type and the Property it is filed under. */
export interface CollaboratorAlias {
  code: string;
  /** The plain type, such as `coupon`, with any `@property:N` taken off. */
  type: string;
  collaboratorId: number;
  dateIssued?: string;
  /** The Property whose namespace holds the code, or `null` for a code in no site's namespace. */
  propertyId?: number | null;
  [field: string]: unknown;
}

/** One entry of a collaborator record's `aliases` field, as Siren stores it. */
export interface CollaboratorAliasEntry {
  code: string;
  /** The type as Siren stores it, so a connected site's code reads `coupon@property:5`. */
  type: string;
  issuedDate?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `collaborators.aliases.query()`. */
export interface CollaboratorAliasQueryParams extends RecordListParams {
  code?: string | ReadonlyArray<string>;
  /** A plain type, matched in every namespace. A connected site may send only one. */
  type?: string | ReadonlyArray<string>;
  collaboratorId?: number | ReadonlyArray<number>;
  orderBy?: 'dateIssued' | 'code' | 'type' | 'collaboratorId';
}

/** What `collaborators.aliases.free()` and the enrollment `remove()` answer. */
export interface DeletedResult {
  deleted: boolean;
  [field: string]: unknown;
}

// ---------------------------------------------------------------------------
// Program enrollments

/** One enrollment row on `/collaborator-programs`. */
export interface ProgramEnrollment {
  collaboratorId: number;
  programId: number;
  [field: string]: unknown;
}

/** Filters and sorting for `collaborators.enrollments.list()`. */
export interface ProgramEnrollmentListParams extends RecordListParams {
  collaboratorId?: number | ReadonlyArray<number>;
  programId?: number | ReadonlyArray<number>;
  orderBy?: 'collaboratorId' | 'programId';
}

/** One program in a collaborator record's `programs` field. */
export interface EnrolledProgram {
  id: number;
  name?: string;
  [field: string]: unknown;
}

// ---------------------------------------------------------------------------
// Collaborator groups

/** A collaborator group: a named set of collaborators programs and distributors can target. */
export interface CollaboratorGroup {
  id: number;
  name?: string;
  description?: string;
  structure?: string;
  dateCreated?: string;
  dateModified?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `collaboratorGroups.list()`. */
export interface CollaboratorGroupListParams extends RecordListParams {
  structure?: string | ReadonlyArray<string>;
  /** Searches name and description. */
  s?: string;
  orderBy?: 'id' | 'name' | 'description' | 'structure' | 'dateCreated' | 'dateModified';
}

/** One member to add or set: a collaborator, with optional metadata. */
export interface CollaboratorGroupMemberInput {
  collaboratorId: number;
  metadata?: Record<string, unknown>;
}

/** The fields `collaboratorGroups.create()` sends. */
export interface CreateCollaboratorGroupParams {
  name: string;
  /** Such as `flat`. `collaboratorGroups.structures()` lists them. */
  structure: string;
  description?: string;
  members?: CollaboratorGroupMemberInput[];
}

/** The fields `collaboratorGroups.update()` sends. */
export interface UpdateCollaboratorGroupParams {
  name?: string;
  description?: string;
  structure?: string;
}

/** One member row on `/collaborator-groups/{id}/members`. */
export interface CollaboratorGroupMember {
  id: number;
  groupId?: number;
  collaboratorId: number;
  metadata?: unknown;
  dateCreated?: string;
  dateModified?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `collaboratorGroups.members.list()`. */
export interface CollaboratorGroupMemberListParams extends RecordListParams {
  collaboratorId?: number | ReadonlyArray<number>;
  orderBy?: 'id' | 'groupId' | 'collaboratorId' | 'dateCreated' | 'dateModified';
}

// ---------------------------------------------------------------------------
// Programs

/** A program: the incentive rules that turn engagements into rewards. */
export interface Program {
  id: number;
  name?: string;
  description?: string;
  status?: ProgramStatus | (string & {});
  /** A plain id on a write's answer, and `{ id, name }` on a read. */
  incentiveType?: string | { id: string; name?: string };
  /** A plain id on a write's answer, and `{ id, name }` on a read. */
  incentiveResolverType?: string | { id: string; name?: string };
  units?: string;
  /** On a read, as ISO 8601 with an offset. */
  createdDate?: string;
  /** On a read, as ISO 8601 with an offset. */
  modifiedDate?: string;
  /** On a write's answer, as Siren stores it, such as `2026-10-16 12:00:00`. */
  dateCreated?: string;
  /** On a write's answer, as Siren stores it. */
  dateModified?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `programs.list()`. */
export interface ProgramListParams extends RecordListParams {
  status?: ProgramStatus | ReadonlyArray<ProgramStatus>;
  incentiveType?: string | ReadonlyArray<string>;
  incentiveResolverType?: string | ReadonlyArray<string>;
  /** A currency code, or a list of them. */
  units?: string | ReadonlyArray<string>;
  /** Searches name and description. */
  s?: string;
  /** Programs in this program group: one id, never a list, since Siren reads it as one whole number. */
  programGroupId?: number;
  /** Programs with a rule for this engagement type, such as `sale`. One type, matched exactly. */
  engagementType?: string;
  orderBy?:
    | 'id'
    | 'name'
    | 'description'
    | 'incentiveType'
    | 'incentiveResolverType'
    | 'status'
    | 'units'
    | 'dateCreated'
    | 'dateModified';
}

/** One engagement type's rule in a program's `engagementTypes`. */
export interface ProgramEngagementRule {
  calculationType: string;
  calculationArgs?: Record<string, unknown>;
}

/** The fields `programs.create()` sends. */
export interface CreateProgramParams {
  name: string;
  description: string;
  /** `active` or `inactive` on create. */
  status: ProgramStatus;
  incentiveType: string;
  incentiveResolverType: string;
  /** A currency code. */
  units: string;
  /** A map of engagement type to its rule. */
  engagementTypes: Record<string, ProgramEngagementRule>;
  incentiveTypeArgs?: Record<string, unknown>;
  /** Needs the Plus plan. */
  collaboratorIds?: number[];
  /** Needs the Plus plan. */
  collaboratorGroupId?: number;
  [field: string]: unknown;
}

/** The fields `programs.update()` sends. `engagementTypes`, when sent, replaces the program's rules. */
export interface UpdateProgramParams extends Partial<Omit<CreateProgramParams, 'status'>> {
  /** `active`, `inactive`, `draft` or `deleted`. */
  status?: ProgramStatus | 'draft';
}

// ---------------------------------------------------------------------------
// Program groups

/** A program group: programs that compete for the same engagement, with a sorter that picks the winner. */
export interface ProgramGroup {
  id: number;
  name?: string;
  description?: string;
  sorter?: ProgramGroupSorter | (string & {});
  [field: string]: unknown;
}

/** Filters and sorting for `programGroups.list()`. */
export interface ProgramGroupListParams extends RecordListParams {
  sorter?: ProgramGroupSorter | ReadonlyArray<ProgramGroupSorter>;
  /** Searches name and description. */
  s?: string;
  orderBy?: 'id' | 'name' | 'description' | 'sorter';
}

/** The fields `programGroups.create()` sends. */
export interface CreateProgramGroupParams {
  name: string;
  description: string;
  /** A {@link ProgramGroupSorter} value. */
  sorter: ProgramGroupSorter;
  /** Program ids. */
  programs?: number[];
}

/** The fields `programGroups.update()` sends. `programs`, when sent, replaces the group's programs. */
export type UpdateProgramGroupParams = Partial<CreateProgramGroupParams>;
