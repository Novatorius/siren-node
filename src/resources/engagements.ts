import { SirenError } from '../errors';
import type { HttpTransport } from '../http';
import type { Engagement, EngagementListParams, RegistryOptions } from '../record-types';
import type { SirenList } from '../types';
import { listRecords, readObject } from './record-requests';
import { RecordsResource, retrieveRecord } from './records';
import type { RetrieveParams } from './records';

/**
 * True for a string that is exactly YYYY-MM-DD and names a real calendar
 * day, the rule Cloud's `DayRangeFilterMiddleware` reads `from` and `to` by.
 * The day is rebuilt with `setUTCFullYear`, which reads every year as given,
 * where `Date.UTC` would read years 0 to 99 as 1900 to 1999.
 */
export function isDay(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Engagements (`/engagements`): a collaborator's claim on an opportunity in
 * one program. Siren creates them while it processes events, so this
 * resource only reads.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`. Every
 * id must be a positive whole number, or `SirenError` is thrown before
 * sending.
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
   * (days, `YYYY-MM-DD`, by `dateCreated`, both days included). Sort with
   * `orderBy` (`id`, `opportunityId`, `programId`, `collaboratorId`, `score`,
   * `status`, `source`, `dateCreated`, `dateModified`) and `order`. Sends
   * through `listRecords` with {@link LIST_FILTERS} and {@link ID_FILTERS}.
   *
   * Siren leaves out a `from` or `to` that is not a day it can read, and
   * answers every engagement as if no bound were sent
   * (`DayRangeFilterMiddleware.php`). So a `from` or `to` that is given and
   * is not a string of exactly four digits, a hyphen, two digits, a hyphen
   * and two digits naming a real calendar day, such as `2026-11-12` or
   * `2024-02-29`, throws `SirenError` before sending, with exactly
   * `engagements.list() needs {key} as a day, YYYY-MM-DD, and got {value}.`
   * `{value}` is a string in JSON quotes and anything else through
   * `String()`. `undefined` counts as not given.
   */
  override async list(params: EngagementListParams = {}): Promise<SirenList<T>> {
    for (const key of ['from', 'to'] as const) {
      const value: unknown = (params as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (!isDay(value)) {
        const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
        throw new SirenError(`engagements.list() needs ${key} as a day, YYYY-MM-DD, and got ${shown}.`);
      }
    }
    return listRecords<T>(this.http, this.path, params, EngagementsResource.LIST_FILTERS, EngagementsResource.ID_FILTERS);
  }

  /**
   * Reads one engagement with `GET /engagements/{id}` through
   * `retrieveRecord`. Throws `NotFoundError` for an unknown id, and
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }

  /**
   * The engagement types Siren knows, `{ options: [{ id, name, description }] }`,
   * from `GET /engagements/types`, such as `referredSiteVisit` and `manual`.
   * Throws `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  types(): Promise<RegistryOptions> {
    return readObject<RegistryOptions>(this.http, `${this.path}/types`);
  }

  /**
   * The calculations a program can apply to an engagement type,
   * `{ options: [{ id, name, description, requiredArgs }] }`, from
   * `GET /engagements/calculations`, such as `fixed`. Throws
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  calculations(): Promise<RegistryOptions> {
    return readObject<RegistryOptions>(this.http, `${this.path}/calculations`);
  }
}
