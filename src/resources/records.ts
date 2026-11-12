import { SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { parseJsonBody } from '../http';
import type {
  BulkResult,
  CreateConversionParams,
  CreateTransactionParams,
  RecoveredConversion,
  RecoveredCredit,
  RegistryOptions,
  TransactionDetailRecord,
  UpdateConversionParams,
} from '../record-types';
import type { ConversionBulkAction, TransactionBulkAction } from '../taxonomy';
import type { ListParams, SirenList } from '../types';
import { MAX_BULK_IDS, bulkRecords, deleteRecord, readObject, recordId, writeRecord } from './record-requests';
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
  /**
   * The fields {@link create} sends: the five Siren's create route reads
   * (`CreateNewConversion.php`), which are the five the PHP SDK documents.
   * `create` refuses any other key before sending.
   */
  static readonly CREATE_FIELDS = ['engagementId', 'type', 'status', 'transactionId', 'obligationId'] as const;

  /**
   * The filters {@link recoverCreate} and `transactions.recoverCreditCollaborator()`
   * send to `GET /conversions`. `listRecords` refuses any other key.
   */
  static readonly RECOVERY_FILTERS = ['transactionId', 'engagementId', 'collaboratorId', 'type'] as const;

  /**
   * The id filters among {@link RECOVERY_FILTERS}, by how Siren reads them.
   * `GetConversions.php` casts `collaboratorId` to one number and matches
   * `transactionId` and `engagementId` as columns, where a list means "any of".
   */
  static readonly RECOVERY_ID_FILTERS = { one: ['collaboratorId'], many: ['transactionId', 'engagementId'] } as const;

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
   * A connected site's token cannot write conversions.
   *
   * Sends a new object holding only the {@link CREATE_FIELDS} that `params`
   * gives. Throws `SirenError` before sending when `params` holds any other
   * key, whatever its value, `undefined` included, with exactly
   * `conversions.create() cannot send "{key}". Siren's create route reads
   * only engagementId, type, status, transactionId and obligationId.`, and
   * when `engagementId`, or a `transactionId` or `obligationId` that is
   * present, is not a positive whole number.
   *
   * Siren takes a second create as a new conversion. After a lost answer,
   * send it again through {@link recoverCreate}, which sends it only when
   * Siren holds no such conversion. An engagement holds many conversions,
   * so a create with no `transactionId` cannot be checked. Do not resend
   * one.
   */
  async create(params: CreateConversionParams): Promise<T> {
    recordId(params?.engagementId, 'conversions.create', 'engagementId');
    if (params?.transactionId !== undefined) recordId(params.transactionId, 'conversions.create', 'transactionId');
    if (params?.obligationId !== undefined) recordId(params.obligationId, 'conversions.create', 'obligationId');
    // Stub: slice 4 fix packet F3 (the create allow lists).
    return writeRecord<T>(this.http, 'POST', this.path, params);
  }

  /**
   * Sends a conversion create whose first send lost its answer, only when
   * Siren holds no such conversion, for a caller's queue to run in place of
   * a blind resend of {@link create}.
   *
   * Reads `GET /conversions` through `listRecords` with
   * {@link RECOVERY_FILTERS} and {@link RECOVERY_ID_FILTERS}, with the
   * create's `transactionId`, `engagementId` and `type`, `fields`
   * `id,engagementId,transactionId,type,status`, `number: 1`, `orderBy: 'id'`
   * and `order: 'ASC'`. When Siren answers a well-formed list holding that
   * conversion, it answers the row with `created: false` and sends nothing.
   * The match is one conversion per transaction, engagement and type, the
   * one Siren makes for a create: a row whose `status` or `obligationId`
   * differs still counts, since an approval changes the status after the
   * first send landed.
   * Only a well-formed empty list, a JSON array or an `items` list with no
   * rows, sends {@link create}, once, and answers the new conversion with
   * `created: true`.
   *
   * It never sends the create after an answer it cannot read. A 2xx body
   * that is not a record list (not JSON, no `items` key, an `items` that is
   * not a list) or holds a row that is not an object throws
   * `UnexpectedResponseError` with the status Siren sent. A row whose
   * `transactionId`, `engagementId` or `type` is not the create's means
   * Siren did not read a filter, and throws `UnexpectedResponseError` with
   * the row as its `data` and no status. Every error from the read reaches
   * the caller as it is, after the read's own retries inside `maxRetries`,
   * with the create unsent. An error from the create itself reaches the
   * caller as it is too, and the create is never sent a third time.
   *
   * Throws `SirenError` before anything is sent when `params` has no
   * `transactionId`, with exactly `conversions.recoverCreate() needs a
   * transactionId to find the first send. Without one, Siren cannot tell
   * whether the create landed.`, and when `engagementId` or `transactionId` is not a positive
   * whole number. Throws `SirenError` before sending the create for every
   * other reason {@link create} gives.
   *
   * The read and the create are two requests, so two workers that recover
   * the same create at once can both find nothing. Run one recovery per
   * conversion at a time, keyed in the queue by the create's
   * `transactionId`, `engagementId` and `type`. {@link create} never falls
   * back to this method on its own.
   */
  async recoverCreate(params: CreateConversionParams): Promise<RecoveredConversion<T>> {
    // Stub: slice 4 fix packet F1 (the lost-answer check). It throws, so a
    // caller can never read the stub as a recovered create.
    void params;
    throw new SirenError('conversions.recoverCreate() is not built yet: slice 4 fix packet F1.');
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
  /**
   * The fields {@link create} sends: the three Siren's create route reads
   * (`CreateTransaction.php`), which are the three the PHP SDK documents.
   * `create` refuses any other key before sending.
   */
  static readonly CREATE_FIELDS = ['details', 'bindingId', 'bindingDataType'] as const;

  /**
   * The keys of one line {@link create} sends: the seven Siren reads on a
   * line (`TransactionDetailChecks.php`), which are the seven the PHP SDK
   * documents. `create` refuses any other key on a line before sending.
   */
  static readonly DETAIL_FIELDS = ['name', 'description', 'type', 'value', 'quantity', 'units', 'attributes'] as const;

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
  async details(id: number): Promise<TransactionDetailRecord[]> {
    const path = `${this.path}/${recordId(id, 'transactions.details')}`;
    const record = await readObject<{ details: TransactionDetailRecord[] }>(this.http, path, { fields: 'id,details' }, (body) => {
      const lines = body.details;
      return !Array.isArray(lines) || lines.some((line) => typeof line !== 'object' || line === null || Array.isArray(line))
        ? `Siren answered GET ${path} with no details list of objects.`
        : undefined;
    });
    return record.details;
  }

  /**
   * Records a transaction with its lines with `POST /transactions`, sent
   * once, and answers it, status 201. `details` holds one to 500 lines, each
   * `{ name, value, quantity?, type?, description?, units?, attributes? }`
   * with `value` in minor units. `bindingId` and `bindingDataType` together
   * name an outside record, such as an order, which Siren stores as a
   * mapping, so the transaction can be found again. A second transaction
   * for the same binding answers 409, raised as `ConflictError`.
   *
   * Commerce sales go through `events.sale()` instead, which runs
   * attribution. This call records a transaction directly.
   *
   * Send a binding whenever the outside record has an id. Then a resend
   * after a lost answer is safe, since its 409 means the first send worked.
   * Without a binding, Siren takes a resend as a second transaction, so
   * check with `list` before sending again.
   *
   * Siren finds a resent transaction only by both binding fields, and reads
   * `""`, `"0"` and `0` as no binding at all, so this throws `SirenError`
   * before sending, with exactly `transactions.create() needs bindingId and
   * bindingDataType together, or neither. Siren finds a resent transaction
   * only by both.`, when one is given without the other, and with exactly
   * `transactions.create() cannot send {key} {value}, which Siren reads as
   * no binding.` for a binding field of `""`, `"0"` or `0`. `{value}` is the
   * value in JSON. A field that is `undefined` or `null` counts as not
   * given.
   *
   * Sends a new object holding only `details`, `bindingId` and
   * `bindingDataType` ({@link CREATE_FIELDS}), each line a new object
   * holding only the {@link DETAIL_FIELDS} it gives. Throws `SirenError`
   * before sending for any other key, whatever its value, `undefined`
   * included, with exactly `transactions.create() cannot send "{key}".
   * Siren's create route reads only details, bindingId and
   * bindingDataType.`, and for any other key on a line, with exactly
   * `transactions.create() cannot send "{key}" on line {n}. A line holds
   * only name, description, type, value, quantity, units and attributes.`,
   * where `{n}` counts from 1. Siren ignores a key it does not read, so a
   * misspelt `quantity` would record one unit.
   *
   * Throws `SirenError` before sending, with exactly `transactions.create()
   * needs details: a list of 1 to 500 lines.`, when `details` is missing, not
   * an array, empty or longer than 500, or holds a line that is not an
   * object. That check runs first.
   */
  async create(params: CreateTransactionParams): Promise<T> {
    const details: unknown = params?.details;
    if (
      !Array.isArray(details) ||
      details.length === 0 ||
      details.length > MAX_BULK_IDS ||
      details.some((line) => typeof line !== 'object' || line === null || Array.isArray(line))
    ) {
      throw new SirenError('transactions.create() needs details: a list of 1 to 500 lines.');
    }
    // Stub: slice 4 fix packet F2 (the binding pair).
    // Stub: slice 4 fix packet F3 (the create allow lists).
    return writeRecord<T>(this.http, 'POST', this.path, params);
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
  async bulk(action: TransactionBulkAction, ids: readonly number[]): Promise<BulkResult> {
    return bulkRecords<BulkResult>(this.http, this.path, action, ids);
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
   * takes no idempotency key for it. After a lost answer, send it again
   * through {@link recoverCreditCollaborator}, which credits only the
   * transactions that hold no conversion for this collaborator.
   *
   * Throws `SirenError` before sending when `transactionIds` is not a
   * non-empty array of at most 500 positive whole numbers, `collaboratorId`
   * is not a positive whole number, or `type` is given and is not a
   * non-empty string. Siren answers 404, raised as `NotFoundError`, when it
   * has no such collaborator.
   */
  async creditCollaborator(transactionIds: readonly number[], collaboratorId: number, type?: string): Promise<BulkResult> {
    const method = 'transactions.creditCollaborator';
    if (!Array.isArray(transactionIds) || transactionIds.length === 0 || transactionIds.length > MAX_BULK_IDS) {
      throw new SirenError(`${method} needs transactionIds: a list of 1 to ${MAX_BULK_IDS} ids.`);
    }
    for (const id of transactionIds) recordId(id, method, 'transactionId');
    const body: Record<string, unknown> = {
      transactionIds: [...transactionIds],
      collaboratorId: recordId(collaboratorId, method, 'collaboratorId'),
    };
    if (type !== undefined) {
      if (typeof type !== 'string' || type === '') throw new SirenError(`${method} needs a type that is a non-empty string.`);
      body.type = type;
    }
    return writeRecord<BulkResult>(this.http, 'POST', `${this.path}/credit-collaborator`, body);
  }

  /**
   * Credits transactions to a collaborator after {@link creditCollaborator}
   * lost its answer, sending only the transactions not yet credited, for a
   * caller's queue to run in place of a blind resend.
   *
   * Reads `GET /conversions` through `listRecords` with
   * `ConversionsResource.RECOVERY_FILTERS` and `RECOVERY_ID_FILTERS`:
   * `transactionId` the asked ids, `collaboratorId`, `type` (`sale` when
   * left out, as Siren defaults it), `fields`
   * `id,transactionId,collaboratorId,type`, `number: 200`, `offset` from 0,
   * `orderBy: 'id'` and `order: 'ASC'`, page after page, each `offset` the
   * number of rows read so far, until a page holds no rows. A short page is
   * not the end, since Siren may answer fewer rows than asked. A
   * transaction counts as credited when a row names it. Siren filters by the collaborator, so another collaborator's
   * conversion on the same transaction does not count. It then sends
   * {@link creditCollaborator} once with the rest, in the order asked, or
   * nothing when none is left.
   *
   * It never sends after an answer it cannot read. A 2xx body that is not a
   * record list (not JSON, no `items` key, an `items` that is not a list) or
   * holds a row that is not an object throws `UnexpectedResponseError` with
   * the status Siren sent. A row whose `transactionId` is not one asked,
   * whose `collaboratorId` is not the collaborator or whose `type` is not
   * the type means Siren did not read a filter, and throws
   * `UnexpectedResponseError` with the row as its `data` and no status.
   * Every error from a read reaches the caller as it is, after the read's
   * own retries inside `maxRetries`, with nothing sent. An error from the
   * credit itself reaches the caller as it is too, and it is never sent a
   * third time.
   *
   * Answers `{ alreadyCredited, credited, result }`: the asked ids a row
   * named, the ids sent, and Siren's `{ success, affected }` for the send,
   * or `null` when nothing was sent. An `affected` lower than
   * `credited.length` means Siren skipped ids it could not find.
   *
   * Throws `SirenError` before anything is sent for every reason
   * {@link creditCollaborator} gives. The reads and the send are separate
   * requests, so run one recovery per collaborator and transaction at a
   * time, keyed in the queue by the collaborator, the type and the sorted
   * transaction ids. {@link creditCollaborator} never falls back to this
   * method on its own.
   */
  async recoverCreditCollaborator(
    transactionIds: readonly number[],
    collaboratorId: number,
    type?: string,
  ): Promise<RecoveredCredit> {
    // Stub: slice 4 fix packet F1 (the lost-answer check). It throws, so a
    // caller can never read the stub as a recovered credit.
    void transactionIds;
    void collaboratorId;
    void type;
    throw new SirenError('transactions.recoverCreditCollaborator() is not built yet: slice 4 fix packet F1.');
  }

  /**
   * The transaction sources Siren knows, `{ options: [{ id, name }] }`, from
   * `GET /transactions/sources`, such as `wc_order` and `medusa_order`.
   * Throws `UnexpectedResponseError` when a 2xx body is not a JSON object.
   */
  async sources(): Promise<RegistryOptions> {
    return readObject<RegistryOptions>(this.http, `${this.path}/sources`);
  }
}
