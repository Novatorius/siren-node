import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { SignatureVerificationError, SirenError } from '../src/errors';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';
import { AppTells } from './apps-siren-answers';

/*
 * Acceptance tests for `siren.apps.verifyRequest()`, packet sdk-verify.
 * Contract: docs/architecture/apps-cli.md, "Checking a request".
 *
 * The fixture is Siren's own, copied byte for byte from
 * tests/Fixtures/apps-exchange/signed-request.json on int/preview-apps
 * (a22547327, where 0bb03b2c3 gave it the kind payoutMethod and new
 * signatures). Siren's AppsExchangeFlowTest checks that PHP still makes
 * these bytes, so a pass here means this SDK reads what Siren sends.
 */

interface SignedFixture {
  secret: string;
  timestamp: number;
  body: string;
  headers: Record<string, string>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8'),
) as SignedFixture;
const T = fixture.timestamp;
const SECRET = fixture.secret;
const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]) });

function v1(body: string, t: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

/** Headers as Siren builds them for `body` at `t`, with any header replaced or removed. */
function signed(body: string, t = T, change: Record<string, string | undefined> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Siren-Event': 'app.request',
    'X-Siren-Timestamp': String(t),
    'X-Siren-Signature-V2': `t=${t},v1=${v1(body, t)}`,
  };
  for (const [name, value] of Object.entries(change)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('verifyRequest answered instead of refusing');
}

const tell = JSON.stringify({
  version: 1,
  id: 'apr_0123456789abcdef0123456789abcdef',
  type: 'app.request',
  mode: 'tell',
  app: 'acme-payouts',
  feature: { kind: 'postConversionAction', key: 'notify-crm', id: 'app:11' },
  createdAt: '2026-11-17T09:14:03+00:00',
  // A conversion approved, as Siren's AppActionSubjects::forConversion() builds it (test/apps-siren-answers.ts).
  data: AppTells.conversionApproved(),
});

describe('apps-cli: apps.verifyRequest', () => {
  it('checks the request Siren signed, byte for byte, as text and as bytes', () => {
    for (const raw of [fixture.body, Buffer.from(fixture.body, 'utf8'), new TextEncoder().encode(fixture.body)]) {
      const request = siren.apps.verifyRequest(raw, fixture.headers, SECRET, { now: T });
      expect(request).toEqual({
        version: 1,
        id: 'apr_b79943ff8ca353ce5cf5312bb3fa66c7',
        type: 'app.request',
        mode: 'ask',
        isAsk: true,
        // Siren leaves test out of a real request, and the SDK reads it as false.
        test: false,
        app: 'acme-payouts',
        feature: { kind: 'payoutMethod', key: 'acme-ledger', id: 'app:12' },
        createdAt: '2026-11-17T09:14:03+00:00',
        answerBy: '2026-11-18T09:14:03+00:00',
        answerUrl: 'https://api.siren.test/siren/v1/apps/requests/apr_b79943ff8ca353ce5cf5312bb3fa66c7/answer',
        data: { payoutId: 88, amount: 2500, currency: 'USD' },
        timestamp: T,
        deliveryId: 'apr_b79943ff8ca353ce5cf5312bb3fa66c7.1',
      });
    }
  });

  it('refuses a body changed by one byte, and the wrong secret', () => {
    const changed = fixture.body.replace('"amount":2500', '"amount":2600');
    expect(refusal(() => siren.apps.verifyRequest(changed, fixture.headers, SECRET, { now: T }))).toBeInstanceOf(
      SignatureVerificationError,
    );
    expect(
      refusal(() => siren.apps.verifyRequest(fixture.body, fixture.headers, 'cd'.repeat(32), { now: T })),
    ).toBeInstanceOf(SignatureVerificationError);
  });

  it('refuses a timestamp more than 300 seconds off either way, and takes one exactly 300 off', () => {
    expect(siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T + 300 }).id).toMatch(/^apr_/);
    expect(siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T - 300 }).id).toMatch(/^apr_/);
    for (const now of [T + 301, T - 301]) {
      const error = refusal(() => siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now }));
      expect(error).toBeInstanceOf(SignatureVerificationError);
      expect((error as Error).message).toMatch(/timestamp/i);
    }
  });

  it('reads toleranceSeconds', () => {
    expect(siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T + 10, toleranceSeconds: 10 }).id).toMatch(
      /^apr_/,
    );
    expect(
      refusal(() => siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T + 11, toleranceSeconds: 10 })),
    ).toBeInstanceOf(SignatureVerificationError);
  });

  it('refuses a request with no timestamped signature, even when the older one matches', () => {
    const headers = { ...fixture.headers };
    delete (headers as Record<string, string | undefined>)['X-Siren-Signature-V2'];
    const error = refusal(() => siren.apps.verifyRequest(fixture.body, headers, SECRET, { now: T }));
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as Error).message).toContain('X-Siren-Signature-V2');
  });

  it('refuses a signed time changed in the header, and a header it cannot read', () => {
    const later = signed(fixture.body, T, {
      'X-Siren-Signature-V2': `t=${T + 60},v1=${v1(fixture.body, T)}`,
      'X-Siren-Timestamp': String(T + 60),
    });
    expect(refusal(() => siren.apps.verifyRequest(fixture.body, later, SECRET, { now: T + 60 }))).toBeInstanceOf(
      SignatureVerificationError,
    );
    for (const header of ['garbage', `v1=${v1(fixture.body, T)}`, `t=${T}`, `t=soon,v1=${v1(fixture.body, T)}`]) {
      const headers = signed(fixture.body, T, { 'X-Siren-Signature-V2': header });
      expect(refusal(() => siren.apps.verifyRequest(fixture.body, headers, SECRET, { now: T }))).toBeInstanceOf(
        SignatureVerificationError,
      );
    }
  });

  it('refuses an X-Siren-Timestamp that differs from the signed time, and takes a request without one', () => {
    const differs = signed(fixture.body, T, { 'X-Siren-Timestamp': String(T + 1) });
    expect(refusal(() => siren.apps.verifyRequest(fixture.body, differs, SECRET, { now: T }))).toBeInstanceOf(
      SignatureVerificationError,
    );
    const without = signed(fixture.body, T, { 'X-Siren-Timestamp': undefined });
    expect(siren.apps.verifyRequest(fixture.body, without, SECRET, { now: T }).mode).toBe('ask');
  });

  it('refuses an ordinary webhook and points to webhooks.constructEvent()', () => {
    const headers = signed(fixture.body, T, { 'X-Siren-Event': 'conversion.approved' });
    const error = refusal(() => siren.apps.verifyRequest(fixture.body, headers, SECRET, { now: T }));
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as Error).message).toContain('constructEvent');
  });

  it('refuses an empty secret or a bad tolerance before checking anything', () => {
    for (const run of [
      () => siren.apps.verifyRequest(fixture.body, fixture.headers, '', { now: T }),
      () => siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T, toleranceSeconds: 0 }),
      () => siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T, toleranceSeconds: 3601 }),
      () => siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T, toleranceSeconds: 1.5 }),
      () => siren.apps.verifyRequest(fixture.body, fixture.headers, SECRET, { now: T, toleranceSeconds: Number.NaN }),
    ]) {
      const error = refusal(run);
      expect(error).toBeInstanceOf(SirenError);
      expect(error).not.toBeInstanceOf(SignatureVerificationError);
    }
  });

  it('reads headers in any case, from a Headers object, and with more than one v1', () => {
    const lower = Object.fromEntries(Object.entries(fixture.headers).map(([name, value]) => [name.toLowerCase(), value]));
    expect(siren.apps.verifyRequest(fixture.body, lower, SECRET, { now: T }).id).toMatch(/^apr_/);
    expect(siren.apps.verifyRequest(fixture.body, new Headers(fixture.headers), SECRET, { now: T }).id).toMatch(/^apr_/);
    const two = signed(fixture.body, T, {
      'X-Siren-Signature-V2': `t=${T},v1=${'0'.repeat(64)},v1=${v1(fixture.body, T)}`,
    });
    expect(siren.apps.verifyRequest(fixture.body, two, SECRET, { now: T }).id).toMatch(/^apr_/);
  });

  it('answers a tell with no answer fields, and ignores Idempotency-Key', () => {
    const headers = signed(tell, T, { 'Idempotency-Key': 'apr_ffffffffffffffffffffffffffffffff' });
    const request = siren.apps.verifyRequest(tell, headers, SECRET, { now: T });
    expect(request.mode).toBe('tell');
    expect(request.id).toBe('apr_0123456789abcdef0123456789abcdef');
    expect(request).not.toHaveProperty('answerUrl');
    expect(request).not.toHaveProperty('answerBy');
    expect(request).not.toHaveProperty('deliveryId');
    expect(request.timestamp).toBe(T);
  });

  it('refuses a signed body that is not an app request of version 1', () => {
    const base = JSON.parse(fixture.body) as Record<string, unknown>;
    const bodies = [
      'not json',
      '[]',
      JSON.stringify({ ...base, version: 2 }),
      JSON.stringify({ ...base, type: 'conversion.approved' }),
      JSON.stringify({ ...base, mode: 'demand' }),
      JSON.stringify({ ...base, id: 'evt_1' }),
      JSON.stringify({ ...base, answerUrl: undefined }),
      JSON.stringify({ ...base, data: 'paid' }),
    ];
    for (const body of bodies) {
      const error = refusal(() => siren.apps.verifyRequest(body, signed(body), SECRET, { now: T }));
      expect(error, body).toBeInstanceOf(SignatureVerificationError);
    }
  });
});
