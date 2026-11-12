import type { HttpTransport } from '../http';
import type { DeletedResult, Mapping, MappingListParams, MappingPageParams } from '../record-types';
import type { SirenList } from '../types';
import { RecordsResource } from './records';

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
 * number. Reads retry, and {@link create}, {@link deleteForCollaborator} and
 * {@link deleteForExternal} are sent once. Only collaborator links can be
 * written. Siren makes the order, transaction and opportunity links as it
 * processes events.
 */
export class MappingsResource extends RecordsResource<Mapping> {
  /** The Siren side of every link this resource writes. */
  static readonly LOCAL_TYPE_COLLABORATOR = 'collaborator';
  /** A WordPress user, as a connected site names it. */
  static readonly EXTERNAL_TYPE_WORDPRESS_USER = 'wordpress_user';
  /** The filters `GET /mappings` reads. {@link list} refuses any other key. */
  static readonly LIST_FILTERS = ['localId', 'localType', 'externalId', 'externalType'] as const;

  constructor(http: HttpTransport) {
    super(http, '/mappings');
  }

  /**
   * Lists links with `GET /mappings`, through `listRecords` with
   * {@link LIST_FILTERS}.
   *
   * `externalType` is required and must be one plain type, or `SirenError`
   * is thrown before sending, so a query never lists every link of the
   * organization. `localType`, when present and not `undefined`, must be a
   * plain type too, and `localId` a positive whole number. Other filters,
   * each an exact match: `externalId`. Sort with `orderBy` (`localId`,
   * `externalId`, `localType`, `externalType`) and `order`. Every row comes
   * back through `PropertyQualifier.plainRecord(row, 'externalType')`, and
   * the list keeps Siren's `estimatedCount`.
   */
  override list(params: MappingListParams = {}): Promise<SirenList<Mapping>> {
    // Stub: slice 4 packet P6
    void params;
    return Promise.resolve([] as unknown as SirenList<Mapping>);
  }

  /**
   * The links of one outside record, such as the collaborator a WordPress
   * user belongs to: {@link list} with `externalId` (trimmed),
   * `externalType` and, when given, `localType`, then the paging and
   * sorting in `params`. A `localType` of `undefined` is left out.
   */
  forExternal(
    externalId: string,
    externalType: string,
    localType?: string,
    params: MappingPageParams = {},
  ): Promise<SirenList<Mapping>> {
    // Stub: slice 4 packet P6
    void externalId;
    void externalType;
    void localType;
    void params;
    return Promise.resolve([] as unknown as SirenList<Mapping>);
  }

  /**
   * The links of one Siren record of one external type, such as the
   * WordPress user a collaborator belongs to: {@link list} with `localId`,
   * `localType` and `externalType`, then the paging and sorting in `params`.
   */
  forLocal(localId: number, localType: string, externalType: string, params: MappingPageParams = {}): Promise<SirenList<Mapping>> {
    // Stub: slice 4 packet P6
    void localId;
    void localType;
    void externalType;
    void params;
    return Promise.resolve([] as unknown as SirenList<Mapping>);
  }

  /**
   * Links a collaborator to an outside record with `POST /mappings`, body
   * `{ localId, localType: 'collaborator', externalId, externalType }` with
   * the external id trimmed, sent once. Answers the link through
   * `plainRecord`, status 201. A link that already exists answers 409
   * `mapping_exists`, raised as `ConflictError`: it is the link this call
   * asked for, so a caller whose first send lost its answer can treat it as
   * made.
   */
  create(collaboratorId: number, externalId: string, externalType: string): Promise<Mapping> {
    // Stub: slice 4 packet P6
    void collaboratorId;
    void externalId;
    void externalType;
    return Promise.resolve({ localId: 1, localType: '', externalId: '', externalType: '' });
  }

  /**
   * Removes a collaborator's links of one external type with
   * `DELETE /mappings?localType=collaborator&localId=&externalType=`, sent
   * once, no body. Removing nothing is not an error. Answers
   * `{ deleted: true }`, and throws `UnexpectedResponseError` when a 2xx
   * carries no object.
   */
  deleteForCollaborator(collaboratorId: number, externalType: string): Promise<DeletedResult> {
    // Stub: slice 4 packet P6
    void collaboratorId;
    void externalType;
    return Promise.resolve({ deleted: false });
  }

  /**
   * Removes every collaborator link of one outside record with
   * `DELETE /mappings?localType=collaborator&externalId=&externalType=`, the
   * external id trimmed, sent once, no body. Removing nothing is not an
   * error. Answers `{ deleted: true }`, and throws `UnexpectedResponseError`
   * when a 2xx carries no object.
   */
  deleteForExternal(externalId: string, externalType: string): Promise<DeletedResult> {
    // Stub: slice 4 packet P6
    void externalId;
    void externalType;
    return Promise.resolve({ deleted: false });
  }
}
