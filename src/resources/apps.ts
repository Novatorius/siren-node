import type { HttpTransport } from '../http';
import { shownAmount } from './app-amounts';
import { answerAppRequest, listAppRequests, resendAppRequest, retrieveAppRequest, verifyAppRequest } from './app-requests';
import type {
  App,
  AppCurrency,
  AppAnswer,
  AppAnswerReceipt,
  AppRequest,
  AppRequestListParams,
  AppRequestDetail,
  AppRequestRecord,
  DeclareAppParams,
  DeclaredApp,
  RotatedApp,
  ShownAmount,
  VerifyAppRequestOptions,
} from '../record-types';
import type { AppStatus } from '../taxonomy';
import type { WebhookHeaders } from '../types';
import { SirenError, UnexpectedResponseError } from '../errors';
import { pickFields } from './create-fields';
import { deleteRecord, isJsonObject, readList, readObject, writeRecord } from './record-requests';

/*
 * Siren apps: a service the organization hosts that acts as part of Siren's
 * engine. Contract: docs/architecture/apps-cli.md. Siren's side:
 * docs/architecture/apps-records.md and apps-exchange.md in the Siren
 * repository.
 */

/** The longest answer Siren takes, in bytes of JSON (`AppRequestService::MAX_ANSWER_BYTES`). */
export const MAX_APP_ANSWER_BYTES = 16384;

/** How far a request's signed timestamp may be from the receiver's clock by default, either way. */
export const DEFAULT_APP_REQUEST_TOLERANCE_SECONDS = 300;

/**
 * The requests Siren sent the organization's apps (`/apps/requests`).
 *
 * `list()` and `resend()` take a signed-in admin's session token. `answer()`
 * takes the app's own API key, or an admin's session to answer by hand.
 */
export class AppRequestsResource {
  /** The filters `list()` sends, the one `GET /apps/requests` reads (ListAppRequests.php). */
  static readonly LIST_FILTERS = ['status'] as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * The org's latest requests, newest first, at most 50, from
   * `GET /apps/requests`, with `?status=` when `params.status` is given.
   * Siren answers `{ requests: [...] }` and this answers the list.
   *
   * Refuses with `SirenError` before sending: a key of `params` other than
   * `status`, or a status outside `AppRequestStatus`. Retries on a network
   * error, 429 or 5xx, as a read. Throws `UnexpectedResponseError` when the
   * 2xx body is not an object holding a `requests` array of objects.
   */
  async list(params: AppRequestListParams = {}): Promise<AppRequestRecord[]> {
    return listAppRequests(this.http, params, AppRequestsResource.LIST_FILTERS);
  }

  /**
   * One request by its id, with `GET /apps/requests/{id}`, however old: the
   * list's fields, the `data` Siren sent the app, the `answer` it took or
   * null, and `answeredByUser`, `{ id, email }` of the person who answered
   * by hand or null. The route takes an admin's session, as every app route
   * does. An app's key gets 401 `api_key_not_accepted`, raised as
   * `ApiKeyNotAcceptedError`.
   *
   * Refuses an `id` that is not `apr_` and 32 lowercase hex characters with
   * `SirenError` before sending. Retries on a network error, 429 or 5xx, as
   * a read. Siren answers 404 `app_request_not_found` for a request the
   * organization does not have, raised as `NotFoundError`
   * (GetAppRequest.php on Siren's feat/apps at 27169452a). Throws
   * `UnexpectedResponseError` when the 2xx body is not this request with an
   * object in `data`.
   */
  async retrieve(id: string): Promise<AppRequestDetail> {
    return retrieveAppRequest(this.http, id);
  }

  /**
   * Sends a request again under the same key, with
   * `POST /apps/requests/{id}/resend`, and answers the request as it now
   * stands. An ask gets a new answer window. A request that holds an answer
   * Siren has not applied, in `needs_attention` after its apply ran out of
   * tries or still `answered` because the wake after the answer was lost, is
   * not sent to the app again: Siren applies its stored answer, even while
   * the app is off.
   *
   * Refuses an `id` that is not `apr_` and 32 lowercase hex characters with
   * `SirenError` before sending. Sent once. Siren answers 409 with
   * `app_request_not_resendable` for a request that is `applied`, or one it
   * would send while its app is off, raised as `ConflictError`, and 404 for a
   * request the org does not have, raised as `NotFoundError`
   * (ResendAppRequest.php on Siren's feat/apps at 1557b0030).
   */
  async resend(id: string): Promise<AppRequestRecord> {
    return resendAppRequest(this.http, id);
  }

  /**
   * Posts the answer to an ask, with `POST /apps/requests/{id}/answer`. The
   * body is a new object holding `answer`'s own keys, so a `toJSON` the
   * answer inherits never reaches Siren.
   *
   * Refuses with `SirenError` before sending: an `id` that is not `apr_` and
   * 32 lowercase hex characters, an answer that is not a plain object, one
   * with no text `outcome`, or one longer than {@link MAX_APP_ANSWER_BYTES}
   * bytes as JSON.
   *
   * Sent once, as every write is. When the answer is lost, because the
   * connection dropped or Siren answered 5xx, the caller sends the same
   * answer again. Siren takes each answer once, so `duplicate: true` then
   * means the first one had already landed, and nothing more is applied.
   *
   * Answers `{ status: 'accepted', duplicate }`. Siren's refusals, each with
   * its code in `AppErrorCode` as the error's `code`: 409
   * `app_request_already_answered` as `ConflictError` (a different answer
   * came first, and it stands), 404 `app_request_not_found` as
   * `NotFoundError`, 403 `app_inactive` or `app_answer_forbidden` as
   * `PermissionError`, 422 `app_answer_invalid` as `ValidationError`, and 401
   * `app_answer_unauthorized` as `AuthenticationError`. Siren's key check
   * answers a missing or unknown bearer with 401 and no code, and this call
   * gives that 401 the code `app_answer_unauthorized` too. Throws
   * `UnexpectedResponseError` when a 2xx body is not `{ status: 'accepted' }`
   * with an optional boolean `duplicate`.
   */
  async answer(id: string, answer: AppAnswer): Promise<AppAnswerReceipt> {
    return answerAppRequest(this.http, id, answer, MAX_APP_ANSWER_BYTES);
  }
}

/** An app key, as Siren's `AppService::KEY_PATTERN` reads it. */
const APP_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The path of the app with this key, `/apps/{key}`. Throws `SirenError`
 * naming `method` before anything is sent when `key` is not lowercase letters
 * and digits joined by single dashes, at most 64 characters
 * (`AppsTable::KEY_LENGTH`), or is `requests`, which Siren keeps for
 * `/apps/requests` (`AppService::RESERVED_KEYS`).
 */
function appPath(key: unknown, method: string): string {
  if (typeof key !== 'string' || key.length > 64 || !APP_KEY.test(key) || key === 'requests') {
    const shown = typeof key === 'string' ? JSON.stringify(key) : String(key);
    throw new SirenError(
      `Siren: ${method} needs an app key of lowercase letters and digits joined by single dashes, ` +
        `at most 64 characters and never requests, and got ${shown}.`,
    );
  }
  return `/apps/${key}`;
}

/**
 * Why `body` is not an app as `AppSerializer::toArray()` gives one, or
 * `undefined` when it is: an object with a text `key` and an `items` list.
 */
function appProblem(body: unknown, route: string): string | undefined {
  return isJsonObject(body) && typeof body.key === 'string' && Array.isArray(body.items) ? undefined :
    `Siren answered ${route} with a body that is not an app.`;
}

/**
 * Siren apps (`/apps`): declare an app, read it, turn it on and off, rotate
 * its key and secret, delete it, and check each request Siren sends it.
 *
 * Every route but the answer route takes a signed-in admin's session token
 * as `accessToken`. Siren refuses an API key there with 401
 * `api_key_not_accepted`. An app key is lowercase letters and digits joined
 * by single dashes, at most 64 characters, and never `requests`. Each method
 * that takes one refuses any other with `SirenError` before sending.
 */
export class AppsResource {
  /** The fields `declare()` sends, the six `PUT /apps/{key}` reads (DeclareApp.php). */
  static readonly DECLARE_FIELDS = ['name', 'description', 'url', 'scopes', 'events', 'items'] as const;
  /** The fields `declare()` sends for each item, the six Siren stores (apps-records.md, "Item settings"). */
  static readonly ITEM_FIELDS = ['kind', 'key', 'name', 'description', 'currencies', 'answerWindowMinutes'] as const;

  /** The requests Siren sent the org's apps. */
  readonly requests: AppRequestsResource;

  constructor(private readonly http: HttpTransport) {
    this.requests = new AppRequestsResource(http);
  }

  /**
   * Declares the app with this key from its whole description, with
   * `PUT /apps/{key}`, sent once.
   *
   * The first call makes the app, its API key and its webhook subscription,
   * and Siren answers 201 with `rawKey` and `signingSecret`, which it never
   * shows again. This answers them with `created: true`. Every later call
   * updates the app in place and answers `created: false` with no secret.
   * Sending the same declaration again after a lost answer changes nothing,
   * but a lost first answer loses the secrets: rotate to get new ones.
   *
   * Sends a new object of {@link DECLARE_FIELDS}, and each item as a new
   * object of {@link ITEM_FIELDS}. Refuses with `SirenError` before sending:
   * a bad app key, any other field or item field whatever its value, no
   * `name` or `url`, `items` that is not an array, or an item that is not an
   * object or lacks `kind`, `key` or `name`. Siren checks the rest and
   * answers 400 or 422 with the field, raised as `BadRequestError` or
   * `ValidationError`, and 403 with `data.reason` `app_limit_reached` when
   * the plan has no room.
   *
   * Throws `UnexpectedResponseError` when a 2xx body is not an app (an object
   * with a text `key` and an `items` array), or holds only one of `rawKey`
   * and `signingSecret`. Its `statusCode` is unset, since `writeRecord`
   * answers the body alone. Siren had accepted the write, so read the app
   * with `retrieve()` before sending it again.
   */
  async declare(key: string, params: DeclareAppParams): Promise<DeclaredApp> {
    const path = appPath(key, 'apps.declare()');
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.declare() needs the app as an object.');
    const sent = pickFields(params, AppsResource.DECLARE_FIELDS, (field) => `Siren: apps.declare() does not take ${field}.`);
    if (sent.name == null || sent.url == null) throw new SirenError('Siren: apps.declare() needs a name and a url.');
    if (sent.items !== undefined) {
      if (!Array.isArray(sent.items)) throw new SirenError('Siren: apps.declare() takes items as a list.');
      sent.items = (sent.items as unknown[]).map((item, index) => {
        if (!isJsonObject(item)) throw new SirenError(`Siren: apps.declare() needs item ${index} as an object.`);
        const copy = pickFields(item, AppsResource.ITEM_FIELDS, (field) => `Siren: apps.declare() does not take ${field} on an item.`);
        for (const field of ['kind', 'key', 'name']) {
          if (copy[field] == null) throw new SirenError(`Siren: apps.declare() needs a ${field} on item ${index}.`);
        }
        return copy;
      });
    }

    const app = await writeRecord<Record<string, unknown>>(this.http, 'PUT', path, sent);
    const problem = appProblem(app, `PUT ${path}`);
    if (problem !== undefined) throw new UnexpectedResponseError(problem, { data: app });
    const created = app.rawKey !== undefined || app.signingSecret !== undefined;
    if (created && (typeof app.rawKey !== 'string' || typeof app.signingSecret !== 'string')) {
      throw new UnexpectedResponseError(
        `Siren answered PUT ${path} without both rawKey and signingSecret as text, so the new app's secrets are lost. Rotate to get new ones.`,
        { data: app },
      );
    }
    return { ...app, created } as DeclaredApp;
  }

  /**
   * The org's apps, on and off, ordered by id, each with its items, from
   * `GET /apps`. Retries on a network error, 429 or 5xx, as a read. Throws
   * `UnexpectedResponseError` when the 2xx body is not an array of apps,
   * each an object with a text `key` and an `items` array.
   */
  async list(): Promise<App[]> {
    return readList<App>(this.http, '/apps', (rows) =>
      rows.map((row) => appProblem(row, 'GET /apps')).find((problem) => problem !== undefined),
    );
  }

  /**
   * One app with its items, from `GET /apps/{key}`. Retries as a read.
   * Siren answers 404 for a key the org lacks, raised as `NotFoundError`.
   * Refuses a bad app key with `SirenError` before sending. Throws
   * `UnexpectedResponseError` when the 2xx body is not an app.
   */
  async retrieve(key: string): Promise<App> {
    const path = appPath(key, 'apps.retrieve()');
    return readObject<App>(this.http, path, {}, (body) => appProblem(body, `GET ${path}`));
  }

  /**
   * Turns the app on (`active`) or off (`inactive`) with
   * `POST /apps/{key}/status`, sent once, and answers the app. Refuses a bad
   * app key or any other status with `SirenError` before sending. An off
   * app's items leave every picker and Siren sends it nothing. Turning one
   * on checks the plan's room again, and Siren answers 403 with `data.reason`
   * `app_limit_reached` when it has none. Throws `UnexpectedResponseError`
   * when the 2xx body is not an app.
   */
  async setStatus(key: string, status: AppStatus): Promise<App> {
    const path = `${appPath(key, 'apps.setStatus()')}/status`;
    if (status !== 'active' && status !== 'inactive') throw new SirenError('Siren: apps.setStatus() takes active or inactive.');
    const app = await writeRecord<App>(this.http, 'POST', path, { status });
    const problem = appProblem(app, `POST ${path}`);
    if (problem !== undefined) throw new UnexpectedResponseError(problem, { data: app });
    return app;
  }

  /**
   * Gives the app a new API key and signing secret with
   * `POST /apps/{key}/rotate`, sent once. Siren revokes the old key at once
   * and signs every later request with the new secret only. Answers the app
   * with `rawKey` and `signingSecret`, shown this once. Refuses a bad app key
   * with `SirenError` before sending. Throws `UnexpectedResponseError` when
   * the 2xx body is not an app or lacks either secret. Siren had rotated the
   * key by then, so rotate again to get a pair you can read.
   */
  async rotate(key: string): Promise<RotatedApp> {
    const path = `${appPath(key, 'apps.rotate()')}/rotate`;
    const app = await writeRecord<Record<string, unknown>>(this.http, 'POST', path, undefined);
    const problem = appProblem(app, `POST ${path}`);
    if (problem !== undefined) throw new UnexpectedResponseError(problem, { data: app });
    if (typeof app.rawKey !== 'string' || typeof app.signingSecret !== 'string') {
      throw new UnexpectedResponseError(`Siren answered POST ${path} without the new rawKey and signingSecret.`, { data: app });
    }
    return app as unknown as RotatedApp;
  }

  /**
   * Deletes an app no record selects and with no open ask, with
   * `DELETE /apps/{key}`, sent once. Siren revokes its key and deletes its
   * items and subscription. Its requests stay readable. Refuses a bad app key
   * with `SirenError` before sending. Siren answers 409, raised as
   * `ConflictError` with `data.reason` `app_in_use` and `data.uses`, while a
   * record selects one of its items or an ask is open, and 404 for a key the
   * org lacks, raised as `NotFoundError`. Read the code with `appErrorCode()`.
   */
  async delete(key: string): Promise<void> {
    await deleteRecord(this.http, appPath(key, 'apps.delete()'));
  }

  /**
   * Checks a request Siren sent the app and answers it parsed. Call it in the
   * app's handler with the exact bytes received.
   *
   * Siren signs every request with
   * `X-Siren-Signature-V2: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`
   * under the app's signing secret. This verifies one `v1` against the raw
   * body and the signed `t`, in constant time, and refuses a `t` more than
   * `toleranceSeconds` (default {@link DEFAULT_APP_REQUEST_TOLERANCE_SECONDS})
   * from `now` either way, so a captured request cannot be replayed later.
   * It never falls back to the older `X-Siren-Signature`, which signs no
   * time.
   *
   * Throws `SignatureVerificationError` when the V2 header is missing or
   * malformed, no signature matches, the timestamp is too far off,
   * `X-Siren-Timestamp` is present and differs from the signed `t`,
   * `X-Siren-Event` is present and is not `app.request` (an ordinary
   * webhook, which `webhooks.constructEvent()` reads), or the body is not
   * an app request envelope of version 1. Throws `SirenError`, before any
   * check, for an empty secret or a `toleranceSeconds` that is not a whole
   * number from 1 to 3600.
   *
   * Siren may deliver one request more than once. Drop a repeat by the
   * returned `id`, never by the unsigned `Idempotency-Key` header.
   */
  verifyRequest(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    options: VerifyAppRequestOptions = {},
  ): AppRequest {
    return verifyAppRequest(rawBody, headers, secret, options, DEFAULT_APP_REQUEST_TOLERANCE_SECONDS);
  }

  /**
   * The amount a person reads from a stored `value` and its `currency`, as
   * a tell carries them: `reward.value` and `reward.currency` on an approved
   * conversion, `allocation.value` and `allocation.currency` on a completed
   * allocation. `value` is the stored integer, and the shown amount is
   * `value / 10^currency.scale`, so 1500 in dollars is $15.00, 10000 in yen
   * is ¥100, and 10000 in a points currency at scale 0 is 10,000 points.
   *
   * Answers `{ amount, decimal, text }`, the three ways Siren's own
   * `CurrencyAmountService` reads an amount: a number for arithmetic, plain
   * text with the currency's decimal places, and the text the dashboard
   * shows. Sends nothing.
   *
   * Throws `SirenError` naming the field for a `value` that is not a safe
   * integer, a currency that is not an object, a `scale` outside 0 to 8, or
   * `decimalPlaces` outside 0 to the scale.
   */
  shownAmount(value: number, currency: AppCurrency): ShownAmount {
    return shownAmount(value, currency, 'apps.shownAmount()');
  }
}
