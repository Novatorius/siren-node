import { SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { PropertyQualifier } from '../property-qualifier';
import type { DeletedResult, Mapping, MappingListParams, MappingPageParams } from '../record-types';
import type { SirenList } from '../types';
import { deleteRecord, listRecords, recordId, writeRecord } from './record-requests';
import { RecordsResource } from './records';

/** Returns the external id trimmed. Throws `SirenError` before sending when it is not a string or nothing is left once trimmed. */
function externalIdOf(id: unknown): string {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (trimmed === '') throw new SirenError('Send externalId as a string that is not blank.');
  return trimmed;
}

/** The link as the caller sent it: the plain external type, with the Property beside it. */
function plainMapping(row: Mapping | Record<string, unknown>): Mapping {
  return PropertyQualifier.plainRecord(row as Record<string, unknown>, 'externalType') as unknown as Mapping;
}

/**
 * Mappings (`/mappings`): links between a Siren record and a record outside
 * Siren, such as a WordPress user and their collaborator, a product and the
 * collaborator it credits, or an order and its transaction.
 *
 * Every call names an external type, as Siren Cloud requires of a connected
 * site. Send the plain type, such as `wordpress_user` or `wc_product`. Cloud
 * files a connected site's links under the site's Property
 * (`wordpress_user@property:5`) and reads only that namespace, so two sites
 * in one organization never see or replace each other's links. This resource
 * answers every link through `PropertyQualifier.plainRecord`, with the plain
 * type and the Property in `propertyId` (`null` for a link in no site's
 * namespace).
 *
 * Cloud's own `user` type links a collaborator to a Cloud account. Cloud
 * refuses it from a connected site with 403 `user_type_not_allowed`, raised
 * as `PolicyError`, and refuses to write or delete it for every other caller
 * with a 403 too. The SDK sends the type it is given, so a WordPress host
 * translates its own `user` to {@link EXTERNAL_TYPE_WORDPRESS_USER} at its
 * boundary.
 *
 * Every type, `localType` included, must pass `PropertyQualifier.assertName`,
 * or `SirenError` is thrown before sending. Every external id is trimmed and
 * refused when nothing is left. Every local id must be a positive whole
 * number.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * {@link create}, {@link deleteForCollaborator} and {@link deleteForExternal}
 * are sent once, apart from the one resend after a 401 that every request
 * gets. A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 *
 * Only collaborator links can be written. Siren makes the order,
 * transaction and opportunity links as it processes events.
 */
export class MappingsResource extends RecordsResource<Mapping> {
  /** The Siren side of every link this resource writes. */
  static readonly LOCAL_TYPE_COLLABORATOR = 'collaborator';
  /** A WordPress user, as a connected site names it. */
  static readonly EXTERNAL_TYPE_WORDPRESS_USER = 'wordpress_user';
  /** The filters `GET /mappings` reads. {@link list} refuses any other key. */
  static readonly LIST_FILTERS = ['localId', 'localType', 'externalId', 'externalType'] as const;
  /** The id filters {@link list} checks. Siren matches `localId` as a column, so it takes one positive whole number or a list of them. */
  static readonly ID_FILTERS = { many: ['localId'] } as const;

  constructor(http: HttpTransport) {
    super(http, '/mappings');
  }

  /**
   * Lists links with `GET /mappings`, through `listRecords` with
   * {@link LIST_FILTERS} and {@link ID_FILTERS}.
   *
   * `externalType` is required and must be one plain type, or `SirenError`
   * is thrown before sending, so a query never lists every link of the
   * organization. `localType`, when present and not `undefined`, must be a
   * plain type too, and `localId` a positive whole number or a list of
   * them. Other filters, each an exact match: `externalId`. Sort with `orderBy` (`localId`,
   * `externalId`, `localType`, `externalType`) and `order`. Every row comes
   * back through `PropertyQualifier.plainRecord(row, 'externalType')`, and
   * the list keeps Siren's `estimatedCount`.
   */
  override async list(params: MappingListParams = {}): Promise<SirenList<Mapping>> {
    const query = { ...params, externalType: PropertyQualifier.assertName(params.externalType, 'externalType') };
    if (params.localType !== undefined) PropertyQualifier.assertName(params.localType, 'localType');
    const rows = await listRecords<Mapping>(this.http, this.path, query, MappingsResource.LIST_FILTERS, MappingsResource.ID_FILTERS);
    const plain = rows.map(plainMapping) as SirenList<Mapping>;
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
   * The links of one outside record, such as the collaborator a WordPress
   * user belongs to: {@link list} with `externalId` (trimmed),
   * `externalType` and, when given, `localType`, then the paging and
   * sorting in `params`. A `localType` of `undefined` is left out.
   */
  async forExternal(
    externalId: string,
    externalType: string,
    localType?: string,
    params: MappingPageParams = {},
  ): Promise<SirenList<Mapping>> {
    return this.list({ externalId: externalIdOf(externalId), externalType, localType, ...params });
  }

  /**
   * The links of one Siren record of one external type, such as the
   * WordPress user a collaborator belongs to: {@link list} with `localId`,
   * `localType` and `externalType`, then the paging and sorting in `params`.
   */
  async forLocal(localId: number, localType: string, externalType: string, params: MappingPageParams = {}): Promise<SirenList<Mapping>> {
    // list checks all three: localId through ID_FILTERS, and both types by name.
    return this.list({ localId, localType, externalType, ...params });
  }

  /**
   * Links a collaborator to an outside record with `POST /mappings`, body
   * `{ localId, localType: 'collaborator', externalId, externalType }` with
   * the external id trimmed, sent once. Answers the link through
   * `plainRecord`, status 201. A link that already exists answers 409
   * `mapping_exists`, raised as `ConflictError`: it is the link this call
   * asked for, so a caller whose first send lost its answer can treat it as
   * made.
   *
   * An external id that holds a comma is sent as given, as Siren stores it,
   * but {@link forExternal} and {@link list} refuse one, since Siren reads a
   * comma in a filter as "any of". Read such a link with {@link forLocal}.
   */
  async create(collaboratorId: number, externalId: string, externalType: string): Promise<Mapping> {
    const body = {
      localId: recordId(collaboratorId, 'mappings.create', 'collaboratorId'),
      localType: MappingsResource.LOCAL_TYPE_COLLABORATOR,
      externalId: externalIdOf(externalId),
      externalType: PropertyQualifier.assertName(externalType, 'externalType'),
    };
    return plainMapping(await writeRecord<Record<string, unknown>>(this.http, 'POST', this.path, body));
  }

  /**
   * Removes a collaborator's links of one external type with
   * `DELETE /mappings?localType=collaborator&localId=&externalType=`, sent
   * once, no body. Removing nothing is not an error, so a resend after a
   * lost answer is safe. Answers `{ deleted: true }`, and throws
   * `UnexpectedResponseError` when a 2xx carries no object.
   */
  async deleteForCollaborator(collaboratorId: number, externalType: string): Promise<DeletedResult> {
    return this.deleteLinks({
      localType: MappingsResource.LOCAL_TYPE_COLLABORATOR,
      localId: recordId(collaboratorId, 'mappings.deleteForCollaborator', 'collaboratorId'),
      externalType: PropertyQualifier.assertName(externalType, 'externalType'),
    });
  }

  /**
   * Removes every collaborator link of one outside record with
   * `DELETE /mappings?localType=collaborator&externalId=&externalType=`, the
   * external id trimmed, sent once, no body. Removing nothing is not an
   * error, so a resend after a lost answer is safe. Answers
   * `{ deleted: true }`, and throws `UnexpectedResponseError` when a 2xx
   * carries no object.
   */
  async deleteForExternal(externalId: string, externalType: string): Promise<DeletedResult> {
    return this.deleteLinks({
      localType: MappingsResource.LOCAL_TYPE_COLLABORATOR,
      externalId: externalIdOf(externalId),
      externalType: PropertyQualifier.assertName(externalType, 'externalType'),
    });
  }

  /** Sends `DELETE /mappings` with `query` and no body, once, and requires an object back. */
  private async deleteLinks(query: Record<string, string | number>): Promise<DeletedResult> {
    const answer = await deleteRecord<DeletedResult>(this.http, this.path, query);
    if (answer === null) {
      throw new UnexpectedResponseError(`Siren answered DELETE ${this.path} with no body.`, { statusCode: 204 });
    }
    return answer;
  }
}
