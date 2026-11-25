import { createHmac, randomBytes } from 'node:crypto';
import { baseUrlForKey } from '../client';
import { readEnvironment } from '../environment';
import { AppHandlerError } from '../errors';
import type { FeatureKind } from '../feature-kind';
import { DEFAULT_BASE_URL } from '../http';
import APP_KINDS from '../app-kinds.json';
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
   * Defaults to where `new Siren()` sends with `SIREN_API_KEY`: Siren Cloud,
   * or its sandbox for an `sk_test_` key. Set it to your client's
   * `baseUrl` when you set one.
   */
  baseUrl?: string;
  /** The signed time, in Unix seconds. Defaults to now. */
  timestamp?: number;
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
  const base = (options.baseUrl ?? baseUrlForKey(readEnvironment('SIREN_API_KEY'), DEFAULT_BASE_URL, true)).replace(/\/+$/, '');
  const ask = !TELL_KINDS.includes(kind);
  const at = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const body: Record<string, unknown> = {
    version: 1,
    id,
    type: 'app.request',
    mode: ask ? 'ask' : 'tell',
    app: options.app ?? 'my-app',
    feature: { kind, key, id: 'app:1' },
    createdAt: at(t),
  };
  if (ask) {
    body.answerBy = at(t + 3600);
    body.answerUrl = `${base}/apps/requests/${id}/answer`;
  }
  body.data = options.data ?? sampleData(kind);

  const rawBody = JSON.stringify(body);
  const hmac = (text: string): string => createHmac('sha256', secret).update(text).digest('hex');
  return {
    kind,
    method: 'POST',
    rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Siren-Signature': `sha256=${hmac(rawBody)}`,
      'X-Siren-Event': 'app.request',
      'X-Siren-Delivery': `${id}.1`,
      'User-Agent': 'Siren-Webhooks/1.0',
      'X-Siren-Timestamp': String(t),
      'X-Siren-Signature-V2': `t=${t},v1=${hmac(`${t}.${rawBody}`)}`,
      'Idempotency-Key': id,
    },
  };
}
