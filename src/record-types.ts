import type {
  AppItemKind,
  AppRequestMode,
  AppRequestStatus,
  AppSource,
  AppStatus,
  CollaboratorStatus,
  ConversionStatus,
  CreditHoldStatus,
  CustomCurrencyType,
  DistributorStatus,
  FulfillmentStatus,
  OpportunityStatus,
  PayoutStatus,
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

/**
 * The fields `distributors.create()` sends, the fifteen Siren's create route
 * and its listeners read. `create` refuses any other key before sending.
 */
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
  /** The metric types the distributor counts, each `{ type, calculationType, calculationArgs? }`. */
  engagementTypes?: Array<Record<string, unknown>>;
  collaboratorIds?: number[];
  collaboratorGroupId?: number;
  transactionCompilers?: unknown[];
  /** A map of line item filters, as Siren reads it. */
  lineItemFilters?: Record<string, unknown>;
  postAllocationActions?: unknown[];
  metricFilters?: unknown[];
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

/**
 * The fields `customCurrencies.create()` sends, the eight Siren's create route
 * reads. `create` refuses any other key before sending.
 */
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

/**
 * The fields `conversions.create()` sends, the five Siren's create route
 * reads. `create` refuses any other key before sending.
 */
export interface CreateConversionParams {
  engagementId: number;
  type: string;
  /** `pending`, `approved`, `rejected` or `expired`. Siren's create and update routes refuse `deleted`. */
  status: Exclude<ConversionStatus, 'deleted'>;
  transactionId?: number;
  obligationId?: number;
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

/**
 * One line `transactions.create()` sends, value in minor units per unit. These
 * are the seven keys Siren reads on a line, and `create` refuses any other.
 */
export interface TransactionDetail {
  name: string;
  value: number;
  quantity?: number;
  type?: string;
  description?: string;
  units?: string;
  attributes?: Record<string, unknown>;
}

/** The fields `transactions.create()` sends. `create` refuses any other key. */
export interface CreateTransactionParams {
  /** One to 500 lines. */
  details: TransactionDetail[];
  /**
   * The outside record's id, such as an order number. Siren stores it with
   * `bindingDataType` as a mapping, and finds a resent transaction only by
   * the two together, so `create` refuses one without the other.
   */
  bindingId?: string | number;
  /** The kind of outside record `bindingId` names, such as `crm_order`. */
  bindingDataType?: string;
}

/**
 * What `conversions.recoverCreate()` answers: the conversion Siren already
 * holds for the create, as its list reads it, with `created: false`, or the
 * one it made when it found none, with `created: true`.
 */
export interface RecoveredConversion<T = Record<string, unknown>> {
  conversion: T;
  created: boolean;
}

/**
 * What `transactions.recoverCreditCollaborator()` answers. `alreadyCredited`
 * holds the asked transactions that already have a conversion of that type
 * for the collaborator, and `credited` the ones it sent, in the order asked.
 * `result` is Siren's answer to that send, or `null` when every transaction
 * was already credited and nothing was sent.
 */
export interface RecoveredCredit {
  alreadyCredited: number[];
  credited: number[];
  result: BulkResult | null;
}

/**
 * A payout: what Siren owes one collaborator in one currency, inside a
 * fulfillment. `payouts.list()` and `payouts.retrieve()` answer the default
 * fields below unless `fields` names others.
 */
export interface Payout {
  id: number;
  status?: PayoutStatus | (string & {});
  /** In the currency's smallest unit, such as cents, as a whole number. */
  value?: number;
  currency?: string;
  collaboratorId?: number;
  fulfillmentId?: number;
  /** As ISO 8601 with an offset, or `null` until it is paid. */
  datePaid?: string | null;
  /** As ISO 8601 with an offset. */
  dateCreated?: string | null;
  /** As ISO 8601 with an offset. */
  dateModified?: string | null;
  /** Why the last automatic payment failed. `null` unless the caller sees the whole organization. */
  failureReason?: string | null;
  dateFailed?: string | null;
  /**
   * Why an unpaid payout waits on its collaborator's payout setup, such as
   * `stripe_account_missing`, `stripe_account_incomplete` or
   * `paypal_email_missing`, or `null` for one that does not wait.
   */
  waitingReason?: string | null;
  dateWaiting?: string | null;
  /** With `include: 'extended'` or by name in `fields`. */
  collaboratorName?: string;
  /** With `include: 'extended'` or by name in `fields`. */
  collaboratorEmail?: string;
  [field: string]: unknown;
}

/**
 * One payout inside a fulfillment's `payouts` field. Siren builds it from
 * the stored payout, so its dates are `Y-m-d H:i:s` rather than ISO 8601,
 * and it carries the collaborator's name.
 */
export interface FulfillmentPayout {
  id: number;
  status?: PayoutStatus | (string & {});
  value?: number;
  currency?: string;
  collaboratorId?: number;
  collaboratorName?: string;
  fulfillmentId?: number;
  datePaid?: string | null;
  failureReason?: string | null;
  dateFailed?: string | null;
  waitingReason?: string | null;
  dateWaiting?: string | null;
  dateCreated?: string | null;
  dateModified?: string | null;
  [field: string]: unknown;
}

/**
 * A fulfillment: one batch of payouts. Siren answers `id`, `status`,
 * `dateCreated` and `dateModified` unless `fields` names others or the read
 * asks for `include: 'extended'`.
 */
export interface Fulfillment {
  id: number;
  status?: FulfillmentStatus | (string & {});
  /** As ISO 8601 with an offset. */
  dateCreated?: string | null;
  /** As ISO 8601 with an offset. */
  dateModified?: string | null;
  payoutCount?: number;
  paidCount?: number;
  /** Every payout that is not paid, the failed and waiting ones included. */
  unpaidCount?: number;
  failedCount?: number;
  /** Payouts waiting on their collaborator's payout setup. Only by name in `fields`. */
  waitingCount?: number;
  /** The sum of the payouts' values, in the currency's smallest unit. */
  totalValue?: number;
  /** The first payout's currency, or `null` for a fulfillment with none. */
  currency?: string | null;
  /** With `include: 'extended'` on `retrieve()`, or by name in `fields`. */
  payouts?: FulfillmentPayout[];
  [field: string]: unknown;
}

/** Filters and sorting for `fulfillments.list()`. */
export interface FulfillmentListParams extends RecordListParams {
  status?: FulfillmentStatus | (string & {}) | ReadonlyArray<string>;
  /**
   * Only fulfillments that hold at least one payout in this status:
   * `paid`, `unpaid`, `processing`, `failed`, or `waiting` for an unpaid
   * payout held for its collaborator's payout setup. `failed` finds the
   * batches that need attention.
   */
  payoutStatus?: 'paid' | 'unpaid' | 'processing' | 'failed' | 'waiting';
  /** Only fulfillments holding a payout in this currency. */
  currency?: string;
  /**
   * The first day to include, `YYYY-MM-DD`, both days included. With no
   * `payoutStatus` the days are the day a payout was paid, and with one the
   * day it was made.
   */
  from?: string;
  /** The last day to include, `YYYY-MM-DD`. */
  to?: string;
  orderBy?: 'id' | 'status' | 'dateCreated';
}

/*
 * Siren apps. Shapes from Siren's app routes (lib/Apps/Service/Rest and
 * AppSerializer, AppItemAdapter, AppRequestSerializer, read on the
 * apps-records and apps-exchange branches) and the request envelope
 * (AppRequestEnvelope, tests/Fixtures/apps-exchange/signed-request.json).
 */

/**
 * One feature an app declares, as `apps.declare()` and `apps.items.create()`
 * send it. The code calls a feature an item. Its `kind` and `key` lock once
 * Siren makes it: a record selects it by id and a file names it by kind and
 * key.
 */
export interface AppItemDeclaration {
  kind: AppItemKind;
  /** Lowercase letters and digits joined by single dashes, at most 64. Unique within the app and kind. */
  key: string;
  /** At most 100 characters. Siren shows it as "{App name}: {item name}" in pickers. */
  name: string;
  /** At most 500 characters. */
  description?: string;
  /** Required for a `payoutMethod` and refused for any other kind: the currency codes it pays. */
  currencies?: string[];
  /** Minutes Siren waits for an answer to an ask, 1 to 43200. Siren's default is 1440, or 60 for a distribution resolver. */
  answerWindowMinutes?: number;
}

/**
 * The whole app, as `PUT /apps/{key}` takes it every time. A field left out
 * reads as empty: no `url` removes the address and its delivery log, and no
 * `scopes` empties the active key's scopes.
 */
export interface DeclareAppParams {
  name: string;
  description?: string;
  /**
   * The public https address Siren sends each request to. Optional: an app
   * with no `url` is a key-only app. An app with features needs one.
   */
  url?: string | null;
  /** API key scopes the app's own key holds. An app may hold none. They reach only an active key. */
  scopes?: string[];
  /** Ordinary webhook events the app also receives at the same address with the same secret. They need a `url`. */
  events?: string[];
  items?: AppItemDeclaration[];
}

/**
 * Whether the organization's plan can use a feature, or the events Siren
 * sends to an app's address, as Siren's AppPlanAccess answers it.
 * `requiredCapability` and `requiredPlan` are null when `entitled` is true.
 * When the plan lacks more than one capability, they name the one in the
 * highest tier, such as `outbound-apps` and `pro`.
 */
export interface AppPlanAccess {
  entitled: boolean;
  requiredCapability: string | null;
  requiredPlan: string | null;
}

/** An app item, a feature, as Siren answers it. A record selects it by `ref`. */
export interface AppItem extends AppPlanAccess {
  id: number;
  /** `app:{id}`, the value a program, distributor or autofulfiller stores. */
  ref: string;
  appId: number;
  kind: AppItemKind | (string & {});
  key: string;
  name: string;
  description: string;
  settings: { currencies?: string[]; answerWindowMinutes?: number };
  status: 'active' | 'archived' | (string & {});
  dateCreated?: string | null;
  dateModified?: string | null;
  [field: string]: unknown;
}

/** One record that selects a feature: a program or distributor by id, an autofulfiller by its currency code. */
export interface AppItemUse {
  record: 'program' | 'distributor' | 'autofulfiller' | (string & {});
  id: number | string;
}

/** One feature as its own routes answer it: the item, how many records select it, and up to 100 of them. */
export interface AppItemPage extends AppItem {
  uses: number;
  usedBy: AppItemUse[];
}

/** What `apps.items.delete()` answers: archived while a record selects it, with the item, or deleted, with `item` null. */
export interface RemovedAppItem {
  archived: boolean;
  item: AppItemPage | null;
}

/** A new feature, as `apps.items.create()` takes it. */
export type CreateAppItemParams = AppItemDeclaration;

/** The fields `apps.items.update()` changes. A feature's kind and key never change. */
export interface UpdateAppItemParams {
  name?: string;
  description?: string;
  currencies?: string[];
  answerWindowMinutes?: number | null;
}

/** An app's active API key as Siren shows it: never more than its prefix and its last four characters. */
export interface AppApiKey {
  id: number;
  /** `sk_test_` or `sk_live_` and 8 more characters. */
  prefix: string;
  /** The raw key's last four characters, so a screen shows `***9f3c`. Null for a key made before Siren kept them. */
  lastFour: string | null;
  scopes: string[];
  propertyId: number | null;
  lastUsedAt: string | null;
  dateCreated: string | null;
}

/** An app's address, the webhook subscription Siren sends its requests and events to. Never its signing secret. */
export interface AppAddress {
  id: number;
  url: string;
  events: string[];
  /** `paused` while the app is off. */
  status: 'active' | 'paused' | (string & {});
  dateCreated: string | null;
}

/** An app as Siren's app routes answer it. No read ever carries its raw key or signing secret. */
export interface App {
  id: number;
  key: string;
  name: string;
  description: string;
  status: AppStatus | (string & {});
  /** Which door made the app: `code` (the app file), `dashboard` or `site`. It never changes. */
  source: AppSource | (string & {});
  /**
   * @deprecated Siren no longer answers it. Read `address.id`. An app finds
   * its parts by their `appId` now (apps-own-parts.md on Siren's
   * int/preview-apps).
   */
  webhookSubscriptionId?: number | null;
  /** @deprecated Siren no longer answers it. Read `apiKey.id`. */
  apiKeyId?: number | null;
  /** The address's url, or null when the app has no address. */
  url: string | null;
  /** The events Siren sends to the address, `[]` with no address. */
  events: string[];
  /** The active key's scopes, `[]` with no key. */
  scopes: string[];
  /** The first 16 characters of the app's key, `sk_test_` or `sk_live_` and 8 more, or null with no key. */
  apiKeyPrefix: string | null;
  /** The active key, or null when the app holds none. */
  apiKey: AppApiKey | null;
  /** The address, or null when the app holds none. */
  address: AppAddress | null;
  items: AppItem[];
  /** Whether the plan lets Siren send events to the app's address. Events go out of Siren and need Pro. */
  eventsAccess: AppPlanAccess;
  /** How many of the app's requests need a person now, as Siren's AppAttention counts them. */
  needsAttention: number;
  dateCreated?: string | null;
  dateModified?: string | null;
  [field: string]: unknown;
}

/** The two secrets Siren shows once, each by the route that made it. */
export interface AppSecrets {
  /** The app's API key, `sk_test_` in the sandbox and `sk_live_` on the live deployment. */
  rawKey: string;
  /** The secret Siren signs each request to the app with. */
  signingSecret: string;
}

/**
 * What `apps.declare()` answers. `created` is true, and `rawKey` present,
 * only when this call made the app, since only the first declaration makes a
 * key. `signingSecret` is present whenever this call made an address: on the
 * first declaration with a `url`, and on a later one that adds a `url` the
 * app had no address for.
 */
export type DeclaredApp =
  | (App & { created: true; rawKey: string; signingSecret?: string })
  | (App & { created: false; signingSecret?: string });

/**
 * @deprecated `apps.rotate()` is gone, since Siren removed
 * `POST /apps/{key}/rotate`. `apps.rotateKey()` answers {@link AppWithRawKey}
 * and `apps.rotateSecret()` answers {@link AppWithSigningSecret}.
 */
export type RotatedApp = App & AppSecrets;

/** An app with the raw key a key route made, shown this once. */
export type AppWithRawKey = App & { rawKey: string };

/** An app with the signing secret a route made, shown this once. */
export type AppWithSigningSecret = App & { signingSecret: string };

/** A new app from the dashboard's door, as `apps.create()` sends it to `POST /apps`. */
export interface CreateAppParams {
  name: string;
  description?: string;
  /** Makes an address. */
  url?: string | null;
  /** A list, even `[]`, makes a key with these scopes. Leave it out for an address-only app. */
  scopes?: string[] | null;
  /** The events Siren sends to the address. They need a `url`. */
  events?: string[] | null;
}

/** What `apps.create()` answers: the app, `rawKey` when it made a key and `signingSecret` when it made an address. */
export type CreatedApp = App & { rawKey?: string; signingSecret?: string };

/**
 * A change to an app, as `apps.update()` sends it to `PATCH /apps/{key}`.
 * Only the fields sent change. `url: null` removes the address.
 */
export interface UpdateAppParams {
  name?: string;
  description?: string;
  url?: string | null;
  events?: string[];
  scopes?: string[];
}

/** What `apps.update()` answers: the app, and `signingSecret` when the change made an address. */
export type UpdatedApp = App & { signingSecret?: string };

/** One settings field a feature's kind takes, as the kinds catalog describes it. */
export interface AppItemKindSetting {
  field: string;
  label: string;
  /** `integer`, or `currencies`, a list of currency codes Siren knows for the org. */
  type: 'integer' | 'currencies' | (string & {});
  required: boolean;
  min?: number;
  max?: number;
  help?: string;
  [field: string]: unknown;
}

/** One kind of feature an app may add, from `GET /apps/kinds` (AppItemKindCatalog::catalog() and AppPlanAccess). */
export interface AppItemKindEntry extends AppPlanAccess {
  kind: AppItemKind | (string & {});
  /** The documentation's term, such as `payout method`. */
  term: string;
  /** The readable name, such as `Payout method`. */
  name: string;
  description: string;
  /** `tell`: Siren waits for no answer. `ask`: Siren waits for the app's answer. */
  mode: 'tell' | 'ask' | (string & {});
  /** `out`: something goes out of Siren to the app, which needs Pro. `in`: the app's logic comes in. */
  direction: 'out' | 'in' | (string & {});
  /** Other names people use for it, such as `autofulfiller`. */
  aliases: string[];
  /** The documentation page that uses the term, or null. */
  docs: string | null;
  settings: AppItemKindSetting[];
  [field: string]: unknown;
}

/** A request Siren sent an app, as `GET /apps/requests` lists it. The data and the answer stay out. */
export interface AppRequestRecord {
  /** The request key, `apr_` and 32 hex characters, the same on every send. */
  id: string;
  appId: number;
  /** `app:{id}` of the item Siren acted for. */
  item: string;
  kind: AppItemKind | (string & {});
  mode: AppRequestMode | (string & {});
  subject: { type: string; id: string };
  status: AppRequestStatus | (string & {});
  sendCount: number;
  answerBy: string | null;
  /** `app:{appId}` or `user:{userId}`. */
  answeredBy: string | null;
  answeredAt: string | null;
  lastError: string | null;
  createdAt: string;
  [field: string]: unknown;
}

/**
 * One request as `GET /apps/requests/{requestKey}` answers it
 * (AppRequestSerializer::toDetail()): the list's fields, the data Siren
 * sent, the answer it took, and the person who gave that answer.
 */
export interface AppRequestDetail extends AppRequestRecord {
  /** The `data` Siren sent the app, `{}` when there was none. */
  data: Record<string, unknown>;
  /** The answer Siren took, or null before one. A tell takes none. */
  answer: Record<string, unknown> | null;
  /** The person behind a `user:{id}` answer, or null when the app answered, before an answer, or when that user is gone. */
  answeredByUser: { id: number; email: string } | null;
}

/** Filters for `apps.requests.list()`. */
export interface AppRequestListParams {
  status?: AppRequestStatus;
}

/**
 * An app's answer to an ask: a JSON object with an `outcome` the item's kind
 * reads, such as `{ outcome: 'paid', reference: 'TX-88213' }` for a
 * fulfillment method. At most 16384 bytes as JSON.
 */
export interface AppAnswer {
  outcome: string;
  [field: string]: unknown;
}

/** What the answer route says. `duplicate` is true when Siren already held this same answer. */
export interface AppAnswerReceipt {
  status: 'accepted';
  duplicate: boolean;
}

/** The fields every request Siren sends an app carries, from its signed body. */
interface AppRequestBase {
  version: 1;
  /** The request key. Drop a repeat by this id, which the signature covers. */
  id: string;
  type: 'app.request';
  /** The app's key. */
  app: string;
  item: { kind: AppItemKind | (string & {}); key: string; id: string };
  createdAt: string;
  /** The kind's payload. Its fields belong to the item's kind. */
  data: Record<string, unknown>;
  /** The signed `t` of `X-Siren-Signature-V2`, in Unix seconds. */
  timestamp: number;
  /** The `X-Siren-Delivery` header, `{id}.{send number}`, when the request carried one. */
  deliveryId?: string;
}

/** A request that needs no answer. */
export interface AppTell extends AppRequestBase {
  mode: 'tell';
}

/** A request that waits for the app's answer. */
export interface AppAsk extends AppRequestBase {
  mode: 'ask';
  /** When Siren sends the request again, or marks it as needing attention. */
  answerBy: string;
  /** Where the answer goes. `apps.requests.answer(id, answer)` posts to the same route. */
  answerUrl: string;
}

/** A checked request from Siren, as `apps.verifyRequest()` answers it. */
export type AppRequest = AppTell | AppAsk;

/**
 * A currency as Siren's API describes one (`CurrencyAdapter::toArray()`),
 * the shape `programs.currencyTypes()` lists, with every field present. A
 * stored amount is the shown amount times `10^scale`. `decimalPlaces` is how
 * many digits a person sees, never more than `scale`. Read an amount with
 * `apps.shownAmount(value, currency)`.
 */
export interface AppCurrency extends ProgramCurrency {
  /** The currency code, such as `USD`, or the code of an organization's own currency, such as `POINTS`. */
  id: string;
  symbol: string;
  position: 'before' | 'after' | (string & {});
  name: string;
  /** Digits of a stored amount that sit after the decimal point, 0 to 8. Every built-in currency is 2, yen included. */
  scale: number;
  /** Digits a person sees after the decimal point, 0 to `scale`. Yen shows 0. */
  decimalPlaces: number;
  /** `monetary` for money, `internal` for points or store credit an organization defined. */
  type: CustomCurrencyType | (string & {});
}

/**
 * The data of a `postConversionAction` tell, sent after a conversion is
 * approved (Siren's `AppActionSubjects::forConversion()`).
 */
export interface AppConversionApprovedData {
  conversion: {
    id: number;
    type: string;
    status: string;
    engagementId: number;
    opportunityId: number;
    collaboratorId: number;
    transactionId: number | null;
    obligationId: number | null;
  };
  /**
   * The reward, or null when the conversion has none. `value` is the stored
   * integer, not the amount a person reads: 10000 in yen is 100 yen. Read it
   * with `apps.shownAmount(reward.value, reward.currency)`. `units` is the
   * currency code.
   */
  reward: { value: number; units: string; currency: AppCurrency } | null;
  program: { id: number; name: string };
}

/**
 * The data of a `postAllocationAction` tell, sent after an allocation
 * completes (Siren's `AppActionSubjects::forAllocation()`). The subject id is
 * `{distributionId}:{obligationId}`.
 */
export interface AppAllocationCompletedData {
  allocation: {
    distributionId: number;
    obligationId: number;
    collaboratorId: number;
    status: string;
    /** The stored integer, not the amount a person reads. Read it with `apps.shownAmount(value, currency)`. */
    value: number;
    /** The currency code. */
    units: string;
    currency: AppCurrency;
  };
  distributor: { id: number; name: string };
}

/**
 * A stored amount as a person reads it, from `apps.shownAmount()`, the three
 * ways Siren's own `CurrencyAmountService` gives one.
 */
export interface ShownAmount {
  /** `value / 10^scale` as a number, for arithmetic: 15 for 1500 in dollars, 100 for 10000 in yen. */
  amount: number;
  /** Plain text with the currency's decimal places, no symbol and no grouping: `15.00`, `100`. */
  decimal: string;
  /** The text a person reads: `$15.00`, `¥100`, `10,000 pts`. */
  text: string;
}

/** Options for `apps.verifyRequest()`. */
export interface VerifyAppRequestOptions {
  /** How far the signed timestamp may be from `now`, either way. Whole seconds from 1 to 3600. Default 300. */
  toleranceSeconds?: number;
  /** The receiver's clock in Unix seconds. Default `Date.now() / 1000`. Tests pass a fixed clock. */
  now?: number;
}
