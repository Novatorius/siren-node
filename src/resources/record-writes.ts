import { UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { isJsonObject } from './record-requests';
import type { RecordWriteMethod } from './record-requests';

/*
 * Writes whose route may answer with no body. Slice 3's `writeRecord`
 * requires a JSON object, and `PUT /conversions/{id}` answers 200 with an
 * empty body, so this module holds the one helper such a route needs. Slice
 * 3 owns the request helpers in the same folder, so it is a separate file.
 *
 * Internal. Callers use the resources, not this module.
 */

/**
 * Sends a write once, `retriable: false`, with `body` as JSON. Answers the
 * JSON object Siren sends back, and `null` when Siren answers with no body
 * (a 204, or a 2xx with an empty body). `null` means Siren accepted the
 * write and sent nothing back, not that nothing happened. Throws `UnexpectedResponseError`
 * for any other 2xx body, a JSON list, string, number or `null` and a body
 * that is not JSON included, with the 2xx status as its `statusCode`, so a
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
  const response = await http.request({ method, path, body, retriable: false });
  const text = await response.text();
  if (text === '') return null;
  let answer: unknown;
  try {
    answer = JSON.parse(text) as unknown;
  } catch {
    throw new UnexpectedResponseError(`Siren answered ${method} ${path} with a body that is not JSON.`, {
      statusCode: response.status,
      data: text,
    });
  }
  if (!isJsonObject(answer)) {
    throw new UnexpectedResponseError(`Siren answered ${method} ${path} with a body that is not a JSON object.`, {
      statusCode: response.status,
      data: answer,
    });
  }
  return answer as T;
}
