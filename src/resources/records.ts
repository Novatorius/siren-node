import type { HttpClient } from '../http';
import type { ListParams, SirenList } from '../types';

/**
 * A thin paginated reader over one of Siren's ledger collections
 * (`/conversions`, `/transactions`, `/obligations`, `/payouts`). Used to
 * reconcile Siren's ledger against your own — deliberately not a full admin
 * client.
 */
export class RecordsResource<T = Record<string, unknown>> {
  constructor(
    private readonly http: HttpClient,
    private readonly path: string,
  ) {}

  /**
   * List records. `page`/`perPage` paginate (defaults: 1 / 25, max 100);
   * any additional params pass through as query-string filters.
   *
   * The response body is a bare JSON array; it is returned directly. When the
   * server sends an `x-siren-estimated-count` header, its value is attached as
   * `.estimatedCount` on the returned array.
   */
  async list(params: ListParams = {}): Promise<SirenList<T>> {
    const response = await this.http.request({
      method: 'GET',
      path: this.path,
      query: params,
      retriable: true,
    });

    const body = (await response.json().catch(() => undefined)) as unknown;
    const records: T[] = Array.isArray(body) ? (body as T[]) : [];
    const list = records as SirenList<T>;

    const countHeader = response.headers.get('x-siren-estimated-count');
    if (countHeader != null && countHeader !== '') {
      const count = Number(countHeader);
      if (Number.isFinite(count)) {
        // Non-enumerable so the value never leaks into JSON.stringify, spreads,
        // or deep-equality against a plain array of records.
        Object.defineProperty(list, 'estimatedCount', {
          value: count,
          enumerable: false,
          writable: true,
          configurable: true,
        });
      }
    }

    return list;
  }
}
