import { SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { parseJsonBody } from '../http';
import type {
  BulkResult,
  CreateConversionParams,
  CreateTransactionParams,
  RegistryOptions,
  TransactionDetailRecord,
  UpdateConversionParams,
} from '../record-types';
import type { ConversionBulkAction, TransactionBulkAction } from '../taxonomy';
import type { ListParams, SirenList } from '../types';
import { bulkRecords, deleteRecord, readObject, recordId, writeRecord } from './record-requests';
import { writeRecordOrNothing } from './record-writes';

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
 *
 * The writes are sent once, apart from the one resend after a 401 that
 * every request gets. A write's answer is lost when it throws
 * `ConnectionError` or a 5xx `ApiError`. Siren may have written before the
 * answer failed, so each write says how to find out before sending it
 * again.
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

  /**
   * Creates a conversion with `POST /conversions`, sent once, and answers it,
   * status 201. Required: `engagementId`, `type` and `status` (`pending`,
   * `approved`, `rejected` or `expired`). Optional: `transactionId` and
   * `obligationId`. Siren writes the status as sent and runs no approval.
   * Throws `SirenError` before sending when `engagementId`, or a
   * `transactionId` or `obligationId` that is present, is not a positive
   * whole number. A connected site's token cannot write conversions.
   *
   * Siren takes a second create as a new conversion. After a lost answer,
   * list the conversions by `transactionId` before sending again. An
   * engagement holds many conversions, so a create with no `transactionId`
   * cannot be checked: set it aside instead of resending it.
   */
  async create(params: CreateConversionParams): Promise<T> {
    recordId(params?.engagementId, 'conversions.create', 'engagementId');
    if (params?.transactionId !== undefined) recordId(params.transactionId, 'conversions.create', 'transactionId');
    if (params?.obligationId !== undefined) recordId(params.obligationId, 'conversions.create', 'obligationId');
    return writeRecord<T>(this.http, 'POST', this.path, params);
  }

  /**
   * Updates a conversion with `PUT /conversions/{id}`, sent once. Siren
   * answers 200 with no body, so this answers `null`, and an object when a
   * later Siren sends one. Either way, Siren took the update. Read the conversion again with {@link retrieve}
   * to see the result: setting `approved` runs Siren's approval, which
   * stores the conversion as `complete`. Throws `NotFoundError` for an
   * unknown id, and `UnexpectedResponseError` for a 2xx body that is
   * neither empty nor a JSON object. Sending it again after a lost answer
   * sets the same values, so it is safe.
   */
  async update(id: number, params: UpdateConversionParams): Promise<T | null> {
    return writeRecordOrNothing<T>(this.http, 'PUT', `${this.path}/${recordId(id, 'conversions.update')}`, params);
  }

  /**
   * Deletes a conversion with `DELETE /conversions/{id}`, sent once. The
   * first call marks it `deleted` and answers it, and a second call removes
   * it and answers `null`. Siren answers 409, raised as `ConflictError`, when
   * an obligation it issued still blocks the removal. Do not resend a lost
   * first delete blindly, since a second call removes the conversion for
   * good. Read it with {@link retrieve} first: status `deleted` means the
   * first call worked, and `NotFoundError` means it is gone.
   */
  async delete(id: number): Promise<T | null> {
    return deleteRecord<T>(this.http, `${this.path}/${recordId(id, 'conversions.delete')}`);
  }

  /**
   * Runs a bulk action with `POST /conversions/bulk`, sent once. Takes 1 to
   * 500 ids and no extra, since Siren reads only the action and ids.
   * `approve` stores each conversion as `complete`. Siren answers
   * `{ success, affected }` and skips ids it cannot find or change, so an
   * `affected` lower than the number of ids sent means some were skipped.
   * `permanent_delete` takes only deleted conversions, and answers 409,
   * raised as `ConflictError`, with nothing deleted when one is not or an
   * obligation blocks it. `delete` and `markPending` set the same status
   * again, so a resend after a lost answer is safe, though `affected` may
   * differ. `approve` and `reject` run Siren's approval and rejection, so
   * read each conversion's status with {@link retrieve} before resending
   * them.
   */
  bulk(action: ConversionBulkAction, ids: readonly number[]): Promise<BulkResult> {
    return bulkRecords<BulkResult>(this.http, this.path, action, ids);
  }

  /**
   * The conversion types Siren knows, `{ options: [{ id, name,
   * supportedIncentives }] }`, from `GET /conversions/types`, such as `sale`
   * and `lead`. Throws `UnexpectedResponseError` when a 2xx body is not a
   * JSON object.
   */
  types(): Promise<RegistryOptions> {
    return readObject<RegistryOptions>(this.http, `${this.path}/types`);
  }
}

/**
 * Transactions (`/transactions`): a sale or other value event a store
 * recorded.
 *
 * `list()` reads one page, and `retrieve(id)` reads one transaction. Both take
 * an API key that holds `ledger:transactions:read`, a dashboard session's
 * token, or a connected site's token with `connect:records:read`.
 *
 * The writes are sent once, apart from the one resend after a 401 that
 * every request gets. A write's answer is lost when it throws
 * `ConnectionError` or a 5xx `ApiError`. Siren may have written before the
 * answer failed, so each write says how to find out before sending it
 * again.
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

  /**
   * A transaction's line items, read from its `details` field with
   * `GET /transactions/{id}?fields=id,details`. Each line carries `id`,
   * `transactionId`, `name`, `description`, `type`, `value` (minor units,
   * per unit), `quantity` and `units`. Siren always sends a field it was
   * asked for, so a record with no `details` list, or with a line that is
   * not an object, throws `UnexpectedResponseError` with the status Siren
   * sent, never an empty answer. The read goes through `readObject` with a
   * `check`.
   */
  details(id: number): Promise<TransactionDetailRecord[]> {
    // Stub: slice 4 packet P9
    void id;
    return Promise.resolve([]);
  }

  /**
   * Records a transaction with its lines with `POST /transactions`, sent
   * once, and answers it, status 201. `details` holds one to 500 lines, each
   * `{ name, value, quantity?, type?, description?, units?, attributes? }`
   * with `value` in minor units. `bindingId` and `bindingDataType` name an
   * outside record Siren stores as a mapping, so the transaction can be
   * found again, and a second transaction for the same binding answers 409,
   * raised as `ConflictError`.
   *
   * Commerce sales go through `events.sale()` instead, which runs
   * attribution. This call records a transaction directly.
   *
   * Send a binding whenever the outside record has an id. Then a resend
   * after a lost answer is safe, since its 409 means the first send worked.
   * Without a binding, Siren takes a resend as a second transaction, so
   * check with `list` before sending again.
   *
   * Throws `SirenError` before sending, with exactly `transactions.create()
   * needs details: a list of 1 to 500 lines.`, when `details` is missing, not
   * an array, empty or longer than 500, or holds a line that is not an
   * object.
   */
  create(params: CreateTransactionParams): Promise<T> {
    // Stub: slice 4 packet P9
    void params;
    return Promise.resolve({} as T);
  }

  /**
   * Runs a bulk action with `POST /transactions/bulk`, sent once. Takes 1 to
   * 500 ids and no extra, since Siren reads only the action and ids.
   * `cancel` and `refund` set the status, and `delete` removes the
   * transactions at once. Siren answers `{ success, affected }` and skips
   * ids it cannot find, so an `affected` lower than the number of ids sent
   * means some were skipped. `delete` skips ids already gone, so its resend
   * is safe. `cancel` and `refund` may start Siren's reversal work, so read
   * each transaction's status with {@link retrieve} before resending them.
   */
  bulk(action: TransactionBulkAction, ids: readonly number[]): Promise<BulkResult> {
    // Stub: slice 4 packet P9
    void action;
    void ids;
    return Promise.resolve({});
  }

  /**
   * Credits transactions to a collaborator with
   * `POST /transactions/credit-collaborator`, body `{ transactionIds,
   * collaboratorId }` plus `type` when given, sent once, which makes a
   * conversion for each. `type` sets the conversion type, `sale` when it is
   * left out. Answers `{ success, affected }`. Siren drops ids it cannot
   * find, so an `affected` lower than the number of ids sent means some were
   * not credited.
   *
   * A second send makes a second conversion for each transaction, and Siren
   * takes no idempotency key for it. After a lost answer, list the
   * conversions by `transactionId` and credit only the transactions that
   * have none.
   *
   * Throws `SirenError` before sending when `transactionIds` is not a
   * non-empty array of at most 500 positive whole numbers, `collaboratorId`
   * is not a positive whole number, or `type` is given and is not a
   * non-empty string. Siren answers 404, raised as `NotFoundError`, when it
   * has no such collaborator.
   */
  creditCollaborator(transactionIds: readonly number[], collaboratorId: number, type?: string): Promise<BulkResult> {
    // Stub: slice 4 packet P9
    void transactionIds;
    void collaboratorId;
    void type;
    return Promise.resolve({});
  }

  /**
   * The transaction sources Siren knows, `{ options: [{ id, name }] }`, from
   * `GET /transactions/sources`, such as `wc_order` and `medusa_order`.
   * Throws `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  sources(): Promise<RegistryOptions> {
    // Stub: slice 4 packet P9
    return Promise.resolve({ options: [] });
  }
}
