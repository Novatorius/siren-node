import { SirenError } from '../errors';
import type { HttpTransport } from '../http';
import type { SharedSetting } from '../record-types';
import { listRecords } from './record-requests';

/**
 * The organization settings Siren shares with a connected site
 * (`GET /configs`).
 *
 * Siren shares only the settings it names, each by type, subtype and key.
 * Today that is the referral link's query parameter, `collaborator` /
 * `urlReference` / `key`, which a site reads to spot a referral and to build
 * referral links. Any other type answers 400, raised as `BadRequestError`,
 * and a setting Siren does not share is never in the answer.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`. A
 * connected site's token reads with `connect:records:read`. Every name must
 * be a non-empty string with no comma, or the method throws `SirenError`
 * before sending.
 */
export class SettingsResource {
  /** The route shared settings live on. */
  static readonly PATH = '/configs';
  /** The type of the collaborator settings. */
  static readonly TYPE_COLLABORATOR = 'collaborator';
  /**
   * The filters {@link collaborator} and {@link value} send. The class has
   * no `list`, so the name drops the `LIST_` prefix.
   */
  static readonly FILTERS = ['type', 'subtype', 'configKey'] as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * The shared collaborator settings, each row `{ type, subtype, configKey,
   * value }`, read with `GET /configs?type=collaborator&number=200` through
   * `listRecords`. Siren shares one collaborator setting today, far below
   * the 200 a page holds. A 2xx that is not a list throws
   * `UnexpectedResponseError`.
   */
  collaborator(): Promise<SharedSetting[]> {
    const query = { type: SettingsResource.TYPE_COLLABORATOR, number: 200 };
    return listRecords<SharedSetting>(this.http, SettingsResource.PATH, query, SettingsResource.FILTERS);
  }

  /**
   * One shared setting's value, or `null` when Siren shares none, such as
   * `value('collaborator', 'urlReference', 'key')` for the referral link's
   * query parameter. Reads `GET /configs` with all three names and
   * `number: 1`, and answers the first row's `value`, `null` when the row
   * has none.
   *
   * Throws `SirenError` before sending when a name is empty, not a string,
   * or holds a comma (Siren reads a comma as "any of"), with exactly `A
   * setting {field} must be a name with no comma.`
   */
  async value(type: string, subtype: string, configKey: string): Promise<unknown> {
    const names = { type, subtype, configKey };
    for (const [field, name] of Object.entries(names)) {
      if (typeof name !== 'string' || name === '' || name.includes(',')) {
        throw new SirenError(`A setting ${field} must be a name with no comma.`);
      }
    }
    const query = { ...names, number: 1 };
    const [row] = await listRecords<SharedSetting>(this.http, SettingsResource.PATH, query, SettingsResource.FILTERS);
    return row?.value ?? null;
  }
}
