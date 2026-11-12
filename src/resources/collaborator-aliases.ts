import type { HttpTransport } from '../http';
import type {
  Collaborator,
  CollaboratorAlias,
  CollaboratorAliasEntry,
  CollaboratorAliasQueryParams,
  DeletedResult,
} from '../record-types';
import { CodeConflictError, ConflictError, SirenError, UnexpectedResponseError } from '../errors';
import { PropertyQualifier } from '../property-qualifier';
import type { SirenList } from '../types';
import { deleteRecord, isJsonObject, listRecords, readObject, recordId, writeRecord } from './record-requests';

/** The newest row first, one row: how {@link CollaboratorAliasesResource.findByCode} and `forCollaborator` read. */
const NEWEST = { number: 1, orderBy: 'dateIssued', order: 'DESC' } as const;

/**
 * Returns `code` trimmed. Throws `SirenError` naming `method` before
 * anything is sent when `code` is not a string, is empty once trimmed, or
 * holds a comma, which Siren reads as "any of" in a filter.
 *
 * @internal
 */
export function aliasCode(code: unknown, method: string): string {
  if (typeof code !== 'string') {
    throw new SirenError(`${method} needs each code as a string.`);
  }
  const trimmed = code.trim();
  if (trimmed === '') {
    throw new SirenError(`${method} needs a code that is not empty once trimmed.`);
  }
  if (trimmed.includes(',')) {
    throw new SirenError(`${method} cannot send a code that holds a comma, which Siren reads as "any of".`);
  }
  return trimmed;
}

/**
 * A code row with its plain type and `propertyId`, through
 * `PropertyQualifier.plainRecord(row, 'type')`. Throws
 * `UnexpectedResponseError` with the row as `data` when its `type` is not a
 * string, so a broken row never reads as a holder.
 *
 * @internal
 */
export function plainAlias(row: Record<string, unknown>): CollaboratorAlias {
  if (typeof row.type !== 'string') {
    throw new UnexpectedResponseError('Siren answered a code row whose type is not a string.', { data: row });
  }
  return PropertyQualifier.plainRecord(row, 'type') as CollaboratorAlias;
}

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
  async list(collaboratorId: number): Promise<CollaboratorAliasEntry[]> {
    const id = recordId(collaboratorId, 'list', 'collaboratorId');
    const record = await readObject<{ aliases: CollaboratorAliasEntry[] }>(
      this.http,
      `/collaborators/${id}`,
      { fields: 'id,aliases' },
      (body) =>
        Array.isArray(body.aliases) && body.aliases.every(isJsonObject)
          ? undefined
          : `Siren answered collaborator ${id} without an aliases list of objects.`,
    );
    return record.aliases;
  }

  /**
   * The collaborator's current tracking code, read with `GET
   * /collaborators/{id}?fields=id,referralCode`, or `null` when they have
   * none (`referralCode` is `null` or empty). A missing `referralCode`, or
   * one that is neither a string nor `null`, throws
   * `UnexpectedResponseError` with the status Siren sent and a message
   * naming `referralCode` and the collaborator id.
   */
  async trackingCode(collaboratorId: number): Promise<string | null> {
    const id = recordId(collaboratorId, 'trackingCode', 'collaboratorId');
    const record = await readObject<{ referralCode: string | null }>(
      this.http,
      `/collaborators/${id}`,
      { fields: 'id,referralCode' },
      (body) =>
        typeof body.referralCode === 'string' || body.referralCode === null
          ? undefined
          : `Siren answered collaborator ${id} without a referralCode that is a string or null.`,
    );
    return record.referralCode === '' ? null : record.referralCode;
  }

  /**
   * Gives the collaborator a new tracking code with `PUT /collaborators/{id}`
   * and body `{ trackingId }` (the code trimmed), sent once, and answers the
   * updated collaborator. Throws `SirenError` before sending for a code that
   * is empty once trimmed or holds a comma.
   * Siren refuses a code another collaborator holds with a 400, raised as
   * `BadRequestError`, and refuses `trackingId` from a connected site with a
   * 403. Sending it again after a lost answer is safe, since Siren refuses a
   * code only when another collaborator holds it.
   */
  async setTrackingCode(collaboratorId: number, code: string): Promise<Collaborator> {
    const id = recordId(collaboratorId, 'setTrackingCode', 'collaboratorId');
    const trackingId = aliasCode(code, 'setTrackingCode');
    return writeRecord<Collaborator>(this.http, 'PUT', `/collaborators/${id}`, { trackingId });
  }

  /**
   * Who holds a code: the newest alias with this code and plain type, or
   * `null` when nobody does. Reads `GET /collaborator-aliases` with `code`,
   * `type`, `number: 1`, `orderBy: 'dateIssued'` and `order: 'DESC'`, so the
   * one row Siren answers is the newest. A list answer of the wrong shape,
   * or a row whose `type` is not a string, throws `UnexpectedResponseError`,
   * never `null` or a holder read from a broken row.
   */
  async findByCode(code: string, type: string): Promise<CollaboratorAlias | null> {
    const trimmed = aliasCode(code, 'findByCode');
    const plainType = PropertyQualifier.assertCodeType(type, 'type');
    const rows = await this.query({ code: trimmed, type: plainType, ...NEWEST });
    return rows[0] ?? null;
  }

  /**
   * A collaborator's newest code of one plain type, such as their tracking
   * code, or `null` when they have none. Reads `GET /collaborator-aliases`
   * with `collaboratorId`, `type`, `number: 1`, `orderBy: 'dateIssued'` and
   * `order: 'DESC'`.
   */
  async forCollaborator(collaboratorId: number, type: string): Promise<CollaboratorAlias | null> {
    const id = recordId(collaboratorId, 'forCollaborator', 'collaboratorId');
    const plainType = PropertyQualifier.assertCodeType(type, 'type');
    const rows = await this.query({ collaboratorId: id, type: plainType, ...NEWEST });
    return rows[0] ?? null;
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
  async query(params: CollaboratorAliasQueryParams = {}): Promise<SirenList<CollaboratorAlias>> {
    const sent: Record<string, unknown> = { ...params };
    const { code, type } = params as { code?: unknown; type?: unknown };
    if (code !== undefined) {
      sent.code = Array.isArray(code) ? code.map((member: unknown) => aliasCode(member, 'query')) : aliasCode(code, 'query');
    }
    if (type !== undefined) {
      sent.type = Array.isArray(type)
        ? type.map((member: unknown) => PropertyQualifier.assertCodeType(member, 'type'))
        : PropertyQualifier.assertCodeType(type, 'type');
    }

    const rows = await listRecords<Record<string, unknown>>(
      this.http,
      CollaboratorAliasesResource.PATH,
      sent,
      CollaboratorAliasesResource.QUERY_FILTERS,
      CollaboratorAliasesResource.ID_FILTERS,
    );
    const plain = rows.map(plainAlias) as SirenList<CollaboratorAlias>;
    if (rows.estimatedCount !== undefined) {
      Object.defineProperty(plain, 'estimatedCount', {
        value: rows.estimatedCount,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return plain;
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
  async create(code: string, type: string, collaboratorId: number): Promise<CollaboratorAlias> {
    const trimmed = aliasCode(code, 'create');
    const plainType = PropertyQualifier.assertCodeType(type, 'type');
    const id = recordId(collaboratorId, 'create', 'collaboratorId');
    let row: Record<string, unknown>;
    try {
      row = await writeRecord<Record<string, unknown>>(this.http, 'POST', CollaboratorAliasesResource.PATH, {
        code: trimmed,
        type: plainType,
        collaboratorId: id,
      });
    } catch (error) {
      if (error instanceof ConflictError && !(error instanceof CodeConflictError)) {
        throw CodeConflictError.fromConflict(error, trimmed, plainType);
      }
      throw error;
    }
    return plainAlias(row);
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
  async free(code: string, type: string): Promise<DeletedResult> {
    const trimmed = aliasCode(code, 'free');
    const plainType = PropertyQualifier.assertCodeType(type, 'type');
    await deleteRecord(this.http, CollaboratorAliasesResource.PATH, { code: trimmed, type: plainType });
    return { deleted: true };
  }
}
