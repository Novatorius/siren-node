import type { HttpTransport } from '../http';
import { answerAppRequest, listAppRequests, resendAppRequest, verifyAppRequest } from './app-requests';
import type {
  App,
  AppAnswer,
  AppAnswerReceipt,
  AppRequest,
  AppRequestListParams,
  AppRequestRecord,
  DeclareAppParams,
  DeclaredApp,
  RotatedApp,
  VerifyAppRequestOptions,
} from '../record-types';
import type { AppStatus } from '../taxonomy';
import type { WebhookHeaders } from '../types';

/*
 * Siren apps: a service the organization hosts that acts as part of Siren's
 * engine. Contract: docs/architecture/apps-cli.md. Siren's side:
 * docs/architecture/apps-records.md and apps-exchange.md in the Siren
 * repository.
 *
 * Stub. Every body below returns a valid empty value and never throws. The
 * packet named in each docblock builds it.
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
   *
   * Packet sdk-requests.
   */
  async list(params: AppRequestListParams = {}): Promise<AppRequestRecord[]> {
    return listAppRequests(this.http, params, AppRequestsResource.LIST_FILTERS);
  }

  /**
   * Sends a request again under the same key, with
   * `POST /apps/requests/{id}/resend`, and answers the request as it now
   * stands. An ask gets a new answer window. A request whose answer failed
   * to apply is not sent to the app again: Siren applies its stored answer.
   *
   * Refuses an `id` that is not `apr_` and 32 lowercase hex characters with
   * `SirenError` before sending. Sent once. Siren answers 409 with
   * `app_request_not_resendable` for a request that is answered or applied,
   * or whose app is off, raised as `ConflictError`, and 404 for a request the
   * org does not have, raised as `NotFoundError`.
   *
   * Packet sdk-requests.
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
   * `app_answer_unauthorized` as `AuthenticationError`. Throws
   * `UnexpectedResponseError` when a 2xx body is not `{ status: 'accepted' }`
   * with an optional boolean `duplicate`.
   *
   * Packet sdk-answer.
   */
  async answer(id: string, answer: AppAnswer): Promise<AppAnswerReceipt> {
    return answerAppRequest(this.http, id, answer, MAX_APP_ANSWER_BYTES);
  }
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
   * and `signingSecret`.
   *
   * Packet sdk-apps.
   */
  async declare(key: string, params: DeclareAppParams): Promise<DeclaredApp> {
    void key;
    void params;
    return {} as DeclaredApp;
  }

  /**
   * The org's apps, on and off, ordered by id, each with its items, from
   * `GET /apps`. Retries on a network error, 429 or 5xx, as a read. Throws
   * `UnexpectedResponseError` when the 2xx body is not an array of objects.
   *
   * Packet sdk-apps.
   */
  async list(): Promise<App[]> {
    return [];
  }

  /**
   * One app with its items, from `GET /apps/{key}`. Retries as a read.
   * Siren answers 404 for a key the org lacks, raised as `NotFoundError`.
   * Throws `UnexpectedResponseError` when the 2xx body is not an object.
   *
   * Packet sdk-apps.
   */
  async retrieve(key: string): Promise<App> {
    void key;
    return {} as App;
  }

  /**
   * Turns the app on (`active`) or off (`inactive`) with
   * `POST /apps/{key}/status`, sent once, and answers the app. Refuses any
   * other status with `SirenError` before sending. An off app's items leave
   * every picker and Siren sends it nothing. Turning one on checks the plan's
   * room again.
   *
   * Packet sdk-apps.
   */
  async setStatus(key: string, status: AppStatus): Promise<App> {
    void key;
    void status;
    return {} as App;
  }

  /**
   * Gives the app a new API key and signing secret with
   * `POST /apps/{key}/rotate`, sent once. Siren revokes the old key at once
   * and signs every later request with the new secret only. Answers the app
   * with `rawKey` and `signingSecret`, shown this once. Throws
   * `UnexpectedResponseError` when the 2xx body lacks either.
   *
   * Packet sdk-apps.
   */
  async rotate(key: string): Promise<RotatedApp> {
    void key;
    return {} as RotatedApp;
  }

  /**
   * Deletes an app no record selects and with no open ask, with
   * `DELETE /apps/{key}`, sent once. Siren revokes its key and deletes its
   * items and subscription. Its requests stay readable. Siren answers 409,
   * raised as `ConflictError` with `data.reason` `app_in_use` and
   * `data.uses`, while a record selects one of its items or an ask is open.
   *
   * Packet sdk-apps.
   */
  async delete(key: string): Promise<void> {
    void key;
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
   *
   * Packet sdk-verify.
   */
  verifyRequest(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    options: VerifyAppRequestOptions = {},
  ): AppRequest {
    return verifyAppRequest(rawBody, headers, secret, options, DEFAULT_APP_REQUEST_TOLERANCE_SECONDS);
  }
}
