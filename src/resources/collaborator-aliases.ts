import type { HttpTransport } from '../http';
import type {
  Collaborator,
  CollaboratorAlias,
  CollaboratorAliasEntry,
  CollaboratorAliasQueryParams,
  DeletedResult,
} from '../record-types';
import type { SirenList } from '../types';

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
 * is neither letters, digits, underscores and hyphens nor one integration's
 * coupon type such as `coupon@source:wc` (`PropertyQualifier.assertCodeType`),
 * a list member of `query({ type })` included. Every method that takes a
 * code, `query({ code })` and its list members included, trims it and
 * throws `SirenError` before sending when nothing is left or it holds a
 * comma, since Siren reads a comma in a filter as "any of". Every id, a
 * `query({ collaboratorId })` and its list members included, must be a
 * positive whole number.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * {@link create}, {@link free} and {@link setTrackingCode} are sent once.
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 *
 * {@link list}, {@link trackingCode} and {@link setTrackingCode} read and
 * write the collaborator record's own `aliases`, `referralCode` and
 * `trackingId` fields instead, which a connected site's token cannot.
 */
export class CollaboratorAliasesResource {
  /** The route codes live on. */
  static readonly PATH = '/collaborator-aliases';

  /** The filters {@link query} sends. It refuses any other key. */
  static readonly QUERY_FILTERS = ['code', 'type', 'collaboratorId'] as const;
  /** The id filters its list reads, checked before sending: `collaboratorId` takes one id or a list, each a positive whole number. */
  static readonly ID_FILTERS = { many: ['collaboratorId'] } as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * A collaborator's aliases, each `{ code, type, issuedDate }`, read with
   * `GET /collaborators/{id}?fields=id,aliases`. Siren always sends the
   * field it was asked for, so a record with no `aliases` list, or with an
   * entry that is not an object, throws `UnexpectedResponseError` with the
   * status Siren sent and a message naming `aliases` and the collaborator id,
   * never an empty answer. It reads through `readObject` with a `check`.
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
   * none (`referralCode` is `null` or empty). A missing `referralCode`, or
   * one that is neither a string nor `null`, throws
   * `UnexpectedResponseError` with the status Siren sent and a message
   * naming `referralCode` and the collaborator id.
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
   * is empty once trimmed or holds a comma.
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
   * one row Siren answers is the newest. A list answer of the wrong shape,
   * or a row whose `type` is not a string, throws `UnexpectedResponseError`,
   * never `null` or a holder read from a broken row.
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
   * Newest first by default. Any key outside {@link QUERY_FILTERS} and the
   * paging and sorting keys throws `SirenError`. An empty `type` or `code`
   * list throws too. Each record comes back through
   * `PropertyQualifier.plainRecord(record, 'type')`, and the list keeps
   * `estimatedCount`. Sends through `listRecords` with {@link QUERY_FILTERS}
   * and {@link ID_FILTERS}. A 2xx that is not a list, or a row whose `type`
   * is not a string, throws `UnexpectedResponseError`.
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
   * type, in any namespace. Every other error passes through unchanged.
   *
   * Siren's 409 does not name the holder, and that holder may be this same
   * collaborator: a send whose answer was lost, sent again, meets the code
   * the first send placed. After a `ConnectionError`, a 5xx `ApiError` or a
   * `CodeConflictError`, call {@link findByCode} and compare its
   * `collaboratorId` before treating the code as someone else's.
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
   * nobody holds is not an error. Answers `{ deleted: true }`, which says
   * the request succeeded, not that a code was removed.
   *
   * Siren deletes only an exact type match. A dashboard session's token
   * sends the type as given, so it frees only codes in no site's namespace,
   * and cannot reach a site's `coupon@property:5`, which only that site's
   * own token frees. Sending it again after a lost answer is safe.
   */
  free(code: string, type: string): Promise<DeletedResult> {
    // Stub: slice 3 packet P4
    void code;
    void type;
    return Promise.resolve({ deleted: false });
  }
}
