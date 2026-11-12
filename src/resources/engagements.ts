import type { HttpTransport } from '../http';
import type { Engagement, EngagementListParams, RegistryOptions } from '../record-types';
import type { SirenList } from '../types';
import { RecordsResource } from './records';
import type { RetrieveParams } from './records';

/**
 * Engagements (`/engagements`): a collaborator's claim on an opportunity in
 * one program. Siren creates them while it processes events, so this
 * resource only reads.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 *
 * A connected site's token reads {@link list} and {@link retrieve} with
 * `connect:records:read`, limited to its own store. It cannot read
 * {@link types} or {@link calculations}.
 */
export class EngagementsResource<T = Engagement> extends RecordsResource<T> {
  /** The filters `GET /engagements` reads. {@link list} refuses any other key, `propertyId` included. */
  static readonly LIST_FILTERS = ['status', 'collaboratorId', 'programId', 'opportunityId', 'from', 'to'] as const;
  /** The id filters {@link list} checks. Siren matches each as a column, so each takes one positive whole number or a list of them. */
  static readonly ID_FILTERS = { many: ['collaboratorId', 'programId', 'opportunityId'] } as const;

  constructor(http: HttpTransport) {
    super(http, '/engagements');
  }

  /**
   * Lists one page of engagements with `GET /engagements`, newest first by
   * default. Filters: `status`, `collaboratorId`, `programId` and
   * `opportunityId` (exact match, a list means "any of"), and `from` and `to`
   * (days, `YYYY-MM-DD`, by `dateCreated`). Sort with `orderBy` (`id`,
   * `opportunityId`, `programId`, `collaboratorId`, `score`, `status`,
   * `source`, `dateCreated`, `dateModified`) and `order`. Sends through
   * `listRecords` with {@link LIST_FILTERS} and {@link ID_FILTERS}.
   */
  override list(params: EngagementListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 4 packet P2
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /**
   * Reads one engagement with `GET /engagements/{id}` through
   * `retrieveRecord`. Throws `NotFoundError` for an unknown id.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 4 packet P2
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * The engagement types Siren knows, `{ options: [{ id, name, description }] }`,
   * from `GET /engagements/types`, such as `referredSiteVisit` and `manual`.
   * Throws `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  types(): Promise<RegistryOptions> {
    // Stub: slice 4 packet P2
    return Promise.resolve({ options: [] });
  }

  /**
   * The calculations a program can apply to an engagement type,
   * `{ options: [{ id, name, description, requiredArgs }] }`, from
   * `GET /engagements/calculations`, such as `fixed`. Throws
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  calculations(): Promise<RegistryOptions> {
    // Stub: slice 4 packet P2
    return Promise.resolve({ options: [] });
  }
}
