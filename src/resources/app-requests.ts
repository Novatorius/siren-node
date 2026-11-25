import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppErrorCode, AuthenticationError, SignatureVerificationError, SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import type {
  AppAnswer,
  AppAnswerReceipt,
  AppRequest,
  AppRequestDetail,
  AppRequestListParams,
  AppRequestRecord,
  VerifyAppRequestOptions,
} from '../record-types';
import { AppRequestStatus } from '../taxonomy';
import type { WebhookHeaders } from '../types';
import { isJsonObject, readObject, writeRecord, writeRecordResent } from './record-requests';
import { readHeader } from './webhooks';

/*
 * The SDK's side of the exchange with Siren: checking a request Siren signed
 * and sent an app, and the three request routes. `AppsResource` and
 * `AppRequestsResource` (apps.ts) are the public surface and call these.
 * Contract: docs/architecture/apps-cli.md, "Checking a request" and "The
 * rules each call follows".
 *
 * Every function here is internal.
 */

/** A request key: `apr_` and 32 lowercase hex characters (Siren's `AppRequestKey`). */
const REQUEST_ID = /^apr_[0-9a-f]{32}$/;

/** The statuses `GET /apps/requests?status=` reads. */
const REQUEST_STATUSES: readonly string[] = Object.values(AppRequestStatus);

/** The longest tolerance `verifyRequest` and `requestHandler` take, an hour. @internal */
export const MAX_TOLERANCE_SECONDS = 3600;

/**
 * Returns `id` when it is a request key. Otherwise throws `SirenError`
 * before anything is sent, naming `method`.
 *
 * @internal
 */
export function appRequestId(id: unknown, method: string): string {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) {
    const shown = typeof id === 'string' ? JSON.stringify(id) : String(id);
    throw new SirenError(`${method} needs a request id of apr_ and 32 lowercase hex characters, and got ${shown}.`);
  }
  return id;
}

/**
 * Reads `GET /apps/requests`, retried as a read, with `?status=` when the
 * params name one. Refuses any other key, and a status outside
 * `AppRequestStatus`, with `SirenError` before sending. Answers the
 * `requests` list, or throws `UnexpectedResponseError` when the body holds
 * no list of objects there.
 *
 * @internal
 */
export async function listAppRequests(
  http: Pick<HttpTransport, 'request'>,
  params: AppRequestListParams,
  filters: readonly string[],
): Promise<AppRequestRecord[]> {
  if (!isJsonObject(params)) {
    throw new SirenError('apps.requests.list() takes an object of filters, such as { status: "needs_attention" }.');
  }
  for (const key of Object.keys(params)) {
    if (!filters.includes(key)) {
      throw new SirenError(
        `apps.requests.list() does not read ${key}, and Siren would ignore it and answer every request. It reads ${filters.join(', ')}.`,
      );
    }
  }
  const status: unknown = params.status;
  if (status !== undefined && !REQUEST_STATUSES.includes(status as string)) {
    throw new SirenError(`apps.requests.list() takes a status of ${REQUEST_STATUSES.join(', ')}.`);
  }
  const { limit, before, idPrefix } = params as { limit?: unknown; before?: unknown; idPrefix?: unknown };
  if (idPrefix !== undefined) {
    // IsRequestIdPrefix takes the hex in either case, and findByPrefix lowercases it.
    if (typeof idPrefix !== 'string' || !/^apr_[0-9a-fA-F]{4,32}$/.test(idPrefix)) {
      throw new SirenError(`apps.requests.list() takes an idPrefix of apr_ and 4 to 32 hex characters, and got ${JSON.stringify(idPrefix)}.`);
    }
    if (Object.keys(params).length > 1) {
      // ListAppRequests answers idPrefix alone, with no paging, and ignores every other filter.
      throw new SirenError('apps.requests.list() takes idPrefix alone. Siren ignores status, limit and before beside it, and answers at most two matches.');
    }
  }
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100)) {
    throw new SirenError(`apps.requests.list() takes a limit of a whole number from 1 to 100, and got ${String(limit)}.`);
  }
  if (before !== undefined) appRequestId(before, 'apps.requests.list() before');
  if (status === 'needs_attention' && (limit !== undefined || before !== undefined)) {
    // ListAppRequests reads the attention list whole and ignores both.
    throw new SirenError('apps.requests.list() pages the plain list only. Siren answers needs_attention whole, so leave out limit and before.');
  }
  const query: Record<string, string> = {
    ...(idPrefix === undefined ? {} : { idPrefix: idPrefix as string }),
    ...(limit === undefined ? {} : { limit: String(limit) }),
    ...(before === undefined ? {} : { before: before as string }),
    ...(status === undefined ? {} : { status: status as string }),
  };

  const answer = await readObject<{ requests: AppRequestRecord[] }>(http, '/apps/requests', query, (body) =>
    Array.isArray(body.requests) && body.requests.every(isJsonObject)
      ? undefined
      : 'Siren answered GET /apps/requests with no list of requests in `requests`.',
  );
  return answer.requests;
}

/**
 * Reads `GET /apps/requests/{id}`, retried as a read, and answers the
 * request with its `data`, `answer` and `answeredByUser`. Refuses a bad id
 * before sending. Throws `UnexpectedResponseError` when the 2xx body is not
 * this request: an `id` other than the one asked for, `data` that is not an
 * object, an `answer` that is neither an object nor null, or an
 * `answeredByUser` that is neither `{ id, email }` nor null.
 *
 * @internal
 */
export async function retrieveAppRequest(http: Pick<HttpTransport, 'request'>, id: string): Promise<AppRequestDetail> {
  const key = appRequestId(id, 'apps.requests.retrieve()');
  const path = `/apps/requests/${key}`;
  return readObject<AppRequestDetail>(http, path, {}, (body) => {
    if (body.id !== key) return `Siren answered GET ${path} with another request's id.`;
    if (!isJsonObject(body.data)) return `Siren answered GET ${path} with no object in \`data\`.`;
    if (body.answer !== null && !isJsonObject(body.answer)) return `Siren answered GET ${path} with an \`answer\` that is neither an object nor null.`;
    const user = body.answeredByUser;
    if (user !== null && !(isJsonObject(user) && typeof user.id === 'number' && typeof user.email === 'string')) {
      return `Siren answered GET ${path} with an \`answeredByUser\` that is neither { id, email } nor null.`;
    }
    return undefined;
  });
}

/**
 * Sends `POST /apps/requests/{id}/resend` once and answers the request as it
 * now stands. Refuses a bad id before sending.
 *
 * @internal
 */
export async function resendAppRequest(http: Pick<HttpTransport, 'request'>, id: string): Promise<AppRequestRecord> {
  const key = appRequestId(id, 'apps.requests.resend()');
  return writeRecord<AppRequestRecord>(http, 'POST', `/apps/requests/${key}/resend`, undefined);
}

/**
 * Sends an answer once with `POST /apps/requests/{id}/answer`, as a new
 * object of the answer's own keys, and answers Siren's receipt.
 *
 * Refuses with `SirenError` before sending: a bad id, an answer that is not
 * a plain object (an array, `null`, a class instance), one with no text
 * `outcome`, one JSON cannot write, and one longer than `maxBytes` bytes as
 * JSON. Throws `UnexpectedResponseError` when a 2xx body is not
 * `{ status: 'accepted' }` with an optional boolean `duplicate`.
 *
 * `retriable` is true only from `apps.requestHandler()`, which resends the
 * very same answer on a lost connection, 429 or 5xx within the client's
 * `maxRetries`. Siren takes the same answer again as `duplicate: true`, so
 * the resend is safe there. `apps.requests.answer()` sends once.
 *
 * @internal
 */
/**
 * The answer as the answer route takes it: a copy of a plain object with a
 * text `outcome`, at most `maxBytes` bytes as JSON. Refuses anything else
 * with `SirenError` naming `method`. `answers.simulate()` runs the same
 * check, so a test sees what a post would refuse.
 *
 * @internal
 */
export function checkedAnswer(answer: unknown, maxBytes: number, method: string): Record<string, unknown> {
  if (!isPlainObject(answer)) {
    throw new SirenError(`${method} takes the answer as a plain object, such as { outcome: 'paid', reference: 'TX-1' }.`);
  }
  const copy: Record<string, unknown> = { ...answer };
  if (typeof copy.outcome !== 'string' || copy.outcome === '') {
    throw new SirenError(`${method} needs a text outcome in the answer, such as 'paid' or 'resolved'.`);
  }
  let json: string;
  try {
    json = JSON.stringify(copy);
  } catch (cause) {
    throw new SirenError(`${method} could not write the answer as JSON.`, { cause });
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new SirenError(`${method} takes an answer of at most ${maxBytes} bytes as JSON, which Siren also refuses past.`);
  }
  return copy;
}

export async function answerAppRequest(
  http: Pick<HttpTransport, 'request'>,
  id: string,
  answer: AppAnswer,
  maxBytes: number,
  retriable = false,
): Promise<AppAnswerReceipt> {
  const method = 'apps.requests.answer()';
  const key = appRequestId(id, method);
  const copy = checkedAnswer(answer, maxBytes, method);

  const path = `/apps/requests/${key}/answer`;
  // writeRecord sends once and answers only the body, so keep the status for the error below.
  let status: number | undefined;
  const sending: Pick<HttpTransport, 'request'> = {
    request: async (request) => {
      const response = await http.request(request);
      status = response.status;
      return response;
    },
  };
  let reply: Record<string, unknown>;
  try {
    reply = retriable
      ? await writeRecordResent<Record<string, unknown>>(sending, 'POST', path, copy)
      : await writeRecord<Record<string, unknown>>(sending, 'POST', path, copy);
  } catch (error) {
    throw unauthorizedAnswer(error);
  }
  if (reply.status !== 'accepted' || (reply.duplicate !== undefined && typeof reply.duplicate !== 'boolean')) {
    throw new UnexpectedResponseError(`Siren answered POST ${path} with a body that is not an accepted answer.`, {
      statusCode: status,
      data: reply,
    });
  }
  return { status: 'accepted', duplicate: reply.duplicate === true };
}

/**
 * The error a refused answer raises. Siren's key check, which every route
 * shares, answers a missing or unknown bearer with 401 and no code
 * (saas/Auth/ApiKeyAuthMiddleware.php line 133 on feat/apps at 1557b0030,
 * captures apps-answer-401-no-bearer and apps-answer-401-unknown-key), before
 * the answer route can send `app_answer_unauthorized`. That 401 gets the
 * code here and a message that names `siren apps rotate-key` and `add-key`, with Siren's
 * status and context kept and its error as `cause`, so a caller acts on one
 * code for every unauthorized answer. Any other error passes as it is.
 */
function unauthorizedAnswer(error: unknown): unknown {
  if (!(error instanceof AuthenticationError) || error.statusCode !== 401 || (error.code !== undefined && error.code !== '')) return error;
  return new AuthenticationError(UNAUTHORIZED_ANSWER, { code: AppErrorCode.AnswerUnauthorized, statusCode: 401, data: error.data, cause: error });
}

/**
 * What the uncoded 401 on the answer route says. Siren's key check words it
 * for any key ("make a new one under API keys"), and an org key made there
 * gets 404 on this route, so the fix for an app's key is a new one: a rotate
 * when the app holds a key, and `add-key` when it holds none, since Siren
 * refuses to rotate a key the app lacks (409 `app_key_missing`). The SDK
 * cannot tell which from a 401, so the message names both, each with when it
 * fits. It holds no app key or target, so the commands name a placeholder
 * and no flags. Siren's own message stays on the error's `cause`.
 */
const UNAUTHORIZED_ANSWER =
  'Siren did not accept this key on the answer route. An app answers with its own key, the SIREN_API_KEY that siren apps apply saved beside its app file. ' +
  'When that key is lost, run siren apps rotate-key <app key> to make a new one. ' +
  'When the app holds no key, as after its key was revoked, run siren apps add-key <app key>.';

/** True for an object made by `{}` or `Object.create(null)`, and nothing else. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks a request Siren signed and sent an app, and answers it parsed. The
 * steps and their order are the contract's, "Checking a request":
 * arguments, `X-Siren-Event`, the V2 header, `X-Siren-Timestamp`, the
 * signature, the time window, then the envelope.
 *
 * @internal
 */
export function verifyAppRequest(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyAppRequestOptions,
  defaultTolerance: number,
): AppRequest {
  if (options !== undefined && !isJsonObject(options)) {
    throw new SirenError('apps.verifyRequest() takes its options as an object, such as { toleranceSeconds: 300 }.');
  }
  const given: VerifyAppRequestOptions = options ?? {};
  if (typeof secret !== 'string' || secret === '') {
    throw new SirenError("apps.verifyRequest() needs the app's signing secret, which Siren showed when it made the app.");
  }
  const tolerance = given.toleranceSeconds ?? defaultTolerance;
  if (!Number.isInteger(tolerance) || tolerance < 1 || tolerance > MAX_TOLERANCE_SECONDS) {
    throw new SirenError(`apps.verifyRequest() takes toleranceSeconds as a whole number from 1 to ${MAX_TOLERANCE_SECONDS}.`);
  }
  const now = given.now ?? Date.now() / 1000;
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new SirenError('apps.verifyRequest() takes now as a finite number of Unix seconds.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new SirenError(
      'apps.verifyRequest() needs the raw request body, as a string or bytes, exactly as received. A parsed object cannot be checked.',
    );
  }

  const event = readHeader(headers, 'X-Siren-Event');
  if (event !== undefined && event !== 'app.request') {
    throw new SignatureVerificationError(
      `This is a ${event} webhook, not an app request. Check it with webhooks.constructEvent().`,
    );
  }

  const { t, bytes } = checkSignedDelivery(rawBody, headers, secret, tolerance, now);
  return appRequestFrom(bytes, t, headers);
}

/**
 * The checks every delivery Siren signs gets, in `verifyRequest`'s order
 * after `X-Siren-Event`: the V2 header, `X-Siren-Timestamp`, the signature,
 * then the time window. Answers the signed time and the body's bytes.
 * Throws `SignatureVerificationError` at the first check that fails.
 * `apps.requestHandler()` runs the same checks on an app request and on
 * any other event.
 *
 * @internal
 */
export function checkSignedDelivery(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  tolerance: number,
  now: number,
): { t: number; bytes: Buffer } {
  const v2 = readHeader(headers, 'X-Siren-Signature-V2');
  if (v2 === undefined) throw new SignatureVerificationError('The request has no X-Siren-Signature-V2 header.', { code: 'signature_missing' });
  const { t, signatures } = readSignatureHeader(v2);

  const stamp = readHeader(headers, 'X-Siren-Timestamp');
  if (stamp !== undefined && stamp !== String(t)) {
    throw new SignatureVerificationError('The X-Siren-Timestamp header differs from the time X-Siren-Signature-V2 signed.', {
      code: 'timestamp_mismatch',
    });
  }

  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = createHmac('sha256', secret).update(`${t}.`).update(bytes).digest();
  const matched = signatures.some(
    (signature) => signature.length === expected.length && timingSafeEqual(signature, expected),
  );
  if (!matched) {
    throw new SignatureVerificationError(
      'The request signature does not match. Pass the raw body exactly as received and the signing secret of this app.',
      { code: 'signature_mismatch' },
    );
  }

  if (Math.abs(now - t) > tolerance) {
    throw new SignatureVerificationError(
      `The request's signed timestamp is more than ${tolerance} seconds from this machine's clock, so it may be a replay. Check the clock if every request fails.`,
      { code: 'timestamp_out_of_tolerance' },
    );
  }
  return { t, bytes };
}

/**
 * Reads a checked body as an app request: JSON, and an envelope of version
 * 1, with the signed `t` as `timestamp` and `X-Siren-Delivery` as
 * `deliveryId`. Throws `SignatureVerificationError` for a body that is
 * not JSON or not such an envelope.
 *
 * @internal
 */
export function appRequestFrom(bytes: Buffer, t: number, headers: WebhookHeaders): AppRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new SignatureVerificationError('The signed body is not JSON.', { cause });
  }
  const problem = envelopeProblem(parsed);
  if (problem !== undefined) {
    throw new SignatureVerificationError(`The signed body is not an app request of version 1. ${problem}`);
  }

  const body = parsed as Record<string, unknown>;
  const request = { ...body, test: body.test === true, data: readData(body.data), isAsk: body.mode === 'ask', timestamp: t } as unknown as AppRequest;
  const delivery = readHeader(headers, 'X-Siren-Delivery');
  if (delivery !== undefined) request.deliveryId = delivery;
  return request;
}

/**
 * The request's `data`, with an empty `args` read as `{}`. Siren stores an
 * engagement type's settings with `json_encode` and no `JSON_FORCE_OBJECT`
 * (AppEngagementQuestion::args(), AppRequestService), so an engagement type
 * with no settings arrives as `"args": []` while the types say an object.
 * Reading it as `{}` keeps `args.weight` safe until Siren sends `{}`.
 */
function readData(data: unknown): unknown {
  if (isJsonObject(data) && Array.isArray(data.args) && data.args.length === 0) return { ...data, args: {} };
  return data;
}

/**
 * Reads `t=<seconds>,v1=<hex>[,v1=<hex>...]`. Answers the signed time and
 * every `v1` as bytes. A `v1` that is not 64 hex characters can match
 * nothing and is dropped. Throws `SignatureVerificationError` for a header
 * with no single whole-number `t` or no `v1`.
 */
function readSignatureHeader(header: string): { t: number; signatures: Buffer[] } {
  const times: string[] = [];
  const signatures: Buffer[] = [];
  let v1Count = 0;
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    const name = at === -1 ? part.trim() : part.slice(0, at).trim();
    const value = at === -1 ? '' : part.slice(at + 1).trim();
    if (name === 't') times.push(value);
    if (name === 'v1') {
      v1Count += 1;
      if (/^[0-9a-f]{64}$/i.test(value)) signatures.push(Buffer.from(value, 'hex'));
    }
  }
  const t = times.length === 1 && /^\d{1,15}$/.test(times[0]!) ? Number(times[0]) : undefined;
  if (t === undefined || v1Count === 0) {
    throw new SignatureVerificationError(
      'The X-Siren-Signature-V2 header cannot be read. Siren sends t=<seconds>,v1=<hex signature>.',
      { code: 'signature_malformed' },
    );
  }
  return { t, signatures };
}

/**
 * The first rule the body of an app request of version 1 (Siren's
 * `AppRequestEnvelope`) breaks, in words that name the field, or undefined
 * when it keeps them all.
 */
function envelopeProblem(body: unknown): string | undefined {
  if (!isJsonObject(body)) return 'The request must be a JSON object.';
  if (body.version !== 1) return "The request's `version` must be 1.";
  if (typeof body.id !== 'string' || !REQUEST_ID.test(body.id)) {
    return "The request's `id` must be `apr_` followed by 32 hex characters.";
  }
  if (body.type !== 'app.request') return "The request's `type` must be `app.request`.";
  if (typeof body.app !== 'string' || body.app === '') return "The request's `app` must be the app's key, a non-empty string.";
  if (body.mode !== 'tell' && body.mode !== 'ask') return "The request's `mode` must be `tell` or `ask`.";
  if (body.test !== undefined && typeof body.test !== 'boolean') return "The request's `test` must be true or false.";
  const feature = body.feature;
  if (!isJsonObject(feature)) return "The request's `feature` must be an object.";
  for (const field of ['kind', 'key', 'id'] as const) {
    if (typeof feature[field] !== 'string') return `The request's \`feature.${field}\` must be a string.`;
  }
  if (typeof body.createdAt !== 'string') return "The request's `createdAt` must be a date string.";
  if (body.mode === 'ask') {
    if (typeof body.answerBy !== 'string') return "An ask's `answerBy` must be a date string.";
    if (typeof body.answerUrl !== 'string' || httpOrigin(body.answerUrl) === undefined) {
      return "An ask's `answerUrl` must be an http or https URL.";
    }
  }
  if (!isJsonObject(body.data)) return "The request's `data` must be a JSON object.";
  return undefined;
}

/**
 * `scheme://host[:port]` of an http or https URL, as `URL` writes an
 * origin, or undefined for anything else.
 *
 * @internal
 */
export function httpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
