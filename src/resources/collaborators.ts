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
import { CollaboratorBulkAction } from '../taxonomy';
import { CollaboratorAliasesResource } from './collaborator-aliases';
import { ProgramEnrollmentsResource } from './program-enrollments';
import { RecordsResource } from './records';
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
 * A dashboard session's token reaches every method. A connected site's
 * token reads with `connect:records:read` and writes only through
 * {@link createPending}, {@link updateDetails}, `aliases.create`,
 * `aliases.free`, `enrollments.add` and `enrollments.remove`, with
 * `connect:records:write`.
 */
export class CollaboratorsResource<T = Collaborator> extends RecordsResource<T> {
  /** The filters `GET /collaborators` reads. {@link list} refuses any other key. */
  static readonly LIST_FILTERS = ['id', 'status', 'fullName', 'nickname', 'email', 's', 'programId', 'distributorId'] as const;

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
   * it and answer every collaborator. Answers as every record list does: an
   * array with Siren's `total` as `estimatedCount`. A 2xx that is not a list
   * throws `UnexpectedResponseError`, never an empty page.
   */
  override list(params: CollaboratorListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 3 packet P3
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
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
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 3 packet P3
    void id;
    void params;
    return Promise.resolve({} as T);
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
  create(params: CreateCollaboratorParams): Promise<T> {
    // Stub: slice 3 packet P3
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Creates a collaborator the way a connected site must: `POST
   * /collaborators` with `status: 'pending'`, so the organization approves
   * them, and no `programs`, `distributors` or `groups`. Enroll them
   * afterwards with `enrollments.add()`.
   *
   * Throws `SirenError` before sending when `params` holds a binding field
   * (whatever its value, an empty list or `undefined` included) or `status`,
   * as the PHP SDK refuses them, with exactly `createPending cannot send
   * "{field}". Siren sets a pending collaborator's status, and a site
   * enrolls them with enrollments.add() afterwards.`
   *
   * After a lost answer, sending it again is safe: for a held record Siren
   * answers the one it already holds and does not email the person twice.
   *
   * When the organization already has a collaborator with that email and
   * this site does not, Siren answers 201 with a held record for this site:
   * its own id, status `pending`, no tracking code, and an email to the
   * person to confirm. Once they confirm, Siren merges it into their
   * collaborator and deletes it, so look them up again by email after that.
   */
  createPending(params: CreatePendingCollaboratorParams): Promise<T> {
    // Stub: slice 3 packet P3
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Updates a collaborator with `PUT /collaborators/{id}`, sent once, and
   * answers the record Siren reads back after the write. Send only the
   * fields to change. A binding list that is sent replaces the whole set.
   * `fields` is the custom-field map, and the answer carries it back when it
   * is sent.
   */
  update(id: number, params: UpdateCollaboratorParams): Promise<T> {
    // Stub: slice 3 packet P3
    void id;
    void params;
    return Promise.resolve({} as T);
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
   * site changes only fullName and nickname.`
   */
  updateDetails(id: number, params: UpdateCollaboratorDetailsParams): Promise<T> {
    // Stub: slice 3 packet P3
    void id;
    void params;
    return Promise.resolve({} as T);
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
   * good.
   */
  delete(id: number): Promise<T | null> {
    // Stub: slice 3 packet P3
    void id;
    return Promise.resolve(null);
  }

  /**
   * Runs a bulk action with `POST /collaborators/bulk`, sent once.
   * `addToProgram` and `removeFromProgram` need `{ programId }` in `extra`,
   * and the distributor actions need `{ distributorId }`. Takes 1 to 500
   * ids. `extra.programId` and `extra.distributorId`, when present, must be
   * positive whole numbers, or `SirenError` is thrown before sending, since
   * Siren casts them to whole numbers.
   *
   * Siren skips ids it cannot find or fails to change and still answers 200,
   * so an `affected` count lower than the number of ids sent means some
   * were skipped. `sendSignupEmail` answers 502 when some emails could not
   * be sent, raised as `ApiError` with `code` `signup_email_failed` and the
   * `sent` and `failed` counts in `data`. Do not resend the whole batch after it,
   * since the `sent` ones already went out.
   */
  bulk(
    action: CollaboratorBulkAction,
    ids: readonly number[],
    extra: Record<string, unknown> = {},
  ): Promise<BulkResult> {
    // Stub: slice 3 packet P3
    void action;
    void ids;
    void extra;
    return Promise.resolve({});
  }

  /**
   * The collaborator statuses Siren accepts, `{ options, tones }`, from `GET
   * /collaborators/status-types`. Throws `UnexpectedResponseError` when a
   * 2xx body is not a JSON object.
   */
  statusTypes(): Promise<StatusTypes> {
    // Stub: slice 3 packet P3
    return Promise.resolve({ options: {} });
  }

  /**
   * An unused tracking code to offer a new collaborator, `{ code }`, from
   * `GET /collaborators/generate-referral-code`. Throws
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  generateReferralCode(): Promise<GeneratedReferralCode> {
    // Stub: slice 3 packet P3
    return Promise.resolve({ code: '' });
  }
}
