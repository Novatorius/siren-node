import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureVerificationError, SirenError } from '../errors';
import type { AppRequest, VerifyAppRequestOptions } from '../record-types';
import type { WebhookHeaders } from '../types';
import { isJsonObject } from './record-requests';
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

/** The longest tolerance `verifyRequest` takes, an hour. */
const MAX_TOLERANCE_SECONDS = 3600;

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

  const v2 = readHeader(headers, 'X-Siren-Signature-V2');
  if (v2 === undefined) throw new SignatureVerificationError('The request has no X-Siren-Signature-V2 header.');
  const { t, signatures } = readSignatureHeader(v2);

  const stamp = readHeader(headers, 'X-Siren-Timestamp');
  if (stamp !== undefined && stamp !== String(t)) {
    throw new SignatureVerificationError('The X-Siren-Timestamp header differs from the time X-Siren-Signature-V2 signed.');
  }

  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = createHmac('sha256', secret).update(`${t}.`).update(bytes).digest();
  const matched = signatures.some(
    (signature) => signature.length === expected.length && timingSafeEqual(signature, expected),
  );
  if (!matched) {
    throw new SignatureVerificationError(
      'The request signature does not match. Pass the raw body exactly as received and the signing secret of this app.',
    );
  }

  if (Math.abs(now - t) > tolerance) {
    throw new SignatureVerificationError(
      `The request's signed timestamp is more than ${tolerance} seconds from this machine's clock, so it may be a replay. Check the clock if every request fails.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new SignatureVerificationError('The signed body is not JSON.', { cause });
  }
  if (!isAppRequestEnvelope(parsed)) {
    throw new SignatureVerificationError('The signed body is not an app request of version 1.');
  }

  const request = { ...parsed, timestamp: t } as unknown as AppRequest;
  const delivery = readHeader(headers, 'X-Siren-Delivery');
  if (delivery !== undefined) request.deliveryId = delivery;
  return request;
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
    );
  }
  return { t, signatures };
}

/** True for the body of an app request of version 1 (Siren's `AppRequestEnvelope`). */
function isAppRequestEnvelope(body: unknown): body is Record<string, unknown> {
  if (!isJsonObject(body)) return false;
  const item = body.item;
  return (
    body.version === 1 &&
    typeof body.id === 'string' &&
    REQUEST_ID.test(body.id) &&
    body.type === 'app.request' &&
    typeof body.app === 'string' &&
    body.app !== '' &&
    isJsonObject(item) &&
    typeof item.kind === 'string' &&
    typeof item.key === 'string' &&
    typeof item.id === 'string' &&
    typeof body.createdAt === 'string' &&
    isJsonObject(body.data) &&
    (body.mode === 'tell' || body.mode === 'ask') &&
    (body.mode === 'tell' || (typeof body.answerBy === 'string' && typeof body.answerUrl === 'string'))
  );
}
