import type { HttpTransport } from '../http';
import type { SharedSetting } from '../record-types';

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
 * Every read retries. A connected site's token reads with
 * `connect:records:read`. Every name must be a non-empty string with no
 * comma, or `SirenError` is thrown before sending.
 */
export class SettingsResource {
  /** The route shared settings live on. */
  static readonly PATH = '/configs';
  /** The type of the collaborator settings. */
  static readonly TYPE_COLLABORATOR = 'collaborator';
  /** The filters the reads send. */
  static readonly FILTERS = ['type', 'subtype', 'configKey'] as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * The shared collaborator settings, each row `{ type, subtype, configKey,
   * value }`, read with `GET /configs?type=collaborator&number=200` through
   * `listRecords`. A 2xx that is not a list throws `UnexpectedResponseError`.
   */
  collaborator(): Promise<SharedSetting[]> {
    // Stub: slice 4 packet P7
    void this.http;
    return Promise.resolve([]);
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
  value(type: string, subtype: string, configKey: string): Promise<unknown> {
    // Stub: slice 4 packet P7
    void type;
    void subtype;
    void configKey;
    return Promise.resolve(null);
  }
}
