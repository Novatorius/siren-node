import { SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { parseJsonBody } from '../http';
import type { ListParams, SirenList } from '../types';

/** The largest page Siren serves. Siren lowers a larger `number` to this. */
export const MAX_PAGE_SIZE = 200;

/** Siren's page size when a list request sends none. */
const DEFAULT_PAGE_SIZE = 10;

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Turns `page`/`perPage` into Siren's `number` (page size) and `offset`
 * (first row). Siren ignores `page` and `perPage`, so sending them as they
 * are returned the first ten rows every time. An explicit `number` or
 * `offset` wins over the page form. A page size above 200 is lowered to 200
 * before the offset is worked out, as Siren lowers it, so no rows are skipped
 * between pages.
 */
export function toListQuery(params: ListParams): Query {
  const { page, perPage, ...rest } = params;
  const query: Query = { ...rest };

  if (query.number === undefined && typeof perPage === 'number') {
    query.number = perPage;
  }
  if (typeof query.number === 'number' && query.number > MAX_PAGE_SIZE) {
    query.number = MAX_PAGE_SIZE;
  }
  if (query.offset === undefined && typeof page === 'number') {
    const size = typeof query.number === 'number' ? query.number : DEFAULT_PAGE_SIZE;
    query.number = size;
    query.offset = Math.max(0, (Math.floor(page) - 1) * size);
  }

  return query;
}

/**
 * A thin paginated reader over one of Siren's ledger collections
 * (`/conversions`, `/transactions`, `/obligations`, `/payouts`). Used to
 * reconcile Siren's ledger against your own — deliberately not a full admin
 * client.
 *
 * Takes an API key that holds the collection's ledger scope, such as
 * `ledger:conversions:read`, or a dashboard session's access token. A key
 * bound to one store reads only its own store's conversions, transactions
 * and obligations, and is refused on payouts with a `StoreKeyNotAllowedError`.
 *
 * The record resources that extend it (collaborators, collaborator groups,
 * programs and program groups) replace `list` with a stricter one that
 * refuses a key its route does not read, and their own docs govern.
 */
export class RecordsResource<T = Record<string, unknown>> {
  constructor(
    protected readonly http: HttpTransport,
    protected readonly path: string,
  ) {}

  /**
   * List one page of records. `page`/`perPage` paginate (Siren's default
   * page size is 10, the largest is 200). `propertyId` narrows an
   * organization-wide read to one store. Any other params pass through as
   * query-string filters.
   *
   * Siren answers with `{ items, total, page, perPage, totalPages }`. The
   * records come back as an array, with `total` attached as
   * `.estimatedCount`. A bare JSON array is read too, with the count taken
   * from the `x-siren-estimated-count` header.
   */
  async list(params: ListParams = {}): Promise<SirenList<T>> {
    const response = await this.http.request({
      method: 'GET',
      path: this.path,
      query: toListQuery(params),
      retriable: true,
    });

    const body = await parseJsonBody(response);
    let records: T[] = [];
    let count: number | undefined;

    if (Array.isArray(body)) {
      records = body as T[];
    } else if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
      const envelope = body as { items: T[]; total?: unknown };
      records = envelope.items;
      if (typeof envelope.total === 'number' && Number.isFinite(envelope.total)) {
        count = envelope.total;
      }
    }

    if (count === undefined) {
      const countHeader = response.headers.get('x-siren-estimated-count');
      if (countHeader != null && countHeader !== '') {
        const parsed = Number(countHeader);
        if (Number.isFinite(parsed)) count = parsed;
      }
    }

    const list = records as SirenList<T>;
    if (count !== undefined) {
      // Non-enumerable so the value never leaks into JSON.stringify, spreads,
      // or deep-equality against a plain array of records.
      Object.defineProperty(list, 'estimatedCount', {
        value: count,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }

    return list;
  }
}

/**
 * Query parameters for reading one record by id. Siren answers with its
 * default fields when none are named.
 */
export interface RetrieveParams {
  /**
   * The fields to return, as a list or a comma-separated string. A list is
   * sent comma-separated, as Siren reads it.
   */
  fields?: string[] | string;
  /** `extended` returns every field Siren can resolve for the record. */
  include?: string;
  /** Narrows an organization-wide read to one store. */
  propertyId?: number;
}

/**
 * Reads one record with `GET {collection}/{id}`, for every resource that has
 * a `retrieve`, so a rule cannot reach one reader and miss another.
 *
 * Refuses an `id` that is not a positive safe integer, a string included,
 * before sending, with a message that names the id it got. Sends a `fields`
 * list comma-separated and leaves out an empty one, so Siren answers its
 * default fields. Marks the request retriable, since it is a read. Throws
 * `UnexpectedResponseError` when a 2xx body is not a JSON object.
 *
 * @internal
 */
export async function retrieveRecord<T>(
  http: Pick<HttpTransport, 'request'>,
  collection: string,
  id: unknown,
  params: RetrieveParams = {},
): Promise<T> {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    const shown = typeof id === 'string' ? JSON.stringify(id) : String(id);
    throw new SirenError(`retrieve needs a positive whole number id, and got ${shown}.`);
  }

  const path = `${collection}/${id}`;
  const { fields, include, propertyId } = params;
  const query: Query = {
    fields: Array.isArray(fields) ? (fields.length > 0 ? fields.join(',') : undefined) : fields,
    include,
    propertyId,
  };

  const response = await http.request({ method: 'GET', path, query, retriable: true });
  const body = await parseJsonBody(response);

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UnexpectedResponseError(
      `Siren answered GET ${path} with a body that is not a JSON object.`,
      { statusCode: response.status, data: body },
    );
  }

  return body as T;
}

/**
 * Conversions (`/conversions`): an engagement that turned into a reward.
 *
 * `list()` reads one page, and `retrieve(id)` reads one conversion. Both take
 * an API key that holds `ledger:conversions:read`, a dashboard session's
 * token, or a connected site's token with `connect:records:read`.
 */
export class ConversionsResource<T = Record<string, unknown>> extends RecordsResource<T> {
  constructor(http: HttpTransport) {
    super(http, '/conversions');
  }

  /**
   * Read one conversion with `GET /conversions/{id}`.
   *
   * Siren's default fields are `id`, `engagementId`, `transactionId`,
   * `obligationId`, `status`, `type`, `dateCreated` and `dateModified`.
   * `fields` and `include` choose others.
   *
   * Retried on a network error, 429 or 5xx like any read. Throws `SirenError`
   * before sending when `id` is not a positive whole number, `NotFoundError`
   * when Siren has no such conversion or the credential cannot see it (a key
   * bound to one store gets this for another store's conversion), and
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  async retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }
}

/**
 * Transactions (`/transactions`): a sale or other value event a store
 * recorded.
 *
 * `list()` reads one page, and `retrieve(id)` reads one transaction. Both take
 * an API key that holds `ledger:transactions:read`, a dashboard session's
 * token, or a connected site's token with `connect:records:read`.
 */
export class TransactionsResource<T = Record<string, unknown>> extends RecordsResource<T> {
  constructor(http: HttpTransport) {
    super(http, '/transactions');
  }

  /**
   * Read one transaction with `GET /transactions/{id}`.
   *
   * Siren's default fields are `id`, `status` and `dateCreated`. `fields` and
   * `include` choose others, such as `details`, `totalValue` and `currency`.
   *
   * Retried on a network error, 429 or 5xx like any read. Throws `SirenError`
   * before sending when `id` is not a positive whole number, `NotFoundError`
   * when Siren has no such transaction or the credential cannot see it, and
   * `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  async retrieve(id: number, params: RetrieveParams = {}): Promise<T> {
    return retrieveRecord<T>(this.http, this.path, id, params);
  }
}
