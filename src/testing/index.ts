import { createHmac, randomBytes } from 'node:crypto';
import { baseUrlForKey } from '../client';
import { readEnvironment } from '../environment';
import { AppHandlerError } from '../errors';
import type { FeatureKind } from '../feature-kind';
import { DEFAULT_BASE_URL } from '../http';
import APP_KINDS from '../app-kinds.json';
import { EVENT_SAMPLES } from './event-samples';
import { SAMPLE_DATA } from './sample-data';

/*
 * `@novatorius/siren/testing`: try a request handler without Siren. Build a
 * signed request with `appRequest()`, then hand it to `answers.simulate()`
 * in a test, or post it to a running app with any HTTP client. The
 * README's own samples are tested with these same calls.
 */

/** The kinds Siren tells, from its registry snapshot. Every other kind it sends is an ask. */
const TELL_KINDS: readonly string[] = APP_KINDS.filter((entry) => entry.mode === 'tell').map((entry) => entry.kind);

/**
 * A request as Siren sends it: ready for `answers.simulate()`, `answers.handle()` or `fetch`.
 * `K` is the feature's kind, which types the answer `answers.simulate()` gives back.
 */
export interface AppTestRequest<K extends string = string> {
  /** The feature's kind, as the body names it. */
  kind: K;
  method: 'POST';
  /** Siren's headers, signed as `WebhookSignature::headers()` signs them. */
  headers: Record<string, string>;
  /** The JSON body, the exact bytes the signature covers. */
  rawBody: string;
}

/** Options for {@link appRequest}. Every one has a default. */
export interface AppTestRequestOptions {
  /** The question. Defaults to {@link sampleData} for the kind. */
  data?: Record<string, unknown>;
  /** The signing secret. Defaults to `SIREN_SIGNING_SECRET` from the environment. */
  secret?: string;
  /** The request id. Defaults to a new `apr_` and 32 hex characters. */
  id?: string;
  /** The app's key. Defaults to `my-app`. */
  app?: string;
  /**
   * The Siren the request comes from, which an ask's `answerUrl` names.
   * Defaults to where `new Siren()` sends with no `baseUrl`:
   * `SIREN_BASE_URL`, then Siren Cloud, or its sandbox for an `sk_test_` key
   * in `SIREN_API_KEY`. Set it to your client's
   * `baseUrl` when you set one.
   */
  baseUrl?: string;
  /** The signed time, in Unix seconds. Defaults to now. */
  timestamp?: number;
  /**
   * True builds a test request, as `siren trigger ask` makes Siren send:
   * the body carries `"test": true` after `mode`, and the handler reads
   * `request.test` as true. Left out, the field is absent, as on a real request.
   */
  test?: boolean;
}

/**
 * Siren's example question for `kind`, the `data` its feature page shows,
 * as a fresh copy. Throws `AppHandlerError` for a kind it has no example of,
 * naming the kinds it has.
 */
export function sampleData(kind: string): Record<string, unknown> {
  const data = Object.prototype.hasOwnProperty.call(SAMPLE_DATA, kind) ? SAMPLE_DATA[kind] : undefined;
  if (data === undefined) {
    throw new AppHandlerError(`sampleData() has no example for ${String(kind)}. It has ${Object.keys(SAMPLE_DATA).join(', ')}.`);
  }
  return structuredClone(data) as Record<string, unknown>;
}

/**
 * A signed app request for the feature `kind` and `key`, as Siren would
 * send it: a tell for `postConversionAction` and `postAllocationAction`,
 * an ask with `answerBy` an hour on and an `answerUrl` for every other
 * kind. Throws `AppHandlerError` when there is no secret, from the options or
 * `SIREN_SIGNING_SECRET`. The request carries `kind`, so
 * `answers.simulate()` types its answer by the kind.
 *
 * ```js
 * import { appRequest } from '@novatorius/siren/testing'
 * const { answer } = await answers.simulate(appRequest('distributionResolver', 'split-by-score'))
 * ```
 */
export function appRequest<K extends FeatureKind | (string & {})>(kind: K, key: string, options: AppTestRequestOptions = {}): AppTestRequest<K> {
  const secret = options.secret ?? readEnvironment('SIREN_SIGNING_SECRET');
  if (typeof secret !== 'string' || secret === '') {
    throw new AppHandlerError('appRequest() needs the signing secret. Pass it as secret, or set SIREN_SIGNING_SECRET in the environment.');
  }
  const t = options.timestamp ?? Math.floor(Date.now() / 1000);
  const id = options.id ?? `apr_${randomBytes(16).toString('hex')}`;
  const base = (options.baseUrl ?? readEnvironment('SIREN_BASE_URL') ?? baseUrlForKey(readEnvironment('SIREN_API_KEY'), DEFAULT_BASE_URL, true)).replace(/\/+$/, '');
  const ask = !TELL_KINDS.includes(kind);
  const at = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const body: Record<string, unknown> = {
    version: 1,
    id,
    type: 'app.request',
    mode: ask ? 'ask' : 'tell',
    ...(options.test === true ? { test: true } : {}),
    app: options.app ?? 'my-app',
    feature: { kind, key, id: 'app:1' },
    createdAt: at(t),
  };
  if (ask) {
    body.answerBy = at(t + 3600);
    body.answerUrl = `${base}/apps/requests/${id}/answer`;
  }
  body.data = options.data ?? sampleData(kind);

  return signed(kind, JSON.stringify(body), secret, t, 'app.request', `${id}.1`, id);
}

/** A body with Siren's headers, signed as `WebhookSignature::headers()` signs them. */
function signed<K extends string>(
  kind: K,
  rawBody: string,
  secret: string,
  t: number,
  event: string,
  delivery: string,
  idempotencyKey?: string,
): AppTestRequest<K> {
  const hmac = (text: string): string => createHmac('sha256', secret).update(text).digest('hex');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Siren-Signature': `sha256=${hmac(rawBody)}`,
    'X-Siren-Event': event,
    'X-Siren-Delivery': delivery,
    'User-Agent': 'Siren-Webhooks/1.0',
    'X-Siren-Timestamp': String(t),
    'X-Siren-Signature-V2': `t=${t},v1=${hmac(`${t}.${rawBody}`)}`,
  };
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  return { kind, method: 'POST', rawBody, headers };
}

/** The secret from the options or `SIREN_SIGNING_SECRET`, or an `AppHandlerError` naming `method`. */
function secretFor(method: string, given: string | undefined): string {
  const secret = given ?? readEnvironment('SIREN_SIGNING_SECRET');
  if (typeof secret !== 'string' || secret === '') {
    throw new AppHandlerError(`${method} needs the signing secret. Pass it as secret, or set SIREN_SIGNING_SECRET in the environment.`);
  }
  return secret;
}

/**
 * Siren's sample `data` for the webhook event `type`, built from the
 * payload table Siren's event reference gives it (docs/api/webhooks-events.md),
 * as a fresh copy. Throws `AppHandlerError` for an event Siren documents no
 * payload for: pass that event's data to `webhookEvent()` yourself.
 */
export function sampleEventData(type: string): Record<string, unknown> {
  const data = Object.prototype.hasOwnProperty.call(EVENT_SAMPLES, type) ? EVENT_SAMPLES[type] : undefined;
  if (data === undefined) {
    throw new AppHandlerError(
      `sampleEventData() has no sample of ${String(type)}. Pass the data to webhookEvent(type, data). It has samples of ${Object.keys(EVENT_SAMPLES).join(', ')}.`,
    );
  }
  return structuredClone(data) as Record<string, unknown>;
}

/** Options for {@link webhookEvent}. */
export interface WebhookTestEventOptions {
  /** The signing secret. Defaults to `SIREN_SIGNING_SECRET` from the environment. */
  secret?: string;
  /** The delivery id. Defaults to a new `evt_` and 32 hex characters. */
  deliveryId?: string;
  /** The signed time, in Unix seconds. Defaults to now. */
  timestamp?: number;
}

/**
 * A signed webhook event of `type`, as Siren sends one to an app's
 * address: the body is the event's data, and `X-Siren-Event` names the
 * type. `data` defaults to {@link sampleEventData}. Hand it to
 * `answers.simulate()` to test an `onEvent()` function.
 *
 * ```js
 * const { status } = await answers.simulate(webhookEvent('conversion.approved'))
 * ```
 */
export function webhookEvent(type: string, data?: Record<string, unknown>, options: WebhookTestEventOptions = {}): AppTestRequest<string> {
  if (typeof type !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(type)) {
    throw new AppHandlerError(`webhookEvent() takes an event type such as conversion.approved, and ${JSON.stringify(type)} is not one.`);
  }
  const secret = secretFor('webhookEvent()', options.secret);
  const body = data ?? sampleEventData(type);
  const t = options.timestamp ?? Math.floor(Date.now() / 1000);
  return signed(type, JSON.stringify(body), secret, t, type, options.deliveryId ?? `evt_${randomBytes(16).toString('hex')}`);
}

/** Options for {@link appRequestFromRecord}. */
export interface AppRecordRequestOptions {
  /**
   * The feature's key. A request saved with `siren apps requests <id> --json`
   * carries it as `featureKey`, and a raw request body names it already, so
   * neither needs this. Give it for a saved request whose `featureKey` is
   * null, because its app is gone, or for a record that names its feature as
   * `app:{id}` only. A key given here wins over `featureKey` and the body's
   * own. `siren apps show <app>` lists each feature's key.
   */
  key?: string;
  /** The signing secret. Defaults to `SIREN_SIGNING_SECRET` from the environment. */
  secret?: string;
  /** The app's key. Defaults to the record's `app` or `appKey`, then `my-app`. */
  app?: string;
  /** The Siren the request comes from, as for {@link appRequest}. */
  baseUrl?: string;
  /** The signed time, in Unix seconds. Defaults to now. */
  timestamp?: number;
}

/**
 * A stored request as a test input: the same id, kind, mode, data and
 * `answerBy` Siren sent, signed again so `answers.simulate()` takes it.
 * `record` is what `siren apps requests <id> --json` saves: Siren's
 * `GET /apps/requests/{requestKey}` detail with the app's and feature's keys
 * beside it as `appKey` and `featureKey`. It also takes that detail alone, as
 * a signed-in `apps.requests.retrieve(id)` answers it, or a raw request body
 * as Siren sent it. Either one parsed, or its JSON text. Throws
 * `AppHandlerError` when it cannot find the feature's key.
 */
export function appRequestFromRecord(record: unknown, options: AppRecordRequestOptions = {}): AppTestRequest<string> {
  const method = 'appRequestFromRecord()';
  let row: unknown = record;
  if (typeof record === 'string') {
    try {
      row = JSON.parse(record) as unknown;
    } catch {
      throw new AppHandlerError(`${method} takes a stored request as an object or its JSON text, and this text is not JSON.`);
    }
  }
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new AppHandlerError(`${method} takes a stored request as an object, such as what \`siren apps requests <id> --json\` saves.`);
  }
  const given = row as Record<string, unknown>;
  const feature = given.feature;
  const envelope = typeof feature === 'object' && feature !== null ? (feature as Record<string, unknown>) : undefined;
  const kind = envelope?.kind ?? given.kind;
  const featureId = envelope?.id ?? feature;
  if (typeof given.id !== 'string' || typeof kind !== 'string' || (given.mode !== 'ask' && given.mode !== 'tell')) {
    throw new AppHandlerError(`${method} needs the record's id, kind and mode, as \`siren apps requests <id> --json\` saves them.`);
  }
  const savedKey = typeof given.featureKey === 'string' ? given.featureKey : undefined;
  const key = options.key ?? (typeof envelope?.key === 'string' ? envelope.key : savedKey);
  if ((key === undefined || key === '') && 'featureKey' in given && given.featureKey === null) {
    throw new AppHandlerError(
      `${method} needs the feature's key: the saved request's featureKey is null, since its app is gone, and it names its feature as ${String(featureId)}. Pass { key }.`,
    );
  }
  if (key === undefined || key === '') {
    throw new AppHandlerError(
      `${method} needs the feature's key: the record names its feature as ${String(featureId)}, without the key. Pass { key }, which \`siren apps show <app>\` lists beside each feature.`,
    );
  }
  const secret = secretFor(method, options.secret);
  const t = options.timestamp ?? Math.floor(Date.now() / 1000);
  const base = (options.baseUrl ?? readEnvironment('SIREN_BASE_URL') ?? baseUrlForKey(readEnvironment('SIREN_API_KEY'), DEFAULT_BASE_URL, true)).replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    version: 1,
    id: given.id,
    type: 'app.request',
    mode: given.mode,
    ...(given.test === true ? { test: true } : {}),
    app: options.app ?? (typeof given.app === 'string' ? given.app : typeof given.appKey === 'string' ? given.appKey : 'my-app'),
    feature: { kind, key, id: typeof featureId === 'string' ? featureId : 'app:1' },
    createdAt: typeof given.createdAt === 'string' ? given.createdAt : new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
  };
  if (given.mode === 'ask') {
    body.answerBy = typeof given.answerBy === 'string' ? given.answerBy : new Date((t + 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    body.answerUrl = `${base}/apps/requests/${given.id}/answer`;
  }
  body.data = typeof given.data === 'object' && given.data !== null && !Array.isArray(given.data) ? given.data : {};
  return signed(kind, JSON.stringify(body), secret, t, 'app.request', `${given.id}.1`, given.id);
}
