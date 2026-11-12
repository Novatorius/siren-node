import { SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { parseJsonBody } from '../http';
import type { SirenList } from '../types';
import { toListQuery } from './records';

/*
 * The requests every record resource sends, in one place, so a rule cannot
 * reach one resource and miss another. Reads are retriable. Writes and
 * deletes are sent once, whatever the client's `maxRetries`, apart from the
 * one resend after a 401 that every request gets, because a
 * second create makes a second record and a second delete of a collaborator
 * or a program removes the record the first one only marked deleted. This
 * mirrors the PHP SDK's ListResource, `write()` and `remove()`.
 *
 * Every function here is internal. The resources are the public surface.
 */

/** The most ids one bulk action may carry. Siren answers 400 past it. */
export const MAX_BULK_IDS = 500;

/** A record transport: the one method the helpers call. */
type Transport = Pick<HttpTransport, 'request'>;

/** A write's HTTP method. */
export type RecordWriteMethod = 'POST' | 'PUT';

/**
 * True for a positive safe integer, the only id Siren reads as sent.
 *
 * @internal
 */
export function isRecordId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * True for a parsed JSON object: not `null`, not an array, not a scalar.
 *
 * @internal
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns `id` when it is a positive safe integer. Otherwise throws
 * `SirenError` before anything is sent, with a message that starts with
 * `method` and names the id it got, as `retrieveRecord` words it:
 * `"{method} needs a positive whole number {what}, and got {shown}."`, where
 * `shown` is a string id in JSON quotes and anything else through `String()`.
 * `what` defaults to `id`.
 *
 * @internal
 */
export function recordId(id: unknown, method: string, what = 'id'): number {
  if (!isRecordId(id)) {
    const shown = typeof id === 'string' ? JSON.stringify(id) : String(id);
    throw new SirenError(`${method} needs a positive whole number ${what}, and got ${shown}.`);
  }
  return id;
}

/**
 * The keys every record list takes, whatever its filters: paging, sorting
 * and `fields`.
 *
 * @internal
 */
export const LIST_CONTROL_KEYS = ['page', 'perPage', 'number', 'offset', 'orderBy', 'order', 'fields'] as const;

/**
 * The id filters a list route reads, by how Cloud reads them. `one` names
 * keys Cloud casts to a single whole number, such as `programId` on
 * `/collaborators`, so a list or `'3abc'` would quietly narrow to one id.
 * `many` names keys Cloud matches as a column, where a list means "any of".
 *
 * @internal
 */
export interface ListIdFilters {
  /** Keys that take one positive whole number, never a list. */
  readonly one?: readonly string[];
  /** Keys that take a positive whole number or a non-empty list of them. */
  readonly many?: readonly string[];
}

/**
 * Turns a record list's params into the query a list route reads. Pages
 * with `page`/`perPage` the way `toListQuery` does. A list value, such as
 * `status: ['active', 'pending']` or `fields: ['id', 'email']`, is sent
 * comma-separated, which Siren reads as "any of" for a filter and as the
 * field list for `fields`. An empty `fields` list is left out, so Siren
 * answers its default fields. An empty list on any other key throws
 * `SirenError` naming it, since leaving the filter out would answer every
 * record where the caller asked for none. A boolean is sent as `true` or
 * `false`. `undefined` is left out.
 *
 * `ids` names the route's id filters (see {@link ListIdFilters}). A key in
 * `ids.one` must be one positive safe integer, and a key in `ids.many` a
 * positive safe integer or a list of them, or `SirenError` names the key
 * before sending.
 *
 * `filters` names the filter keys the route reads. Siren ignores a key it
 * does not read and answers every record, so a key that is neither one of
 * {@link LIST_CONTROL_KEYS} nor in `filters` throws `SirenError` naming it,
 * `propertyId` included, even when its value is `undefined`.
 *
 * Throws `SirenError` naming the key, before sending, for a value Siren
 * could not read as sent: an object, `null`, a function, a list holding
 * anything but strings and finite numbers, a list member that holds a
 * comma, or a string filter that holds a comma. Siren splits a comma in any
 * filter string into "any of", so `code: 'A,B'` would match two codes. A
 * comma is allowed only in `fields` and in the search text `s`. Nothing is
 * dropped silently.
 *
 * @internal
 */
export function recordListQuery(
  params: object,
  filters: readonly string[],
  ids: ListIdFilters = {},
): Record<string, string | number | boolean | undefined> {
  const allowed = new Set<string>([...LIST_CONTROL_KEYS, ...filters]);
  const one = new Set<string>(ids.one ?? []);
  const many = new Set<string>(ids.many ?? []);
  const query: Record<string, string | number | boolean | undefined> = {};

  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new SirenError(`This list does not read ${key}, and Siren would ignore it and answer every record.`);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;

    if (one.has(key) && !isRecordId(value)) {
      throw new SirenError(`${key} takes one positive whole number id, since Siren reads only one.`);
    }
    if (many.has(key) && !(Array.isArray(value) ? value : [value]).every(isRecordId)) {
      throw new SirenError(`${key} takes a positive whole number id or a list of them.`);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        if (key === 'fields') continue;
        throw new SirenError(`An empty ${key} list would answer every record. Send at least one value.`);
      }
      for (const member of value as unknown[]) {
        if (typeof member !== 'string' && !(typeof member === 'number' && Number.isFinite(member))) {
          throw new SirenError(`Send ${key} as a list of strings or finite numbers.`);
        }
        if (String(member).includes(',')) {
          throw new SirenError(`A ${key} list member cannot hold a comma, which Siren reads as "any of".`);
        }
      }
      query[key] = value.join(',');
    } else if (typeof value === 'string') {
      if (value.includes(',') && key !== 'fields' && key !== 's') {
        throw new SirenError(`A ${key} value cannot hold a comma, which Siren reads as "any of".`);
      }
      query[key] = value;
    } else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
      query[key] = value;
    } else {
      throw new SirenError(`Send ${key} as a string, a finite number, a boolean or a list of strings or numbers.`);
    }
  }

  return toListQuery(query);
}

/**
 * Reads one page of a record list with `GET {path}`, retriable, through
 * {@link recordListQuery} with the route's `filters` and `ids`. Answers a
 * real array, with Siren's `total` as the non-enumerable `estimatedCount`,
 * or the `x-siren-estimated-count` header for a bare array.
 *
 * Throws `UnexpectedResponseError` with the status Siren sent when a 2xx
 * body is neither a JSON array nor an object whose `items` is an array, an
 * empty body included, or when any row is not a JSON object. It never
 * answers an empty page for such a body, since "nobody holds this code"
 * must not stand in for a broken answer.
 *
 * @internal
 */
export async function listRecords<T>(
  http: Transport,
  path: string,
  params: object,
  filters: readonly string[],
  ids: ListIdFilters = {},
): Promise<SirenList<T>> {
  const query = recordListQuery(params, filters, ids);
  const response = await http.request({ method: 'GET', path, query, retriable: true });
  const body = await parseJsonBody(response);

  let records: unknown[];
  let count: number | undefined;
  if (Array.isArray(body)) {
    records = body;
  } else if (isJsonObject(body) && Array.isArray(body.items)) {
    records = body.items as unknown[];
    if (typeof body.total === 'number' && Number.isFinite(body.total)) count = body.total;
  } else {
    throw new UnexpectedResponseError(`Siren answered GET ${path} with a body that is not a record list.`, {
      statusCode: response.status,
      data: body,
    });
  }

  if (!records.every(isJsonObject)) {
    throw new UnexpectedResponseError(`Siren answered GET ${path} with a list row that is not a JSON object.`, {
      statusCode: response.status,
      data: body,
    });
  }

  if (count === undefined) {
    const header = response.headers.get('x-siren-estimated-count');
    if (header != null && header !== '') {
      const parsed = Number(header);
      if (Number.isFinite(parsed)) count = parsed;
    }
  }

  const list = records as SirenList<T>;
  if (count !== undefined) {
    // Non-enumerable, as RecordsResource.list sets it, so it stays out of JSON and spreads.
    Object.defineProperty(list, 'estimatedCount', {
      value: count,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return list;
}

/**
 * Reads a JSON object with `GET {path}`, retriable, such as a collaborator
 * read for one field or a route's status types. Throws
 * `UnexpectedResponseError` with the status Siren sent when a 2xx body is
 * not a JSON object.
 *
 * `check`, when given, runs on the object. When it answers a message,
 * `readObject` throws `UnexpectedResponseError` with that message, the
 * status Siren sent and the body as `data`, so a field read can fail with
 * the same detail as any other broken answer.
 *
 * @internal
 */
export async function readObject<T>(
  http: Transport,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
  check?: (body: Record<string, unknown>) => string | undefined,
): Promise<T> {
  const response = await http.request({ method: 'GET', path, query, retriable: true });
  const body = await parseJsonBody(response);
  if (!isJsonObject(body)) {
    throw new UnexpectedResponseError(`Siren answered GET ${path} with a body that is not a JSON object.`, {
      statusCode: response.status,
      data: body,
    });
  }

  const problem = check === undefined ? undefined : check(body);
  if (problem !== undefined) {
    throw new UnexpectedResponseError(problem, { statusCode: response.status, data: body });
  }
  return body as T;
}

/**
 * Reads a JSON array with `GET {path}`, retriable, for a route that answers a
 * bare list with no list envelope, such as `GET /programs/currency-types`.
 * Throws `UnexpectedResponseError` when a 2xx body is not a JSON array.
 *
 * @internal
 */
export async function readList<T>(http: Transport, path: string): Promise<T[]> {
  const response = await http.request({ method: 'GET', path, retriable: true });
  const body = await parseJsonBody(response);
  if (!Array.isArray(body)) {
    throw new UnexpectedResponseError(`Siren answered GET ${path} with a body that is not a JSON array.`, {
      statusCode: response.status,
      data: body,
    });
  }
  return body as T[];
}

/**
 * Sends a record write once, `retriable: false`, with `body` as JSON, and
 * answers the JSON object Siren sends back. Throws `UnexpectedResponseError`
 * when a 2xx body is not a JSON object. Its `statusCode` is the 2xx Siren
 * sent, so a caller can tell that Siren accepted the write and must not send
 * it again.
 *
 * @internal
 */
export async function writeRecord<T>(
  http: Transport,
  method: RecordWriteMethod,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await http.request({ method, path, body, retriable: false });
  const answer = await parseJsonBody(response);
  if (!isJsonObject(answer)) {
    throw new UnexpectedResponseError(`Siren answered ${method} ${path} with a body that is not a JSON object.`, {
      statusCode: response.status,
      data: answer,
    });
  }
  return answer as T;
}

/**
 * Sends a write once, as {@link writeRecord} does, for a route that answers a
 * bare JSON array, such as the member writes on
 * `/collaborator-groups/{id}/members`. Throws `UnexpectedResponseError` when
 * a 2xx body is not a JSON array, with the 2xx status as its `statusCode`.
 *
 * @internal
 */
export async function writeList<T>(
  http: Transport,
  method: RecordWriteMethod,
  path: string,
  body: unknown,
): Promise<T[]> {
  const response = await http.request({ method, path, body, retriable: false });
  const answer = await parseJsonBody(response);
  if (!Array.isArray(answer)) {
    throw new UnexpectedResponseError(`Siren answered ${method} ${path} with a body that is not a JSON array.`, {
      statusCode: response.status,
      data: answer,
    });
  }
  return answer as T[];
}

/**
 * Sends a DELETE once, `retriable: false`, with `query` in the query
 * string and no body. Answers the JSON object Siren sends back, such as a
 * record marked `deleted` or `{ deleted: true }`, and `null` for a 204, as
 * Siren answers when it removes a record for good. Throws
 * `UnexpectedResponseError` with the status for any other 2xx body, an
 * empty 200 included, since a cut-off answer must not read as "removed for
 * good".
 *
 * @internal
 */
export async function deleteRecord<T>(
  http: Transport,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T | null> {
  const response = await http.request({ method: 'DELETE', path, query, retriable: false });
  const text = await response.text();
  if (text === '' && response.status === 204) return null;

  const answer = text === '' ? undefined : await parseJsonBody({ text: async () => text });
  if (!isJsonObject(answer)) {
    throw new UnexpectedResponseError(
      `Siren answered DELETE ${path} with a ${response.status} whose body is not a JSON object.`,
      { statusCode: response.status, data: answer === undefined ? text : answer },
    );
  }
  return answer as T;
}

/**
 * Runs one of a collection's bulk actions with `POST {collection}/bulk`,
 * sent once, with body `{ action, ids, ...extra }` (the action and ids
 * first, then the extras). Throws `SirenError` before sending when `action`
 * is empty, when `ids` is not a non-empty array, when it holds more than
 * {@link MAX_BULK_IDS} ids, when any id is not a positive safe integer, or
 * when `extra` names `action` or `ids`. Answers the JSON object Siren sends
 * back, through {@link writeRecord}.
 *
 * @internal
 */
export async function bulkRecords<T>(
  http: Transport,
  collection: string,
  action: string,
  ids: readonly number[],
  extra: Record<string, unknown> = {},
): Promise<T> {
  if (typeof action !== 'string' || action === '') {
    throw new SirenError('bulk needs an action.');
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new SirenError('bulk needs a list of one or more ids.');
  }
  if (ids.length > MAX_BULK_IDS) {
    throw new SirenError(`bulk takes at most ${MAX_BULK_IDS} ids, and got ${ids.length}.`);
  }
  for (const id of ids) recordId(id, 'bulk');
  if (Object.prototype.hasOwnProperty.call(extra, 'action') || Object.prototype.hasOwnProperty.call(extra, 'ids')) {
    throw new SirenError('bulk sets action and ids itself, so extra cannot name either.');
  }
  return writeRecord<T>(http, 'POST', `${collection}/bulk`, { action, ids: [...ids], ...extra });
}
