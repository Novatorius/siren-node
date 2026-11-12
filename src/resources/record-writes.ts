import type { HttpTransport } from '../http';
import type { RecordWriteMethod } from './record-requests';

/*
 * Writes whose route may answer with no body. Slice 3's `writeRecord`
 * requires a JSON object, and `PUT /conversions/{id}` answers 200 with an
 * empty body, so this module holds the one helper such a route needs. It
 * lives beside record-requests.ts, which slice 3 owns.
 *
 * Internal. The resources are the public surface.
 */

/**
 * Sends a write once, `retriable: false`, with `body` as JSON. Answers the
 * JSON object Siren sends back, and `null` when Siren answers with no body
 * (a 204, or a 2xx with an empty body). Throws `UnexpectedResponseError`
 * for any other 2xx body, with the 2xx status as its `statusCode`, so a
 * caller can tell that Siren accepted the write and must not send it again.
 *
 * @internal
 */
export async function writeRecordOrNothing<T>(
  http: Pick<HttpTransport, 'request'>,
  method: RecordWriteMethod,
  path: string,
  body: unknown,
): Promise<T | null> {
  // Stub: slice 4 packet P8
  void http;
  void method;
  void path;
  void body;
  return null;
}
