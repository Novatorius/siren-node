import type {
  CollaboratorStatus,
  ConversionStatus,
  CreditHoldStatus,
  CustomCurrencyType,
  DistributorStatus,
  OpportunityStatus,
  ProgramGroupSorter,
  ProgramStatus,
} from './taxonomy';
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

// ---------------------------------------------------------------------------
// Slice 4: opportunities, engagements, distributors, custom currencies,
// store credit, mappings, shared settings, and conversion and transaction
// writes.

/** An opportunity: a tracked visitor's chance to convert. Siren opens them from `site-visited` events. */
export interface Opportunity {
  id: number;
  status?: OpportunityStatus | (string & {});
  /** When the opportunity was last triggered. */
  lastTriggered?: string;
  createdDate?: string;
  modifiedDate?: string;
  dateCreated?: string;
  dateModified?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `opportunities.list()`. */
export interface OpportunityListParams extends RecordListParams {
  status?: OpportunityStatus | ReadonlyArray<OpportunityStatus>;
  /**
   * The opportunities a collaborator owns, through Siren's customer links.
   * A connected site must send this, or read one opportunity by id.
   */
  collaboratorId?: number;
  orderBy?: 'id' | 'status' | 'lastTriggered' | 'dateCreated' | 'dateModified';
}

/** The fields `opportunities.update()` sends. */
export interface UpdateOpportunityParams {
  /** `active` or `inactive`. */
  status?: 'active' | 'inactive';
  lastTriggered?: string;
}

/** An engagement: a collaborator's claim on an opportunity in one program. Siren makes them while it processes events. */
export interface Engagement {
  id: number;
  opportunityId?: number;
  programId?: number;
  collaboratorId?: number;
  /** A default field of `list()`. */
  collaboratorName?: string;
  /** A default field of `list()`. */
  programName?: string;
  score?: number;
  status?: string;
  source?: string;
  conversionId?: number | null;
  /** As ISO 8601 with an offset. */
  dateCreated?: string;
  /** As ISO 8601 with an offset. */
  dateModified?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `engagements.list()`. */
export interface EngagementListParams extends RecordListParams {
  status?: string | ReadonlyArray<string>;
  collaboratorId?: number | ReadonlyArray<number>;
  programId?: number | ReadonlyArray<number>;
  opportunityId?: number | ReadonlyArray<number>;
  /** The first day to include, `YYYY-MM-DD`, by `dateCreated` in the list's time zone. */
  from?: string;
  /** The last day to include, `YYYY-MM-DD`. */
  to?: string;
  orderBy?:
    | 'id'
    | 'opportunityId'
    | 'programId'
    | 'collaboratorId'
    | 'score'
    | 'status'
    | 'source'
    | 'dateCreated'
    | 'dateModified';
}

/** A distributor: a pool that shares revenue among the collaborators it covers, on a schedule. */
export interface Distributor {
  id: number;
  name?: string;
  description?: string;
  status?: DistributorStatus | (string & {});
  units?: string;
  distributionResolver?: string;
  distributionPoolResolver?: string;
  /** Date modifiers such as `first day of next month`. Sent by `retrieve()`. */
  schedule?: string[] | null;
  engagementTypes?: Array<Record<string, unknown>>;
  transactionCompilers?: string[];
  revenuePercentage?: number | null;
  lineItemFilters?: Record<string, unknown> | null;
  /** With `include: 'extended'`. */
  collaboratorCount?: number;
  /** On a read, as ISO 8601 with an offset. On a write's answer, as Siren stores it, such as `2026-10-16 12:00:00`. */
  dateCreated?: string | null;
  /** As `dateCreated`. */
  dateModified?: string | null;
  [field: string]: unknown;
}

/** Filters and sorting for `distributors.list()`. */
export interface DistributorListParams extends RecordListParams {
  status?: DistributorStatus | ReadonlyArray<DistributorStatus>;
  /** Searches name and description. */
  s?: string;
  /** Distributors that count this metric type. */
  metricType?: string;
  orderBy?: 'id' | 'name' | 'status' | 'dateCreated';
}

/** The fields `distributors.create()` sends. */
export interface CreateDistributorParams {
  name: string;
  description: string;
  distributionResolver: string;
  distributionPoolResolver: string;
  /** `active` or `inactive` on create. */
  status: DistributorStatus;
  /** A currency code. */
  units: string;
  revenuePercentage?: number;
  /** Date modifiers such as `first day of next month`. */
  schedule?: string[];
  engagementTypes?: Record<string, unknown>;
  collaboratorIds?: number[];
  collaboratorGroupId?: number;
  transactionCompilers?: unknown[];
  lineItemFilters?: unknown[];
  postAllocationActions?: unknown[];
  metricFilters?: unknown[];
  [field: string]: unknown;
}

/** The fields `distributors.update()` sends. Send only the fields to change. */
export type UpdateDistributorParams = Partial<CreateDistributorParams>;

/** What `distributors.creditMetric()` answers: the distributors that counted the credit and those that did not. */
export interface CreditedMetric {
  success?: boolean;
  credited?: Array<{ id: number; name?: string }>;
  notCredited?: Array<{ id: number; name?: string }>;
  [field: string]: unknown;
}

/** A custom currency: points, store credit or another unit an organization defines. Keyed by `code`. */
export interface CustomCurrency {
  code: string;
  name?: string;
  symbol?: string;
  symbolPosition?: 'before' | 'after' | (string & {});
  type?: CustomCurrencyType | (string & {});
  exchangeRate?: number;
  /** Decimal places. An internal currency counts whole units, so 0. */
  scale?: number;
  /** On Siren Cloud, the stores the currency is bound to. */
  propertyIds?: number[];
  stores?: Array<{ id: number; name?: string }>;
  /** On a write's answer, as Siren stores it. */
  createdDate?: string | null;
  /** On a write's answer, as Siren stores it. */
  modifiedDate?: string | null;
  [field: string]: unknown;
}

/** Filters and sorting for `customCurrencies.list()`. */
export interface CustomCurrencyListParams extends RecordListParams {
  type?: CustomCurrencyType | ReadonlyArray<CustomCurrencyType>;
  code?: string | ReadonlyArray<string>;
  orderBy?: 'code' | 'name' | 'symbol' | 'symbolPosition' | 'type' | 'exchangeRate' | 'dateCreated' | 'dateModified';
}

/** The fields `customCurrencies.create()` sends. */
export interface CreateCustomCurrencyParams {
  /** Upper case letters, digits and underscores, at most 50, unique, and not a built-in currency's code. */
  code: string;
  name: string;
  /** At most 10 characters, and may be empty. */
  symbol: string;
  /** Siren Cloud accepts only `internal` here, and reads a missing type as `internal`. */
  type?: CustomCurrencyType;
  symbolPosition?: 'before' | 'after';
  /** A whole number from 1 to 1,000,000. */
  exchangeRate?: number;
  scale?: number;
  /** The stores to bind it to. Siren Cloud requires at least one. */
  propertyIds?: number[];
}

/** The fields `customCurrencies.update()` sends. Siren refuses a change of `type`. */
export interface UpdateCustomCurrencyParams {
  name?: string;
  symbol?: string;
  symbolPosition?: 'before' | 'after';
  exchangeRate?: number;
  /** Replaces the stores the currency is bound to. */
  propertyIds?: number[];
}

/** What `customCurrencies.delete()` answers. */
export interface DeletedCustomCurrency {
  success?: boolean;
  /** The active programs that paid in the currency, which Siren set to `inactive`. */
  deactivatedPrograms?: Array<{ id: number; name?: string }>;
  [field: string]: unknown;
}

/** One entry of a collaborator's `creditBalances` field, as `credits.balances()` reads it. */
export interface CreditBalance {
  currency: string | number;
  /** The ledger sum, gross of holds. */
  balance?: number;
  onHold?: number;
  /** The balance less what holds reserve. */
  available?: number;
  name?: string;
  symbol?: string;
  symbolPosition?: string;
  exchangeRate?: number;
  /** On Siren Cloud with store bindings, the stores that hold the credit. */
  stores?: Array<{ id: number; name?: string }>;
  /** On Siren Cloud with store bindings, the stores where it can be spent. */
  redeemAt?: Array<{ id: number; name?: string }>;
  [field: string]: unknown;
}

/** One row of `GET /credit-balances`, the read a checkout makes. Amounts are whole minor units. */
export interface CheckoutBalance {
  collaboratorId: number;
  currency: string;
  /** The ledger sum. */
  balance: number;
  /** Credit live holds reserve. */
  reserved: number;
  /** `balance` less `reserved`, never below zero. */
  available: number;
  [field: string]: unknown;
}

/** One store credit ledger entry. */
export interface CreditEntry {
  id: number;
  collaboratorId: number;
  currency: string;
  amount: number;
  sourceType?: string;
  sourceId?: string | number | null;
  description?: string | null;
  idempotencyKey?: string | null;
  createdDate?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `credits.entries()`. A query must name `collaboratorId` or `idempotencyKey`. */
export interface CreditEntryListParams extends RecordListParams {
  collaboratorId?: number;
  idempotencyKey?: string;
  currency?: string;
  sourceType?: string;
  sourceId?: string | number;
  description?: string;
  orderBy?: 'id' | 'dateCreated' | 'amount';
}

/** A store credit hold a checkout placed. */
export interface CreditHold {
  id: number;
  collaboratorId?: number;
  currency?: string;
  amount?: number;
  status?: CreditHoldStatus | (string & {});
  /** As Siren stores it, with the site's Property, such as `hold:woocommerce@property:5:{token}`. */
  reference?: string;
  idempotencyKey?: string | null;
  expiresAt?: string;
  createdDate?: string;
  [field: string]: unknown;
}

/** Filters and sorting for `credits.holds()`. A query must name `collaboratorId`, `reference` or `idempotencyKey`. */
export interface CreditHoldListParams extends RecordListParams {
  collaboratorId?: number;
  /** As `CreditsResource.holdReference()` builds it. */
  reference?: string;
  idempotencyKey?: string;
  currency?: string;
  status?: CreditHoldStatus | ReadonlyArray<CreditHoldStatus>;
  orderBy?: 'id' | 'dateCreated' | 'expiresAt';
}

/** What `credits.adjust()` answers: the ledger entry it wrote, with its signed amount. */
export interface CreditAdjustment {
  success?: boolean;
  entry?: { id: number; amount: number; currency: string; collaboratorId: number; [field: string]: unknown };
  [field: string]: unknown;
}

/** A link between a Siren record and a record outside Siren. */
export interface Mapping {
  localId: number;
  localType: string;
  externalId: string;
  /** The plain type, with any `@property:N` taken off. */
  externalType: string;
  /** The Property whose namespace holds the link, or `null` for one in no site's namespace. */
  propertyId?: number | null;
  [field: string]: unknown;
}

/**
 * Filters and sorting for `mappings.list()`. `externalType` is required:
 * `list()` throws `SirenError` before sending without it.
 */
export interface MappingListParams extends RecordListParams {
  externalType?: string;
  localType?: string;
  localId?: number | ReadonlyArray<number>;
  externalId?: string;
  orderBy?: 'localId' | 'externalId' | 'localType' | 'externalType';
}

/** Paging and sorting for `mappings.forExternal()` and `forLocal()`. */
export type MappingPageParams = Pick<RecordListParams, 'page' | 'perPage' | 'number' | 'offset' | 'order' | 'fields'> & {
  orderBy?: MappingListParams['orderBy'];
};

/** One setting Siren shares with a connected site. */
export interface SharedSetting {
  type: string;
  subtype: string;
  configKey: string;
  value: unknown;
  [field: string]: unknown;
}

/** The fields `conversions.create()` sends. */
export interface CreateConversionParams {
  engagementId: number;
  type: string;
  status: ConversionStatus;
  transactionId?: number;
  obligationId?: number;
  [field: string]: unknown;
}

/** The fields `conversions.update()` sends. Send only the fields to change. */
export type UpdateConversionParams = Partial<CreateConversionParams>;

/** One line of a transaction as `transactions.details()` reads it, value in minor units per unit. */
export interface TransactionDetailRecord {
  id?: number;
  transactionId?: number;
  name?: string;
  description?: string | null;
  type?: string | null;
  value?: number;
  quantity?: number;
  units?: string;
  [field: string]: unknown;
}

/** One line `transactions.create()` sends, value in minor units per unit. */
export interface TransactionDetail {
  name: string;
  value: number;
  quantity?: number;
  type?: string;
  description?: string;
  units?: string;
  attributes?: Record<string, unknown>;
  [field: string]: unknown;
}

/** The fields `transactions.create()` sends. */
export interface CreateTransactionParams {
  /** One to 500 lines. */
  details: TransactionDetail[];
  /** An outside reference Siren stores as a mapping, so the transaction can be found again. */
  bindingId?: string;
  bindingDataType?: string;
  [field: string]: unknown;
}
