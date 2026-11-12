import type { HttpTransport } from '../http';
import type { RecordListParams } from '../record-types';
import type { SirenList } from '../types';

/*
 * The requests every record resource sends, in one place, so a rule cannot
 * reach one resource and miss another. Reads are retriable. Writes and
 * deletes are sent once, whatever the client's `maxRetries`, because a
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
  // Stub: slice 3 packet P1
  void id;
  void method;
  void what;
  return 1;
}

/**
 * Turns a record list's params into the query a list route reads. Pages
 * with `page`/`perPage` the way `toListQuery` does. A list value, such as
 * `status: ['active', 'pending']` or `fields: ['id', 'email']`, is sent
 * comma-separated, which Siren reads as "any of" for a filter and as the
 * field list for `fields`. An empty list is left out. A boolean is sent as
 * `true` or `false`. `undefined` is left out.
 *
 * Throws `SirenError` before sending for a value Siren could not read: an
 * object, a list holding anything but strings and finite numbers, or a list
 * member that holds a comma, since Siren would split it into two values.
 * Nothing is dropped silently.
 *
 * @internal
 */
export function recordListQuery(
  params: RecordListParams,
): Record<string, string | number | boolean | undefined> {
  // Stub: slice 3 packet P1
  void params;
  return {};
}

/**
 * Reads one page of a record list with `GET {path}`, retriable, through
 * {@link recordListQuery}. Answers as `RecordsResource.list()` does: a real
 * array, with Siren's `total` as the non-enumerable `estimatedCount`.
 *
 * @internal
 */
export async function listRecords<T>(
  http: Transport,
  path: string,
  params: RecordListParams = {},
): Promise<SirenList<T>> {
  // Stub: slice 3 packet P1
  void http;
  void path;
  void params;
  return [] as unknown as SirenList<T>;
}

/**
 * Reads a JSON object with `GET {path}`, retriable, such as a collaborator
 * read for one field or a route's status types. Throws
 * `UnexpectedResponseError` when a 2xx body is not a JSON object.
 *
 * @internal
 */
export async function readObject<T>(
  http: Transport,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  // Stub: slice 3 packet P1
  void http;
  void path;
  void query;
  return {} as T;
}

/**
 * Reads a JSON array with `GET {path}`, retriable, for a route that answers a
 * bare list with no list envelope, such as `GET /programs/currency-types`.
 * Throws `UnexpectedResponseError` when a 2xx body is not a JSON array.
 *
 * @internal
 */
export async function readList<T>(http: Transport, path: string): Promise<T[]> {
  // Stub: slice 3 packet P1
  void http;
  void path;
  return [];
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
  // Stub: slice 3 packet P1
  void http;
  void method;
  void path;
  void body;
  return {} as T;
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
  // Stub: slice 3 packet P1
  void http;
  void method;
  void path;
  void body;
  return [];
}

/**
 * Sends a DELETE once, `retriable: false`, with `query` in the query
 * string and no body. Answers the JSON object Siren sends back, such as a
 * record marked `deleted` or `{ deleted: true }`, and `null` when Siren
 * answers with no body (a 204, or a 200 with an empty body), as it does when
 * it removes a record for good. Throws `UnexpectedResponseError` for any
 * other 2xx body.
 *
 * @internal
 */
export async function deleteRecord<T>(
  http: Transport,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T | null> {
  // Stub: slice 3 packet P1
  void http;
  void path;
  void query;
  return null;
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
  // Stub: slice 3 packet P1
  void http;
  void collection;
  void action;
  void ids;
  void extra;
  return {} as T;
}
