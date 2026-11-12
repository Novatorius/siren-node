import type { HttpTransport } from '../http';
import type {
  Collaborator,
  CollaboratorAlias,
  CollaboratorAliasEntry,
  CollaboratorAliasQueryParams,
  DeletedResult,
} from '../record-types';
import type { SirenList } from '../types';

/** The plain code types Siren gives out. A credit coupon's type is `credit_coupon_{CURRENCY}`. */
export const CollaboratorAliasType = {
  Tracking: 'tracking',
  Coupon: 'coupon',
} as const;

/** Union of the {@link CollaboratorAliasType} strings. */
export type CollaboratorAliasType = (typeof CollaboratorAliasType)[keyof typeof CollaboratorAliasType];

/**
 * A collaborator's aliases: the tracking codes and coupon codes that
 * attribute a visit or a sale to them.
 *
 * Codes live on `/collaborator-aliases`, which a connected site's token may
 * use. {@link findByCode}, {@link forCollaborator} and {@link query} read it,
 * {@link create} gives out a code and {@link free} takes one back.
 *
 * Send the plain type. Siren Cloud files a connected site's codes under the
 * site's Property (`coupon@property:5`), and every read matches the plain
 * type in every namespace, so this resource answers each code with the plain
 * type and the Property in `propertyId` (`null` for a code in no site's
 * namespace), through `PropertyQualifier.plainRecord`. A code has one holder
 * per type across all namespaces.
 *
 * Every method that takes a type throws `SirenError` before sending when it
 * is not letters, digits, underscores and hyphens
 * (`PropertyQualifier.assertName`), a list member of `query({ type })`
 * included. Every method that takes a code trims it and throws `SirenError`
 * before sending when nothing is left. Every id must be a positive whole
 * number. Reads retry. {@link create}, {@link free} and
 * {@link setTrackingCode} are sent once.
 *
 * {@link list}, {@link trackingCode} and {@link setTrackingCode} read and
 * write the collaborator record's own `aliases`, `referralCode` and
 * `trackingId` fields instead, which a connected site's token cannot.
 */
export class CollaboratorAliasesResource {
  /** The route codes live on. */
  static readonly PATH = '/collaborator-aliases';

  constructor(private readonly http: HttpTransport) {}

  /**
   * A collaborator's aliases, each `{ code, type, issuedDate }`, read with
   * `GET /collaborators/{id}?fields=id,aliases`. Answers an empty array when
   * the record has no `aliases` list, and skips any entry that is not an
   * object.
   */
  list(collaboratorId: number): Promise<CollaboratorAliasEntry[]> {
    // Stub: slice 3 packet P4
    void collaboratorId;
    void this.http;
    return Promise.resolve([]);
  }

  /**
   * The collaborator's current tracking code, read with `GET
   * /collaborators/{id}?fields=id,referralCode`, or `null` when they have
   * none (a missing, empty or non-string `referralCode`).
   */
  trackingCode(collaboratorId: number): Promise<string | null> {
    // Stub: slice 3 packet P4
    void collaboratorId;
    return Promise.resolve(null);
  }

  /**
   * Gives the collaborator a new tracking code with `PUT /collaborators/{id}`
   * and body `{ trackingId }` (the code trimmed), sent once, and answers the
   * updated collaborator. Throws `SirenError` before sending for a code that
   * is empty once trimmed.
   * Siren refuses a code another collaborator holds with a 400, raised as
   * `BadRequestError`, and refuses `trackingId` from a connected site with a
   * 403.
   */
  setTrackingCode(collaboratorId: number, code: string): Promise<Collaborator> {
    // Stub: slice 3 packet P4
    void collaboratorId;
    void code;
    return Promise.resolve({ id: 1 });
  }

  /**
   * Who holds a code: the newest alias with this code and plain type, or
   * `null` when nobody does. Reads `GET /collaborator-aliases` with `code`,
   * `type`, `number: 1`, `orderBy: 'dateIssued'` and `order: 'DESC'`, so the
   * one row Siren answers is the newest.
   */
  findByCode(code: string, type: string): Promise<CollaboratorAlias | null> {
    // Stub: slice 3 packet P4
    void code;
    void type;
    return Promise.resolve(null);
  }

  /**
   * A collaborator's newest code of one plain type, such as their tracking
   * code, or `null` when they have none. Reads `GET /collaborator-aliases`
   * with `collaboratorId`, `type`, `number: 1`, `orderBy: 'dateIssued'` and
   * `order: 'DESC'`.
   */
  forCollaborator(collaboratorId: number, type: string): Promise<CollaboratorAlias | null> {
    // Stub: slice 3 packet P4
    void collaboratorId;
    void type;
    return Promise.resolve(null);
  }

  /**
   * Lists codes with `GET /collaborator-aliases`. Filters, each an exact
   * match: `code`, `type` (plain, matched in every namespace) and
   * `collaboratorId`. A list value matches any of its values, but a
   * connected site may send only one type. Sort with `orderBy` and `order`.
   * Newest first by default. Each record comes back through
   * `PropertyQualifier.plainRecord(record, 'type')`.
   */
  query(params: CollaboratorAliasQueryParams = {}): Promise<SirenList<CollaboratorAlias>> {
    // Stub: slice 3 packet P4
    void params;
    return Promise.resolve([] as unknown as SirenList<CollaboratorAlias>);
  }

  /**
   * Gives a collaborator a code with `POST /collaborator-aliases` and body
   * `{ code, type, collaboratorId }`, sent once, and answers the new alias
   * with the plain type and `propertyId`.
   *
   * Throws `CodeConflictError`, built with `CodeConflictError.fromConflict`
   * from the 409 `ConflictError` Siren answers, with the trimmed code and
   * the type that were sent, when someone already holds the code under this
   * type, in any namespace (A106).
   */
  create(code: string, type: string, collaboratorId: number): Promise<CollaboratorAlias> {
    // Stub: slice 3 packet P4
    void code;
    void type;
    void collaboratorId;
    return Promise.resolve({ code: '', type: '', collaboratorId: 1 });
  }

  /**
   * Frees one code of one plain type with `DELETE
   * /collaborator-aliases?code=...&type=...` and no body, sent once, as a
   * coupon panel does when a coupon is renamed, reassigned or deleted. A
   * connected site frees only codes in its own namespace. Freeing a code
   * nobody holds is not an error. Answers `{ deleted: true }`.
   */
  free(code: string, type: string): Promise<DeletedResult> {
    // Stub: slice 3 packet P4
    void code;
    void type;
    return Promise.resolve({ deleted: false });
  }
}
