import type { HttpTransport } from '../http';
import type {
  BulkResult,
  Collaborator,
  CollaboratorListParams,
  CreateCollaboratorParams,
  CreatePendingCollaboratorParams,
  GeneratedReferralCode,
  StatusTypes,
  UpdateCollaboratorDetailsParams,
  UpdateCollaboratorParams,
} from '../record-types';
import type { SirenList } from '../types';
import { SirenError } from '../errors';
import { CollaboratorBulkAction } from '../taxonomy';
import { CollaboratorAliasesResource } from './collaborator-aliases';
import { ProgramEnrollmentsResource } from './program-enrollments';
import { bulkRecords, deleteRecord, listRecords, readObject, recordId, writeRecord } from './record-requests';
import { RecordsResource, retrieveRecord } from './records';
import type { RetrieveParams } from './records';

/**
 * The fields that bind a collaborator to programs, distributors and groups.
 * Siren treats a list that is present as the whole new set, so a connected
 * site may not send any of them, an empty list included.
 */
export const COLLABORATOR_BINDING_FIELDS = ['programs', 'distributors', 'groups'] as const;

/**
 * The only fields `updateDetails()` sends: the ones a connected site may
 * change. Cloud's connector rule also lets a site send `fields`, but Cloud's
 * update route reads `fields` as the collaborator's custom-field map, so the
 * SDK leaves it out of the site path.
 */
export const SITE_UPDATABLE_COLLABORATOR_FIELDS = ['fullName', 'nickname'] as const;

/**
 * The only fields `createPending()` sends besides `status: 'pending'`: the
 * ones Cloud's create route reads that a connected site may set. The route
 * also reads `trackingId`, but files that code in Cloud's own namespace,
 * outside the site's, so a site gives out codes with `aliases.create()`.
 */
export const SITE_CREATABLE_COLLABORATOR_FIELDS = ['fullName', 'nickname', 'email'] as const;

/** The keys `createPending()` refuses: the bindings and `status`, which Siren sets. */
const PENDING_REFUSED_FIELDS: readonly string[] = [...COLLABORATOR_BINDING_FIELDS, 'status'];

/**
 * The one extra each bulk action takes, by action. An action missing here
 * takes none.
 */
const BULK_EXTRA: Readonly<Partial<Record<CollaboratorBulkAction, 'programId' | 'distributorId'>>> = {
  [CollaboratorBulkAction.AddToProgram]: 'programId',
  [CollaboratorBulkAction.RemoveFromProgram]: 'programId',
  [CollaboratorBulkAction.AddToDistributor]: 'distributorId',
  [CollaboratorBulkAction.RemoveFromDistributor]: 'distributorId',
};

/**
 * Collaborators (`/collaborators`): the affiliates, partners and referrers a
 * program pays. Tracking codes live on {@link aliases} and program
 * enrollment on {@link enrollments}.
 *
 * Reads retry on a network error, 429 or 5xx. A caller that runs these reads
 * from its own durable queue builds the client with `maxRetries: 0`, so the
 * queue alone owns redelivery. Every write and delete is sent once, whatever
 * the client's `maxRetries`, as in the PHP SDK. Every method
 * that takes an id throws `SirenError` before sending when it is not a
 * positive whole number.
 *
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 *
 * A dashboard session's token reaches every method. A connected site's
 * token reads with `connect:records:read` and writes only through
 * {@link createPending}, {@link updateDetails}, `aliases.create`,
 * `aliases.free`, `enrollments.add` and `enrollments.remove`, with
 * `connect:records:write`.
 */
export class CollaboratorsResource<T = Collaborator> extends RecordsResource<T> {
  /** The filters `GET /collaborators` reads. {@link list} refuses any other key. */
  static readonly LIST_FILTERS = ['id', 'status', 'fullName', 'nickname', 'email', 's', 'programId', 'distributorId'] as const;
  /** The id filters its list reads, checked before sending: `programId` and `distributorId` take one id, and `id` one id or a list, each a positive whole number. */
  static readonly ID_FILTERS = { one: ['programId', 'distributorId'], many: ['id'] } as const;

  /** A collaborator's tracking and coupon codes. */
  readonly aliases: CollaboratorAliasesResource;
  /** Which programs a collaborator is enrolled in. */
  readonly enrollments: ProgramEnrollmentsResource;

  constructor(http: HttpTransport) {
    super(http, '/collaborators');
    this.aliases = new CollaboratorAliasesResource(http);
    this.enrollments = new ProgramEnrollmentsResource(http);
  }

  /**
   * Lists one page of collaborators with `GET /collaborators`.
   *
   * Filters: `id`, `status`, `fullName`, `nickname`, `email` (exact match, a
   * list means "any of"), `s` (search across name, nickname, email and
   * tracking codes), `programId` and `distributorId`. Sort with `orderBy` and
   * `order`. `fields` picks the returned fields. Any other key, `propertyId`
   * included, throws `SirenError` before sending, since Siren would ignore
   * it and answer every collaborator, and so does an empty filter list.
   * `programId` and `distributorId` take one positive whole number, never a
   * list, since Siren casts them to one ({@link ID_FILTERS}). Answers as every record list does: an
   * array with Siren's `total` as `estimatedCount`. A 2xx that is not a list
   * throws `UnexpectedResponseError`, never an empty page.
   */
  override async list(params: CollaboratorListParams = {}): Promise<SirenList<T>> {
    return listRecords<T>(
      this.http,
      this.path,
      params,
      CollaboratorsResource.LIST_FILTERS,
      CollaboratorsResource.ID_FILTERS,
    );
  }

  /**
   * Reads one collaborator with `GET /collaborators/{id}`. `fields` chooses
   * the fields, such as `aliases`, `referralCode`, `programs`,
   * `distributors`, `creditBalances` or `groups`. A connected site may ask
   * only for `id`, `status`, `fullName`, `nickname`, `email` and the dates,
   * and Siren refuses a computed field from a site with a 403.
   *
   * Reads through `retrieveRecord`, as every resource with a retrieve does,
   * so it takes `fields`, `include` and `propertyId`. Throws `NotFoundError`
   * when Siren has no such collaborator, and `UnexpectedResponseError` when
   * a 2xx body is not a JSON object.
   */
  async retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }

  /**
   * Creates a collaborator with `POST /collaborators`, sent once, and
   * answers the created record. Siren answers 422 with `reserved_address`
   * when the email is one it keeps for its own records.
   *
   * After a lost answer, do not send it again: Siren refuses a second
   * collaborator with the same email. List with `{ email }` to find the one
   * the first send made.
   */
  async create(params: CreateCollaboratorParams): Promise<T> {
    return writeRecord<T>(this.http, 'POST', this.path, params);
  }

  /**
   * Creates a collaborator the way a connected site must: `POST
   * /collaborators` with `fullName`, `nickname`, `email` and `status:
   * 'pending'`, so the organization approves them. Enroll them afterwards
   * with `enrollments.add()`, and give out their codes with
   * `aliases.create()`.
   *
   * Throws `SirenError` before sending when `params` holds a binding field
   * (whatever its value, an empty list or `undefined` included) or `status`,
   * as the PHP SDK refuses them, with exactly `createPending cannot send
   * "{field}". Siren sets a pending collaborator's status, and a site
   * enrolls them with enrollments.add() afterwards.` Throws `SirenError`
   * before sending for any other key outside
   * {@link SITE_CREATABLE_COLLABORATOR_FIELDS}, whatever its value, with
   * exactly `createPending cannot send "{key}". A connected site sends only
   * fullName, nickname and email, and gives out codes with aliases.create().`
   * That covers `trackingId`, which Cloud would file outside the site's
   * namespace, and `id`, `propertyId` or any other key Cloud does not read.
   *
   * After a lost answer, what a resend does depends on the email. For
   * someone the organization already has, Siren answers the held record it
   * already made, and emails the person again only after a day or when the
   * first email failed. For someone new, the
   * first send already created the collaborator, so Siren refuses the resend
   * as a duplicate email with a 400. List with `{ email }` to find the
   * record before sending again.
   *
   * When the organization already has a collaborator with that email and
   * this site does not, Siren answers 201 with a held record for this site:
   * its own id, status `pending`, no tracking code, and an email to the
   * person to confirm. Once they confirm, Siren merges it into their
   * collaborator and deletes it, so look them up again by email after that.
   */
  async createPending(params: CreatePendingCollaboratorParams): Promise<T> {
    const allowed: readonly string[] = SITE_CREATABLE_COLLABORATOR_FIELDS;
    for (const key of Object.keys(params)) {
      if (PENDING_REFUSED_FIELDS.includes(key)) {
        throw new SirenError(
          `createPending cannot send "${key}". Siren sets a pending collaborator's status, and a site enrolls them with enrollments.add() afterwards.`,
        );
      }
      if (!allowed.includes(key)) {
        throw new SirenError(
          `createPending cannot send "${key}". A connected site sends only fullName, nickname and email, and gives out codes with aliases.create().`,
        );
      }
    }
    return writeRecord<T>(this.http, 'POST', this.path, { ...params, status: 'pending' });
  }

  /**
   * Updates a collaborator with `PUT /collaborators/{id}`, sent once, and
   * answers the record Siren reads back after the write. Send only the
   * fields to change. A binding list that is sent replaces the whole set.
   * `fields` is the custom-field map, and the answer carries it back when it
   * is sent. Sending it again after a lost answer sets the same values, so it is safe.
   */
  async update(id: number, params: UpdateCollaboratorParams): Promise<T> {
    return writeRecord<T>(this.http, 'PUT', `${this.path}/${recordId(id, 'update')}`, params);
  }

  /**
   * Updates a collaborator the way a connected site must: `PUT
   * /collaborators/{id}` with only `fullName` and `nickname`, sent once.
   * Siren refuses a status or email change from a connected site, because
   * Cloud claims accounts by email and approval stays with the
   * organization, and refuses the binding lists for the reason
   * {@link createPending} gives.
   *
   * Throws `SirenError` before sending when `params` holds any key outside
   * {@link SITE_UPDATABLE_COLLABORATOR_FIELDS}, whatever its value,
   * `undefined` included, and names the key in the message: a binding
   * field, `status`, `email`, `trackingId` (codes change through
   * `aliases.create()` and `aliases.free()`), `fields`, `id` or any other.
   * The message is exactly `updateDetails cannot send "{key}". A connected
   * site changes only fullName and nickname.` Sending it again after a lost answer sets the same values, so it is safe.
   */
  async updateDetails(id: number, params: UpdateCollaboratorDetailsParams): Promise<T> {
    const allowed: readonly string[] = SITE_UPDATABLE_COLLABORATOR_FIELDS;
    for (const key of Object.keys(params)) {
      if (!allowed.includes(key)) {
        throw new SirenError(`updateDetails cannot send "${key}". A connected site changes only fullName and nickname.`);
      }
    }
    return writeRecord<T>(this.http, 'PUT', `${this.path}/${recordId(id, 'updateDetails')}`, params);
  }

  /**
   * Deletes a collaborator with `DELETE /collaborators/{id}`, sent once. The
   * first call marks the record `deleted` and answers it. A second call on a
   * deleted record removes it for good and answers `null`. A collaborator
   * who is only `invited` is removed for good on the first call, which
   * answers `null`.
   *
   * After a lost answer, `retrieve` the record before sending again: a
   * second delete of a record the first one marked deleted removes it for
   * good. A record with status `deleted` means the first send worked, and
   * `NotFoundError` means the record is gone.
   */
  async delete(id: number): Promise<T | null> {
    return deleteRecord<T>(this.http, `${this.path}/${recordId(id, 'delete')}`);
  }

  /**
   * Runs a bulk action with `POST /collaborators/bulk`, sent once. Takes 1
   * to 500 ids. Each action takes only its own extra: `addToProgram` and
   * `removeFromProgram` need `{ programId }` in `extra`, the distributor
   * actions need `{ distributorId }`, and every other action takes none.
   * Before sending, `SirenError` names any other key in `extra`, a missing
   * one, and a `programId` or `distributorId` that is not a positive whole
   * number, since Cloud hands every parameter to the action and casts the
   * ids to whole numbers.
   *
   * Siren skips ids it cannot find or fails to change and still answers 200,
   * so an `affected` count lower than the number of ids sent means some
   * were skipped. `sendSignupEmail` answers 502 when some emails could not
   * be sent, raised as `ApiError` with `code` `signup_email_failed` and the
   * `sent` and `failed` counts in `data`. Do not resend the whole batch after it,
   * since the `sent` ones already went out. Siren keeps no record of a sent
   * signup email, so any resend of `sendSignupEmail`, after a lost answer
   * too, emails every id in it again. The status actions change nothing for
   * an id already in that status and send no second decision email, so a
   * resend of one is safe.
   */
  async bulk(
    action: CollaboratorBulkAction,
    ids: readonly number[],
    extra: Record<string, unknown> = {},
  ): Promise<BulkResult> {
    const needs = BULK_EXTRA[action];
    for (const key of Object.keys(extra)) {
      if (key !== needs) {
        throw new SirenError(`bulk ${action} cannot send "${key}". It takes ${needs === undefined ? 'no extra' : `only ${needs}`}.`);
      }
    }
    // A missing extra reaches recordId as undefined, which refuses it by name.
    if (needs !== undefined) recordId(extra[needs], 'bulk', needs);
    return bulkRecords<BulkResult>(this.http, this.path, action, ids, extra);
  }

  /**
   * The collaborator statuses Siren accepts, `{ options, tones }`, from `GET
   * /collaborators/status-types`. Throws `UnexpectedResponseError` when a
   * 2xx body is not a JSON object.
   */
  async statusTypes(): Promise<StatusTypes> {
    return readObject<StatusTypes>(this.http, `${this.path}/status-types`);
  }

  /**
   * An unused tracking code to offer a new collaborator, `{ code }`, from
   * `GET /collaborators/generate-referral-code`. Throws
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  async generateReferralCode(): Promise<GeneratedReferralCode> {
    return readObject<GeneratedReferralCode>(this.http, `${this.path}/generate-referral-code`);
  }
}
