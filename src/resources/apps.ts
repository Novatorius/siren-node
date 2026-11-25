import type { HttpTransport } from '../http';
import { shownAmount, splitPool } from './app-amounts';
import { createAppRequestHandler } from './app-request-handler';
import type { AppRequestHandler, AppRequestHandlerOptions, AppRequestHandlerWith } from './app-request-handler';
import { answerAppRequest, listAppRequests, resendAppRequest, retrieveAppRequest, verifyAppRequest } from './app-requests';
import type {
  App,
  AppCurrency,
  AppFeatureKindEntry,
  AppFeaturePage,
  AppWithRawKey,
  AppWithSigningSecret,
  CreateAppFeatureParams,
  CreateAppParams,
  CreatedApp,
  RemovedAppFeature,
  UpdateAppFeatureParams,
  UpdateAppParams,
  UpdatedApp,
  AppAnswer,
  AppAnswerReceipt,
  AppRequest,
  AppRequestListParams,
  AppRequestDetail,
  AppRequestRecord,
  DeclareAppParams,
  DeclaredApp,
  ShownAmount,
  AppSplitPool,
  AppSplitWeights,
  VerifyAppRequestOptions,
} from '../record-types';
import type { AppStatus } from '../taxonomy';
import type { ApiKeyScopeGroups, WebhookCatalogEntry, WebhookDelivery, WebhookHeaders, WebhookTestResult } from '../types';
import { SirenError, UnexpectedResponseError } from '../errors';
import { pickFields } from './create-fields';
import { deleteRecord, isJsonObject, readList, readObject, recordId, writeRecord } from './record-requests';

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
  /** The filters `list()` sends, the ones `GET /apps/requests` reads (ListAppRequests.php at feat/apps 0383186437). */
  static readonly LIST_FILTERS = ['status', 'limit', 'before'] as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * The org's latest requests, newest first, from `GET /apps/requests`:
   * `params.limit` of them, 1 to 100, or 50 without it, older than the
   * request `params.before` names when it is given, and of `params.status`
   * when that is given. Siren answers `{ requests: [...] }` and this
   * answers the list. To read every request, pass the last id of each page
   * as the next page's `before` until a page holds fewer than `limit`.
   *
   * Refuses with `SirenError` before sending: a key of `params` other than
   * these three, a status outside `AppRequestStatus`, a limit outside 1 to
   * 100, a `before` that is not a request id, and `limit` or `before` with
   * `needs_attention`, whose list Siren does not page. Retries on a network
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
   * came first, and it stands), 409 `app_request_dropped` as `ConflictError`
   * (Siren stopped waiting for the ask), 404 `app_request_not_found` as
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
 * The words Siren keeps for its own app routes, `AppService::RESERVED_KEYS`
 * on Siren's int/preview-apps at a22547327: `/apps/requests`, `/apps/events`,
 * `/apps/scopes` and `/apps/kinds`. No app holds one as its key.
 */
export const RESERVED_APP_KEYS = ['requests', 'events', 'scopes', 'kinds'] as const;

/** The payout kind's old stored value, which Siren refuses since it renamed the kind `payoutMethod`. */
const OLD_PAYOUT_KIND = 'fulfillmentMethod';

/**
 * The path of the app with this key, `/apps/{key}`. Throws `SirenError`
 * naming `method` before anything is sent when `key` is not lowercase letters
 * and digits joined by single dashes, at most 64 characters
 * (`AppsTable::KEY_LENGTH`), or is one of {@link RESERVED_APP_KEYS}.
 */
function appPath(key: unknown, method: string): string {
  if (typeof key !== 'string' || key.length > 64 || !APP_KEY.test(key) || (RESERVED_APP_KEYS as readonly string[]).includes(key)) {
    const shown = typeof key === 'string' ? JSON.stringify(key) : String(key);
    throw new SirenError(
      `Siren: ${method} needs an app key of lowercase letters and digits joined by single dashes, ` +
        `at most 64 characters and never ${RESERVED_APP_KEYS.join(', ')}, and got ${shown}.`,
    );
  }
  return `/apps/${key}`;
}

/**
 * Why `body` is not an app as `AppSerializer::toArray()` gives one, or
 * `undefined` when it is: an object with a text `key` and a `features` list.
 */
function appProblem(body: unknown, route: string): string | undefined {
  return isJsonObject(body) && typeof body.key === 'string' && Array.isArray(body.features) ? undefined :
    `Siren answered ${route} with a body that is not an app.`;
}

/**
 * The body an `UnexpectedResponseError` keeps as `data`, without the raw key
 * and signing secret Siren shows once, so a caller that logs the error never
 * logs a secret. The message never held them.
 */
function withoutSecrets(body: unknown): unknown {
  if (!isJsonObject(body) || (!('rawKey' in body) && !('signingSecret' in body))) return body;
  const { rawKey: _rawKey, signingSecret: _signingSecret, ...rest } = body;
  return rest;
}

/** Throws `UnexpectedResponseError` when `body` is not an app. */
function checkApp(body: unknown, route: string): void {
  const problem = appProblem(body, route);
  if (problem !== undefined) throw new UnexpectedResponseError(problem, { data: withoutSecrets(body) });
}

/**
 * Throws `UnexpectedResponseError` when `body` holds `field` and it is not
 * text, or when `required` and it is missing. Siren had done the write by
 * then, so `then` says what to do about the secret it lost.
 */
function checkSecret(body: Record<string, unknown>, field: 'rawKey' | 'signingSecret', route: string, required: boolean, then: string): void {
  if (body[field] === undefined && !required) return;
  if (typeof body[field] !== 'string') {
    throw new UnexpectedResponseError(`Siren answered ${route} without ${field} as text, so it is lost. ${then}`, { data: withoutSecrets(body) });
  }
}

/**
 * A feature's `kind` before it is sent: `SirenError` for the payout kind's
 * old value, which Siren refuses, naming the new one. Any other value goes
 * to Siren, which checks it.
 */
function checkKind(kind: unknown, method: string, where: string): void {
  if (kind === OLD_PAYOUT_KIND) {
    throw new SirenError(`Siren: ${method} needs kind payoutMethod${where}. Siren renamed fulfillmentMethod to payoutMethod, the documentation's word.`);
  }
}

/** Sends a write once and answers the app with the one secret it made, checked. */
async function writeWithSecret<T extends App>(
  http: HttpTransport,
  path: string,
  method: 'POST',
  body: unknown,
  field: 'rawKey' | 'signingSecret',
  then: string,
): Promise<T> {
  const route = `${method} ${path}`;
  const app = await writeRecord<Record<string, unknown>>(http, method, path, body);
  checkApp(app, route);
  checkSecret(app, field, route, true, then);
  return app as unknown as T;
}

/**
 * One app's features, through their own routes
 * (`/apps/{app}/features`), so the dashboard and code can add one without
 * declaring the whole app. A feature's kind and key lock once Siren makes
 * it. Every route takes a signed-in admin's session, and a member limited
 * to some stores gets 403 `org_access_required`, reads included, since a
 * feature's page names the records that select it.
 */
export class AppFeaturesResource {
  /** The fields `create()` sends, those `POST /apps/{app}/features` reads (AddAppItem.php). */
  static readonly CREATE_FIELDS = ['kind', 'key', 'name', 'description', 'currencies', 'answerWindowMinutes', 'scoresMoney', 'conversionTypes', 'fields', 'domains'] as const;
  /** The fields `update()` sends. `PATCH /apps/{app}/features/{id}` refuses a changed kind or key with 422. */
  static readonly UPDATE_FIELDS = ['name', 'description', 'currencies', 'answerWindowMinutes', 'scoresMoney', 'conversionTypes', 'fields', 'domains'] as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * Adds one feature to the app with `POST /apps/{app}/features`, sent once,
   * and answers it with `uses` and `usedBy`. Siren answers 201, or 200 when
   * an archived feature of the same kind and key came back with the new
   * fields. The feature is checked by the rules a declaration's feature
   * meets.
   *
   * Refuses with `SirenError` before sending: a bad app key, params that are
   * not an object, any field but {@link CREATE_FIELDS}, no `kind` or `name`,
   * and the old kind `fulfillmentMethod`. With no `key`, the body carries
   * none and Siren makes it from the name, unique within the app. Siren answers 422 with the
   * field for the rest, 409 `app_features_need_key_and_address` with
   * `data.missing` when the app lacks a key or an address, and 404 for an
   * app the organization lacks. Throws `UnexpectedResponseError` when the
   * 2xx body is not a feature.
   */
  async create(appKey: string, params: CreateAppFeatureParams): Promise<AppFeaturePage> {
    const path = `${appPath(appKey, 'apps.features.create()')}/features`;
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.features.create() needs the feature as an object.');
    const sent = pickFields(params, AppFeaturesResource.CREATE_FIELDS, (field) => `Siren: apps.features.create() does not take ${field}.`);
    for (const field of ['kind', 'name']) {
      if (sent[field] == null) throw new SirenError(`Siren: apps.features.create() needs a ${field}.`);
    }
    checkKind(sent.kind, 'apps.features.create()', '');
    const feature = await writeRecord<Record<string, unknown>>(this.http, 'POST', path, sent);
    return checkedFeature(feature, `POST ${path}`);
  }

  /**
   * One feature by its id, with `uses`, how many records select it, and
   * `usedBy`, up to 100 of them, from `GET /apps/{app}/features/{id}`. Retries
   * as a read. Siren answers 404 for a feature another app holds. Refuses a
   * bad app key or id with `SirenError` before sending.
   */
  async retrieve(appKey: string, id: number): Promise<AppFeaturePage> {
    const path = `${appPath(appKey, 'apps.features.retrieve()')}/features/${recordId(id, 'apps.features.retrieve')}`;
    return readObject<AppFeaturePage>(this.http, path, {}, (body) => featureProblem(body, `GET ${path}`));
  }

  /**
   * Changes a feature's name, description or settings with
   * `PATCH /apps/{app}/features/{id}`, sent once, and answers it. A field left
   * out keeps its value. Refuses with `SirenError` before sending: a bad app
   * key or id, params that are not an object, and any field but
   * {@link UPDATE_FIELDS}, `kind` and `key` included, since a feature's kind
   * and key never change.
   */
  async update(appKey: string, id: number, params: UpdateAppFeatureParams): Promise<AppFeaturePage> {
    const path = `${appPath(appKey, 'apps.features.update()')}/features/${recordId(id, 'apps.features.update')}`;
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.features.update() needs the change as an object.');
    const sent = pickFields(params, AppFeaturesResource.UPDATE_FIELDS, (field) =>
      field === 'kind' || field === 'key'
        ? `Siren: apps.features.update() cannot change ${field}. A feature's kind and key never change once Siren makes it.`
        : `Siren: apps.features.update() does not take ${field}.`,
    );
    const feature = await writeRecord<Record<string, unknown>>(this.http, 'PATCH', path, sent);
    return checkedFeature(feature, `PATCH ${path}`);
  }

  /**
   * Removes a feature with `DELETE /apps/{app}/features/{id}`, sent once.
   * Siren archives it while a record selects it and answers
   * `{ archived: true, feature }`, and deletes it otherwise and answers
   * `{ archived: false, feature: null }`. Refuses a bad app key or id with
   * `SirenError` before sending. Throws `UnexpectedResponseError` for any
   * other 2xx body.
   */
  async delete(appKey: string, id: number): Promise<RemovedAppFeature> {
    const path = `${appPath(appKey, 'apps.features.delete()')}/features/${recordId(id, 'apps.features.delete')}`;
    const body = await deleteRecord<Record<string, unknown>>(this.http, path);
    const fits = body !== null && typeof body.archived === 'boolean' && (body.feature === null || featureProblem(body.feature, '') === undefined);
    if (!fits) throw new UnexpectedResponseError(`Siren answered DELETE ${path} with a body that is not { archived, feature }.`, { data: body });
    return body as unknown as RemovedAppFeature;
  }
}

/** Why `body` is not a feature with a numeric `id`, a text `kind` and `key`, or `undefined` when it is. */
function featureProblem(body: unknown, route: string): string | undefined {
  return isJsonObject(body) && typeof body.id === 'number' && typeof body.kind === 'string' && typeof body.key === 'string'
    ? undefined
    : `Siren answered ${route} with a body that is not a feature.`;
}

function checkedFeature(body: Record<string, unknown>, route: string): AppFeaturePage {
  const problem = featureProblem(body, route);
  if (problem !== undefined) throw new UnexpectedResponseError(problem, { data: body });
  return body as unknown as AppFeaturePage;
}

/**
 * Siren apps (`/apps`). An app is the container for its API key, its
 * address and its features, as a Slack app is: declare an app from its
 * file, make one from the dashboard's door, change it, make, rotate and
 * revoke its key, rotate its signing secret, send it a test, read its
 * delivery log, turn it on and off, delete it, and check each request
 * Siren sends it.
 *
 * Every route but the answer route takes a signed-in admin's session token
 * as `accessToken`. Siren refuses an API key there with 401
 * `api_key_not_accepted`, and a member limited to some stores with 403
 * `org_access_required` on every write. An app key is lowercase letters
 * and digits joined by single dashes, at most 64 characters, and never one
 * of {@link RESERVED_APP_KEYS}. Each method that takes one refuses any
 * other with `SirenError` before sending.
 */
export class AppsResource {
  /** The fields `declare()` sends, the seven `PUT /apps/{key}` reads (DeclareApp.php). */
  static readonly DECLARE_FIELDS = ['name', 'description', 'url', 'scopes', 'events', 'contacts', 'features'] as const;
  /** The fields `declare()` sends for each feature, those Siren stores (apps-records.md, "Item settings"), a custom event's `fields` and `domains` included. */
  static readonly FEATURE_FIELDS = ['kind', 'key', 'name', 'description', 'currencies', 'answerWindowMinutes', 'scoresMoney', 'conversionTypes', 'fields', 'domains'] as const;
  /** The fields `create()` sends, those `POST /apps` reads but `features`, which it refuses (CreateApp.php). */
  static readonly CREATE_FIELDS = ['name', 'description', 'url', 'scopes', 'events', 'contacts'] as const;
  /** The fields `update()` sends, those `PATCH /apps/{key}` reads but `features`, which it refuses (EditApp.php). */
  static readonly UPDATE_FIELDS = ['name', 'description', 'url', 'events', 'scopes', 'contacts'] as const;

  /** The requests Siren sent the org's apps. */
  readonly requests: AppRequestsResource;
  /** One app's features, through their own routes. */
  readonly features: AppFeaturesResource;

  constructor(private readonly http: HttpTransport) {
    this.requests = new AppRequestsResource(http);
    this.features = new AppFeaturesResource(http);
  }

  /**
   * Declares the app with this key from its whole description, with
   * `PUT /apps/{key}`, sent once. The file's door: an app it makes has
   * `source` `code`.
   *
   * The first call makes the app and its API key, and an address when
   * `url` is given. Siren answers 201 with `rawKey`, and `signingSecret`
   * when it made an address, each shown this once. This answers them with
   * `created: true`. Every later call updates the app in place and answers
   * `created: false`. A later call never makes or revokes a key: its
   * `scopes` reach only an active key. A `url` the app had no address for
   * makes one and answers `signingSecret` once, and no `url` removes the
   * address and its delivery log. A feature the call leaves out is archived
   * while a record selects it and deleted otherwise. Sending the same
   * declaration again after a lost answer changes nothing, but a lost first
   * answer loses the secrets: rotate to get new ones.
   *
   * Sends a new object of {@link DECLARE_FIELDS}, and each feature as a new
   * object of {@link FEATURE_FIELDS}. Refuses with `SirenError` before sending:
   * a bad app key, any other field or feature field whatever its value,
   * `items`, the features' name before Siren's rename, no
   * `name`, `features` that is not an array, a feature that is not an object or
   * lacks `kind`, `key` or `name`, the old kind `fulfillmentMethod`, and
   * features other than custom events with no `url`, which Siren refuses with 422
   * `app_features_need_key_and_address`, since it asks the app at its address.
   * Siren checks the rest and answers 400 or 422 with the field, raised as
   * `BadRequestError` or `ValidationError`, and 400 `app_cap_reached` when
   * the organization holds its cap of apps.
   *
   * Throws `UnexpectedResponseError` when a 2xx body is not an app (an object
   * with a text `key` and a `features` array), or holds `rawKey` or
   * `signingSecret` as anything but text. Its `statusCode` is unset, since
   * `writeRecord` answers the body alone. Siren had accepted the write, so
   * read the app with `retrieve()` before sending it again.
   */
  async declare(key: string, params: DeclareAppParams): Promise<DeclaredApp> {
    const path = appPath(key, 'apps.declare()');
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.declare() needs the app as an object.');
    const sent = pickFields(params, AppsResource.DECLARE_FIELDS, (field) =>
      field === 'items'
        ? 'Siren: apps.declare() does not take items. Siren calls an app\'s features "features" now. Send them under features.'
        : `Siren: apps.declare() does not take ${field}.`,
    );
    if (sent.name == null) throw new SirenError('Siren: apps.declare() needs a name.');
    if (sent.features !== undefined) {
      if (!Array.isArray(sent.features)) throw new SirenError('Siren: apps.declare() takes features as a list.');
      sent.features = (sent.features as unknown[]).map((feature, index) => {
        if (!isJsonObject(feature)) throw new SirenError(`Siren: apps.declare() needs feature ${index} as an object.`);
        const copy = pickFields(feature, AppsResource.FEATURE_FIELDS, (field) => `Siren: apps.declare() does not take ${field} on a feature.`);
        for (const field of ['kind', 'key', 'name']) {
          if (copy[field] == null) throw new SirenError(`Siren: apps.declare() needs a ${field} on feature ${index}.`);
        }
        checkKind(copy.kind, 'apps.declare()', ` on feature ${index}`);
        return copy;
      });
      // Features with no url go to Siren, which takes them on a sandbox, where siren listen carries the
      // requests, and refuses them on live with a 422 that names the url.
    }

    const route = `PUT ${path}`;
    const app = await writeRecord<Record<string, unknown>>(this.http, 'PUT', path, sent);
    checkApp(app, route);
    const created = app.rawKey !== undefined;
    checkSecret(app, 'rawKey', route, false, 'Rotate the key with apps.rotateKey() to get a new one.');
    checkSecret(app, 'signingSecret', route, false, 'Rotate the secret with apps.rotateSecret() to get a new one.');
    return { ...app, created } as DeclaredApp;
  }

  /**
   * Makes an app from the dashboard's door with `POST /apps`, sent once.
   * Siren picks its key from the name, makes a key when `scopes` is a list,
   * even `[]`, and an address when `url` is given, and answers 201 with
   * `rawKey` and `signingSecret` for the parts it made, each shown this
   * once. The app has `source` `dashboard`. Add features with
   * {@link features}.
   *
   * Refuses with `SirenError` before sending: params that are not an object,
   * no `name`, `features`, and any other field but {@link CREATE_FIELDS}. Siren
   * answers 422 `app_needs_a_part` for an app with neither part, 422 on
   * `events` with no `url`, and 400 `app_cap_reached` at the cap. Throws
   * `UnexpectedResponseError` when the 2xx body is not an app or holds a
   * secret that is not text.
   */
  async create(params: CreateAppParams): Promise<CreatedApp> {
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.create() needs the app as an object.');
    const sent = pickFields(params, AppsResource.CREATE_FIELDS, (field) =>
      field === 'features' || field === 'items'
        ? `Siren: apps.create() does not take ${field}. Add each feature with apps.features.create() once the app has a key and an address.`
        : `Siren: apps.create() does not take ${field}.`,
    );
    if (sent.name == null) throw new SirenError('Siren: apps.create() needs a name.');
    const route = 'POST /apps';
    const app = await writeRecord<Record<string, unknown>>(this.http, 'POST', '/apps', sent);
    checkApp(app, route);
    checkSecret(app, 'rawKey', route, false, 'Rotate the key with apps.rotateKey() to get a new one.');
    checkSecret(app, 'signingSecret', route, false, 'Rotate the secret with apps.rotateSecret() to get a new one.');
    return app as unknown as CreatedApp;
  }

  /**
   * Changes the fields sent with `PATCH /apps/{key}`, sent once, and
   * answers the app. The edit page's door. `url` moves the address and
   * keeps its id and secret, or makes one and answers `signingSecret` once.
   * `url: null` removes the address. `events` needs an address and `scopes`
   * a key. It never makes, rotates or revokes a key. An empty change writes
   * nothing.
   *
   * Refuses with `SirenError` before sending: a bad app key, params that are
   * not an object, `features`, and any other field but {@link UPDATE_FIELDS}.
   * Siren answers 409 `app_key_missing` for `scopes` on an app with no key,
   * 409 `app_address_missing` for `events` on an app with no address, 409
   * `app_needs_a_part` for a change that would leave neither, and 409
   * `app_features_need_key_and_address` for a change that would take the
   * address of an app with features.
   */
  async update(key: string, params: UpdateAppParams): Promise<UpdatedApp> {
    const path = appPath(key, 'apps.update()');
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.update() needs the change as an object.');
    const sent = pickFields(params, AppsResource.UPDATE_FIELDS, (field) =>
      field === 'features' || field === 'items'
        ? `Siren: apps.update() does not take ${field}. Change each feature with apps.features.update().`
        : `Siren: apps.update() does not take ${field}.`,
    );
    const route = `PATCH ${path}`;
    const app = await writeRecord<Record<string, unknown>>(this.http, 'PATCH', path, sent);
    checkApp(app, route);
    checkSecret(app, 'signingSecret', route, false, 'Rotate the secret with apps.rotateSecret() to get a new one.');
    return app as unknown as UpdatedApp;
  }

  /**
   * The org's apps, on and off, ordered by id, each with its features, from
   * `GET /apps`. Retries on a network error, 429 or 5xx, as a read. Throws
   * `UnexpectedResponseError` when the 2xx body is not an array of apps,
   * each an object with a text `key` and a `features` array.
   */
  async list(): Promise<App[]> {
    return readList<App>(this.http, '/apps', (rows) =>
      rows.map((row) => appProblem(row, 'GET /apps')).find((problem) => problem !== undefined),
    );
  }

  /**
   * One app with its key, address and features, from `GET /apps/{key}`,
   * each field in the shape a file declares it, so a tool can compare a
   * file with it. Retries as a read. Siren answers 404 for a key the org
   * lacks, raised as `NotFoundError`. Refuses a bad app key with
   * `SirenError` before sending. Throws `UnexpectedResponseError` when the
   * 2xx body is not an app.
   */
  async retrieve(key: string): Promise<App> {
    const path = appPath(key, 'apps.retrieve()');
    return readObject<App>(this.http, path, {}, (body) => appProblem(body, `GET ${path}`));
  }

  /**
   * Turns the app on (`active`) or off (`inactive`) with
   * `POST /apps/{key}/status`, sent once, and answers the app. Refuses a bad
   * app key or any other status with `SirenError` before sending. An off
   * app's features leave every picker, its address is paused, and Siren sends
   * it nothing. Throws `UnexpectedResponseError` when the 2xx body is not an
   * app.
   */
  async setStatus(key: string, status: AppStatus): Promise<App> {
    const path = `${appPath(key, 'apps.setStatus()')}/status`;
    if (status !== 'active' && status !== 'inactive') throw new SirenError('Siren: apps.setStatus() takes active or inactive.');
    const app = await writeRecord<App>(this.http, 'POST', path, { status });
    checkApp(app, `POST ${path}`);
    return app;
  }

  /**
   * Makes a key for an app that has none with `POST /apps/{key}/key`, sent
   * once, holding `params.scopes` or none, labelled "App: {name}". Answers
   * 201, the app with `rawKey`, shown this once.
   *
   * Refuses a bad app key, params that are not an object, and any field but
   * `scopes`, with `SirenError` before sending. Siren answers 409
   * `app_key_exists` when the app holds an active key, and 400 with
   * `data.limit` when the organization holds its cap of keys. Throws
   * `UnexpectedResponseError` when the 2xx body is not an app or lacks
   * `rawKey`. Siren had made the key by then, so rotate it to get one you
   * can read.
   */
  async createKey(key: string, params: { scopes?: string[] } = {}): Promise<AppWithRawKey> {
    const path = `${appPath(key, 'apps.createKey()')}/key`;
    if (!isJsonObject(params)) throw new SirenError('Siren: apps.createKey() takes { scopes } as an object.');
    const sent = pickFields(params, ['scopes'] as const, (field) => `Siren: apps.createKey() does not take ${field}.`);
    return writeWithSecret<AppWithRawKey>(this.http, path, 'POST', sent, 'rawKey', 'Rotate the key with apps.rotateKey() to get a new one.');
  }

  /**
   * Replaces the app's key with `POST /apps/{key}/key/rotate`, sent once.
   * Siren revokes the old key first, then makes a new one with the old
   * label, scopes and `propertyId`. The signing secret never changes with
   * the key. Answers the app with `rawKey`, shown this once.
   *
   * Refuses a bad app key with `SirenError` before sending. Siren answers
   * 409 `app_key_missing` for an app with no key. Throws
   * `UnexpectedResponseError` when the 2xx body is not an app or lacks
   * `rawKey`. Siren had rotated the key by then, so rotate again.
   */
  async rotateKey(key: string): Promise<AppWithRawKey> {
    const path = `${appPath(key, 'apps.rotateKey()')}/key/rotate`;
    return writeWithSecret<AppWithRawKey>(this.http, path, 'POST', undefined, 'rawKey', 'Rotate the key again to get one you can read.');
  }

  /**
   * Revokes the app's key with `DELETE /apps/{key}/key`, sent once, and
   * answers the app, which keeps its address. Refuses a bad app key with
   * `SirenError` before sending. Siren answers 409 `app_key_missing` for an
   * app with no key, 409 `app_needs_a_part` for an app with no address, and
   * 409 `app_features_need_key_and_address` for an app with features. Throws
   * `UnexpectedResponseError` when the 2xx body is not an app.
   */
  async revokeKey(key: string): Promise<App> {
    const path = `${appPath(key, 'apps.revokeKey()')}/key`;
    const app = await deleteRecord<App>(this.http, path);
    checkApp(app, `DELETE ${path}`);
    return app as App;
  }

  /**
   * Gives the app's address a new signing secret with
   * `POST /apps/{key}/secret/rotate`, sent once. Siren signs every delivery
   * with it from that moment, and the key never changes with the secret.
   * Answers the app with `signingSecret`, shown this once.
   *
   * Refuses a bad app key with `SirenError` before sending. Siren answers
   * 409 `app_address_missing` for an app with no address. Throws
   * `UnexpectedResponseError` when the 2xx body is not an app or lacks
   * `signingSecret`. Siren had rotated the secret by then, so rotate again.
   */
  async rotateSecret(key: string): Promise<AppWithSigningSecret> {
    const path = `${appPath(key, 'apps.rotateSecret()')}/secret/rotate`;
    return writeWithSecret<AppWithSigningSecret>(this.http, path, 'POST', undefined, 'signingSecret', 'Rotate the secret again to get one you can read.');
  }

  /**
   * Sends the app's address one signed `webhook.test` delivery now, with
   * `POST /apps/{key}/test`, and answers what the address did. Siren answers
   * 200 whether or not it arrived, so read `delivered`. The test shows in
   * {@link deliveries}.
   *
   * Sent once, since each call sends a request. Refuses a bad app key with
   * `SirenError` before sending. Siren answers 409 `app_address_missing` for
   * an app with no address, 409 `app_inactive` for an app that is off, 403
   * `plan_required` with `data.plan` below Pro, since a test goes out of
   * Siren, and 429 past 20 tests an hour for one app or 60 from one address.
   * Throws `UnexpectedResponseError` when the 2xx body is not an object with
   * a boolean `delivered`.
   */
  async test(key: string): Promise<WebhookTestResult> {
    const path = `${appPath(key, 'apps.test()')}/test`;
    const result = await writeRecord<Record<string, unknown>>(this.http, 'POST', path, undefined);
    if (typeof result.delivered !== 'boolean') {
      throw new UnexpectedResponseError(`Siren answered POST ${path} with a body that is not a test result.`, { data: result });
    }
    return result as unknown as WebhookTestResult;
  }

  /**
   * The app's address's latest deliveries, newest first, at most 50, from
   * `GET /apps/{key}/deliveries`, as `GET /webhooks/{id}/deliveries` lists
   * them, and `[]` for an app with no address. Each holds the payload Siren
   * sent, its status, its tries and the first 200 bytes of the answer. A
   * request Siren sent the app shows as `{request id}.{send}` in `eventId`.
   * Retries as a read. Refuses a bad app key with `SirenError` before
   * sending. Throws `UnexpectedResponseError` when the 2xx body is not an
   * array of objects.
   */
  async deliveries(key: string): Promise<WebhookDelivery[]> {
    const path = `${appPath(key, 'apps.deliveries()')}/deliveries`;
    return readList<WebhookDelivery>(this.http, path, (rows) =>
      rows.every(isJsonObject) ? undefined : `Siren answered GET ${path} with a delivery that is not a JSON object.`,
    );
  }

  /**
   * The events an app's address may receive, from `GET /apps/events`, each
   * `{ event, category, label }` (WebhookCatalog::all()). Retries as a read.
   * Throws `UnexpectedResponseError` when the body is not a list of objects.
   */
  async events(): Promise<WebhookCatalogEntry[]> {
    return readList<WebhookCatalogEntry>(this.http, '/apps/events', (rows) =>
      rows.every(isJsonObject) ? undefined : 'Siren answered GET /apps/events with a body that is not a list of event objects.',
    );
  }

  /**
   * The scopes an app's key may hold, grouped by resource, from
   * `GET /apps/scopes`, the same groups the API keys screen offers
   * (ApiKeyScopePolicy::issuableGroups()). Retries as a read. Throws
   * `UnexpectedResponseError` when the body is not an object of lists of
   * objects.
   */
  async scopes(): Promise<ApiKeyScopeGroups> {
    return readObject<ApiKeyScopeGroups>(this.http, '/apps/scopes', {}, (body) =>
      Object.values(body).every((group) => Array.isArray(group) && group.every(isJsonObject))
        ? undefined
        : 'Siren answered GET /apps/scopes with a body that is not an object of scope lists.',
    );
  }

  /**
   * The kinds of feature an app may add, in the order the dashboard lists
   * them, from `GET /apps/kinds` (AppItemKindCatalog::catalog()): each
   * kind's documentation term, readable name, mode, direction, other names
   * and settings fields, and whether the plan can use it. Retries as a
   * read. Throws `UnexpectedResponseError` when the body is not a list of
   * objects, each with a text `kind`.
   */
  async kinds(): Promise<AppFeatureKindEntry[]> {
    return readList<AppFeatureKindEntry>(this.http, '/apps/kinds', (rows) =>
      rows.every((row) => isJsonObject(row) && typeof row.kind === 'string')
        ? undefined
        : 'Siren answered GET /apps/kinds with a body that is not a list of kinds.',
    );
  }

  /**
   * Deletes an app no record selects and with no open ask, with
   * `DELETE /apps/{key}`, sent once. Siren revokes its key and deletes its
   * features, its address and its delivery log. Its requests stay readable.
   * Refuses a bad app key with `SirenError` before sending. Siren answers
   * 409, raised as `ConflictError` with `data.reason` `app_in_use` and
   * `data.uses`, while a record selects one of its features or an ask is open,
   * and 404 for a key the org lacks, raised as `NotFoundError`. Read the
   * code with `appErrorCode()`.
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

  /**
   * A handler that answers Siren for the app: it checks each request as
   * {@link verifyRequest} does, hands it to the function `on(kind, key, fn)`
   * names, and sends the reply Siren expects. Build the client with the
   * app's own key, since the handler posts an ask's answer with it.
   *
   * ```ts
   * const answers = siren.apps.requestHandler() // reads SIREN_SIGNING_SECRET
   * answers.on('postConversionAction', 'tell-the-crm', async ({ id, data }) => { ... })
   * express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
   * ```
   *
   * It replies, always JSON with `Cache-Control: no-store`:
   *
   * - 405 to a method other than POST.
   * - 500 when a body parser already read the body, and tells `onError`
   *   to mount the handler before the JSON parser.
   * - 401 when the signature or its time fails `verifyRequest`'s checks.
   * - 400 when the signed body is not JSON, or an app request is not an
   *   envelope of version 1.
   * - For a tell, 200 once the function returns, and 500 when it throws, so
   *   Siren sends it again.
   * - For an ask, 200 at once. The function runs after the reply, and the
   *   answer it returns is posted to `POST /apps/requests/{id}/answer` with
   *   the client's key, resent on a lost connection, 429 or 5xx within
   *   `maxRetries`, which is safe because Siren takes the same answer again
   *   as `duplicate: true`. A refusal (422, 409, 403, 404) goes to
   *   `onError` and is not resent. A function that returns
   *   `answers.later()` leaves the answer to `apps.requests.answer()`, and
   *   one that returns nothing is an error `onError` gets.
   * - 404 `No function handles <kind> <key>.` for a feature with no
   *   function, so Siren shows the request under Needs attention.
   * - For any other `X-Siren-Event`, 200 once the `onEvent` function
   *   returns, 500 when it throws, and 200 when there is none.
   *
   * Before an ask's reply it checks that the request's `answerUrl` is on
   * the same Siren as the client's base address, and replies 500 with both
   * addresses when it is not, so the fault shows on the first request. The
   * answer only ever goes to the client's base address. Siren Cloud's
   * `api.` and `app.` hosts count as one Siren.
   *
   * `signingSecret` defaults to `SIREN_SIGNING_SECRET` from the environment.
   * Refuses with `SirenError`, when it is made, a missing signing secret,
   * a `toleranceSeconds` outside 1 to 3600 and an `extraKinds` that is not
   * a list of kind names. `on()` refuses a kind Siren never sends unless
   * `extraKinds` names it. It keeps no state.
   */
  requestHandler(options?: AppRequestHandlerOptions): AppRequestHandler;
  /** The handler with the kinds `extraKinds` names, which `on()` then takes too. */
  requestHandler<X extends string>(options: AppRequestHandlerOptions<X> & { extraKinds: readonly X[] }): AppRequestHandlerWith<X>;
  /** The handler when the options may or may not name `extraKinds`. */
  requestHandler<X extends string = never>(options?: AppRequestHandlerOptions<X>): AppRequestHandlerWith<X>;
  requestHandler<X extends string = never>(options?: AppRequestHandlerOptions<X>): AppRequestHandlerWith<X> {
    return createAppRequestHandler<X>(this.http, options, {
      toleranceSeconds: DEFAULT_APP_REQUEST_TOLERANCE_SECONDS,
      maxAnswerBytes: MAX_APP_ANSWER_BYTES,
    });
  }

  /**
   * Splits a resolver's pool by weight, for a `distributionResolver` or
   * `incentiveResolver` answer. Each id gets a whole number of the
   * currency's steps, `10^(scale - decimalPlaces)` stored units (1 for
   * dollars, 100 for yen), rounded down so the shares never add up to more
   * than `pool.value`. When every weight is 0, each id gets the same.
   * `weights` is an object of id to weight, or a list of `[id, weight]`
   * pairs. Answers `{ [id]: amount }` with the ids as text. Sends nothing.
   *
   * On pool 10000 in dollars with weights 30 and 20 it answers 6000 and
   * 4000. Throws `SirenError` for a negative or non-finite weight, an id
   * given twice, and a pool `value` or currency `shownAmount` would refuse.
   */
  splitPool(pool: AppSplitPool, weights: AppSplitWeights): Record<string, number> {
    return splitPool(pool, weights, 'apps.splitPool()');
  }
}
