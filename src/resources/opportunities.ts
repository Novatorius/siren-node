import type { HttpTransport } from '../http';
import type { Opportunity, OpportunityListParams, UpdateOpportunityParams } from '../record-types';
import type { SirenList } from '../types';
import { RecordsResource } from './records';
import type { RetrieveParams } from './records';

/**
 * Opportunities (`/opportunities`): a tracked visitor's chance to convert.
 *
 * Siren opens opportunities itself when it ingests a `site-visited` event,
 * so there is no create or delete call. The event's `EventResult` carries
 * the new opportunity's id.
 *
 * Reads retry. {@link update} is sent once. Every id must be a positive
 * whole number, or `SirenError` is thrown before sending. A connected site's
 * token reads with `connect:records:read` and must name the opportunity: by
 * id through {@link retrieve}, or by `collaboratorId` through {@link list}.
 * Without one Siren answers 403 `site_filter_required`. It cannot update.
 */
export class OpportunitiesResource<T = Opportunity> extends RecordsResource<T> {
  /**
   * The filters `GET /opportunities` reads. {@link list} refuses any other
   * key, `propertyId` and `id` included, since Siren ignores both on this
   * route and would answer every opportunity.
   */
  static readonly LIST_FILTERS = ['status', 'collaboratorId'] as const;

  constructor(http: HttpTransport) {
    super(http, '/opportunities');
  }

  /**
   * Lists one page of opportunities with `GET /opportunities`. Filters:
   * `status` (exact match, a list means "any of") and `collaboratorId` (the
   * opportunities a collaborator owns, a positive whole number). Sort with
   * `orderBy` (`id`, `status`, `lastTriggered`, `dateCreated`,
   * `dateModified`) and `order`. Sends through `listRecords` with
   * {@link LIST_FILTERS}: any other key throws `SirenError` before sending,
   * and a 2xx that is not a list throws `UnexpectedResponseError`.
   */
  override list(params: OpportunityListParams = {}): Promise<SirenList<T>> {
    // Stub: slice 4 packet P1
    void params;
    return Promise.resolve([] as unknown as SirenList<T>);
  }

  /**
   * Reads one opportunity with `GET /opportunities/{id}` through
   * `retrieveRecord`, so it takes `fields`, `include` and `propertyId`.
   * Throws `NotFoundError` for an unknown id or one a connected site does
   * not own.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    // Stub: slice 4 packet P1
    void id;
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Updates an opportunity with `PUT /opportunities/{id}`, sent once, and
   * answers the record as Siren stores it (`dateCreated` and `dateModified`
   * as `2026-10-16 12:00:00`). Accepts `status` (`active` or `inactive`) and
   * `lastTriggered`. Throws `NotFoundError` for an unknown id.
   */
  update(id: number, params: UpdateOpportunityParams): Promise<T> {
    // Stub: slice 4 packet P1
    void id;
    void params;
    return Promise.resolve({} as T);
  }
}
