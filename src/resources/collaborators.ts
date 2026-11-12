import type { HttpTransport } from '../http';
import type {
  BulkResult,
  Collaborator,
  CollaboratorListParams,
  CreateCollaboratorParams,
  CreatePendingCollaboratorParams,
  GeneratedReferralCode,
  RecordReadParams,
  StatusTypes,
  UpdateCollaboratorDetailsParams,
  UpdateCollaboratorParams,
} from '../record-types';
import type { SirenList } from '../types';
import { CollaboratorAliasesResource } from './collaborator-aliases';
import { ProgramEnrollmentsResource } from './program-enrollments';
import { RecordsResource } from './records';

/** The bulk actions `collaborators.bulk()` runs, as Siren names them. */
export const CollaboratorBulkAction = {
  Activate: 'activate',
  Deactivate: 'deactivate',
  Restore: 'restore',
  Delete: 'delete',
  PermanentDelete: 'permanent_delete',
  /** Needs `{ programId }` in `extra`. */
  AddToProgram: 'addToProgram',
  /** Needs `{ programId }` in `extra`. */
  RemoveFromProgram: 'removeFromProgram',
  /** Needs `{ distributorId }` in `extra`. */
  AddToDistributor: 'addToDistributor',
  /** Needs `{ distributorId }` in `extra`. */
  RemoveFromDistributor: 'removeFromDistributor',
  SendSignupEmail: 'sendSignupEmail',
} as const;

/** Union of the {@link CollaboratorBulkAction} strings. */
export type CollaboratorBulkAction = (typeof CollaboratorBulkAction)[keyof typeof CollaboratorBulkAction];

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
 * SDK leaves it out of the site path (see the slice 3 note).
 */
export const SITE_UPDATABLE_COLLABORATOR_FIELDS = ['fullName', 'nickname'] as const;

/**
 * Collaborators (`/collaborators`): the affiliates, partners and referrers a
 * program pays. Tracking codes live on {@link aliases} and program
 * enrollment on {@link enrollments}.
 *
 * Reads retry on a network error, 429 or 5xx. Every write and delete is sent
 * once, whatever the client's `maxRetries`, as in the PHP SDK. Every method
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
   * `order`. `fields` picks the returned fields. Answers as every record
   * list does: an array with Siren's `total` as `estimatedCount`.
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
   * Throws `NotFoundError` when Siren has no such collaborator, and
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  retrieve(id: number, params: RecordReadParams = {}): Promise<T> {
    // Stub: slice 3 packet P3
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Creates a collaborator with `POST /collaborators`, sent once, and
   * answers the created record. Siren answers 422 with `reserved_address`
   * when the email is one it keeps for its own records.
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
   * as the PHP SDK refuses them. The message names the field.
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
   * deleted record removes it for good and answers `null`.
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
   * ids.
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
