import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import { SirenError } from '../src/errors';
import { appRequest, sampleData } from '../src/testing';
import type { AppRequest } from '../src/record-types';
import type { WebhookEvent } from '../src/types';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * DX pass 1, first contact (review/sdk-dx/pass-1-review.md and
 * pass-1-builder-spec.md in the apps run folder): the answer address check,
 * the testing helpers and simulate(), the field a bad envelope breaks, and
 * the environment defaults.
 */

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown>; answer: Record<string, unknown> | null }>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const SECRET = 'first-contact-test-secret';
const LIVE = 'https://api.sirenaffiliates.com/siren/v1';
const KINDS = Object.keys(features.kinds);

afterEach(() => {
  vi.unstubAllEnvs();
});

function client(baseUrl?: string) {
  const http = new FakeHttpClient([reply(200, { status: 'accepted' })]);
  const siren = new Siren({ apiKey: TEST_API_KEY, httpClient: http, ...(baseUrl === undefined ? {} : { baseUrl }) });
  const errors: Array<{ error: unknown; request: AppRequest | WebhookEvent | undefined }> = [];
  const answers = siren.apps.requestHandler({ signingSecret: SECRET, onError: (error, request) => errors.push({ error, request }) });
  return { http, siren, answers, errors };
}

/** A request signed by hand, the way Siren's WebhookSignature::headers() signs one. */
function signedBy(body: Record<string, unknown>, secret = SECRET) {
  const rawBody = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  return {
    method: 'POST',
    rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Siren-Event': 'app.request',
      'X-Siren-Timestamp': String(t),
      'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`,
    },
  };
}

function envelope(kind: string, answerUrlBase: string): Record<string, unknown> {
  const request = structuredClone(features.kinds[kind]!.request);
  if (typeof request.answerUrl === 'string') {
    request.answerUrl = `${answerUrlBase}/apps/requests/${String(request.id)}/answer`;
  }
  return request;
}

async function settle(after: (() => Promise<void>) | undefined): Promise<void> {
  if (after !== undefined) await after();
}

describe('finding 1: the answer goes only to the client base, and a different Siren fails loudly', () => {
  it('replies 500 and names both addresses and baseUrl when the signed answerUrl is on another origin', async () => {
    const { answers, http, errors } = client();
    const fn = vi.fn(() => ({ outcome: 'allocated', units: 'USD', shares: { '41': 6000, '43': 4000 } }));
    answers.on('distributionResolver', 'split-by-score', fn as never);
    const result = await answers.handle(signedBy(envelope('distributionResolver', 'https://preview.example.com/siren/v1')));
    await settle(result.after);
    expect(result.status).toBe(500);
    expect(fn).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
    const message = String((errors[0]!.error as Error).message);
    expect(errors[0]!.error).toBeInstanceOf(SirenError);
    expect(message).toContain('https://preview.example.com/siren/v1/apps/requests/');
    expect(message).toContain(LIVE);
    expect(message).toContain('Set baseUrl to https://preview.example.com/siren/v1');
    expect(JSON.parse(result.body)).toEqual({ error: message });
  });

  it('takes an answerUrl on the same origin, and posts to the client base', async () => {
    const { answers, http } = client(BASE);
    answers.on('distributionResolver', 'split-by-score', () => features.kinds.distributionResolver!.answer as never);
    const result = await answers.handle(signedBy(envelope('distributionResolver', BASE)));
    await settle(result.after);
    expect(result.status).toBe(200);
    expect(http.requests.map((request) => request.url)).toEqual([`${BASE}/apps/requests/apr_9c60190a4501399d0ae55f041c237b39/answer`]);
  });

  it("counts Siren Cloud's api and app hosts as one Siren, and still posts to the client base", async () => {
    const { answers, http } = client();
    answers.on('distributionResolver', 'split-by-score', () => features.kinds.distributionResolver!.answer as never);
    const result = await answers.handle(signedBy(envelope('distributionResolver', 'https://app.sirenaffiliates.com/siren/v1')));
    await settle(result.after);
    expect(result.status).toBe(200);
    expect(http.requests.map((request) => request.url)).toEqual([`${LIVE}/apps/requests/apr_9c60190a4501399d0ae55f041c237b39/answer`]);
  });

  it('does not count the Cloud host pair over plain http', async () => {
    const { answers, errors } = client();
    answers.on('distributionResolver', 'split-by-score', () => answers.later());
    const result = await answers.handle(signedBy(envelope('distributionResolver', 'http://app.sirenaffiliates.com/siren/v1')));
    expect(result.status).toBe(500);
    expect(errors).toHaveLength(1);
  });

  it('checks no address on a tell, which carries none', async () => {
    const { answers } = client();
    answers.on('postConversionAction', 'tell-the-crm', () => undefined);
    const result = await answers.handle(signedBy(envelope('postConversionAction', 'https://preview.example.com/siren/v1')));
    expect(result.status).toBe(200);
  });
});

describe('finding 2: appRequest and sampleData', () => {
  it('ships every kind of Siren fixture as sample data, equal to the fixture', () => {
    for (const kind of KINDS) {
      expect(sampleData(kind), kind).toEqual(features.kinds[kind]!.request.data);
    }
  });

  it('hands out a copy, so a test cannot change the next one', () => {
    const first = sampleData('distributionResolver') as { pool: { value: number } };
    first.pool.value = 1;
    expect((sampleData('distributionResolver') as { pool: { value: number } }).pool.value).toBe(10000);
  });

  it('refuses a kind it has no sample for, naming the kinds it has', () => {
    expect(() => sampleData('noSuchKind')).toThrow(/noSuchKind.*distributionResolver/s);
  });

  it('builds a request the handler accepts, signed and well formed, with a tell or ask mode by kind', async () => {
    const { siren } = client();
    for (const kind of KINDS) {
      const request = appRequest(kind, 'a-feature', { secret: SECRET });
      expect(request.method).toBe('POST');
      const checked = siren.apps.verifyRequest(request.rawBody, request.headers, SECRET);
      expect(checked.feature).toMatchObject({ kind, key: 'a-feature' });
      expect(checked.id).toMatch(/^apr_[0-9a-f]{32}$/);
      expect(checked.mode).toBe(kind === 'postConversionAction' || kind === 'postAllocationAction' ? 'tell' : 'ask');
      expect(checked.data).toEqual(features.kinds[kind]!.request.data);
      if (checked.mode === 'ask') {
        expect((checked as { answerUrl?: string }).answerUrl).toBe(`${LIVE}/apps/requests/${checked.id}/answer`);
      }
    }
  });

  it('takes data, id, app, baseUrl and timestamp', () => {
    const { siren } = client();
    const id = `apr_${'b'.repeat(32)}`;
    const t = Math.floor(Date.now() / 1000) - 10;
    const request = appRequest('distributionResolver', 'split-by-score', {
      secret: SECRET,
      data: { pool: { value: 1 } },
      id,
      app: 'my-app',
      baseUrl: 'http://localhost:8080/siren/v1',
      timestamp: t,
    });
    const checked = siren.apps.verifyRequest(request.rawBody, request.headers, SECRET);
    expect(checked).toMatchObject({ id, app: 'my-app', data: { pool: { value: 1 } }, timestamp: t });
    expect((checked as { answerUrl?: string }).answerUrl).toBe(`http://localhost:8080/siren/v1/apps/requests/${id}/answer`);
  });

  it('reads SIREN_SIGNING_SECRET, and refuses with words naming both when there is no secret', () => {
    vi.stubEnv('SIREN_SIGNING_SECRET', SECRET);
    const { siren } = client();
    const request = appRequest('metricFilter', 'refund-check');
    expect(siren.apps.verifyRequest(request.rawBody, request.headers, SECRET).feature.kind).toBe('metricFilter');
    vi.stubEnv('SIREN_SIGNING_SECRET', '');
    expect(() => appRequest('metricFilter', 'refund-check')).toThrow(/secret.*SIREN_SIGNING_SECRET/s);
  });
});

describe('finding 2: answers.simulate()', () => {
  it("runs an ask's function and gives its answer without posting it", async () => {
    const { answers, http, errors } = client();
    answers.on('distributionResolver', 'split-by-score', ({ data }) => ({
      outcome: 'allocated',
      units: data.pool.units,
      shares: { '41': 6000, '43': 4000 },
    }));
    const result = await answers.simulate(appRequest('distributionResolver', 'split-by-score', { secret: SECRET }));
    expect(result).toEqual({ status: 200, body: {}, answer: features.kinds.distributionResolver!.answer, error: null });
    expect(http.requests).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('gives a tell its reply, and a function that throws as error', async () => {
    const { answers } = client();
    const failure = new Error('the CRM is down');
    answers.on('postConversionAction', 'tell-the-crm', () => {
      throw failure;
    });
    const result = await answers.simulate(appRequest('postConversionAction', 'tell-the-crm', { secret: SECRET }));
    expect(result.status).toBe(500);
    expect(result.error).toBe(failure);
  });

  it('gives an answer that breaks the rules as error, as the post would refuse it', async () => {
    const { answers } = client();
    answers.on('distributionResolver', 'split-by-score', () => 'not an object' as never);
    const result = await answers.simulate(appRequest('distributionResolver', 'split-by-score', { secret: SECRET }));
    expect(result.status).toBe(200);
    expect(result.answer).toBeNull();
    expect(result.error).toBeInstanceOf(SirenError);
  });

  it('checks the signature, so a request signed with another secret gets 401', async () => {
    const { answers } = client();
    answers.on('distributionResolver', 'split-by-score', () => answers.later());
    const result = await answers.simulate(appRequest('distributionResolver', 'split-by-score', { secret: 'another secret' }));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: expect.any(String) });
  });
});

describe('finding 3: a bad envelope names the field it breaks', () => {
  const base = (): Record<string, unknown> => envelope('distributionResolver', LIVE);
  const cases: Array<[string, (body: Record<string, unknown>) => void, string]> = [
    ['version', (b) => (b.version = 2), 'The request\'s `version` must be 1.'],
    ['id', (b) => (b.id = 'apr_x1'), 'The request\'s `id` must be `apr_` followed by 32 hex characters.'],
    ['type', (b) => (b.type = 'app.other'), 'The request\'s `type` must be `app.request`.'],
    ['app', (b) => (b.app = ''), 'The request\'s `app` must be the app\'s key, a non-empty string.'],
    ['mode', (b) => (b.mode = 'maybe'), 'The request\'s `mode` must be `tell` or `ask`.'],
    ['feature', (b) => (b.feature = 'x'), 'The request\'s `feature` must be an object.'],
    ['item in place of feature, the name before the rename', (b) => ((b.item = b.feature), delete b.feature), 'The request\'s `feature` must be an object.'],
    ['feature.kind', (b) => ((b.feature as Record<string, unknown>).kind = 3), 'The request\'s `feature.kind` must be a string.'],
    ['feature.key', (b) => delete (b.feature as Record<string, unknown>).key, 'The request\'s `feature.key` must be a string.'],
    ['feature.id', (b) => ((b.feature as Record<string, unknown>).id = null), 'The request\'s `feature.id` must be a string.'],
    ['createdAt', (b) => delete b.createdAt, 'The request\'s `createdAt` must be a date string.'],
    ['answerBy', (b) => delete b.answerBy, 'An ask\'s `answerBy` must be a date string.'],
    ['answerUrl', (b) => (b.answerUrl = 'not a url'), 'An ask\'s `answerUrl` must be an http or https URL.'],
    ['data', (b) => (b.data = []), 'The request\'s `data` must be a JSON object.'],
  ];

  it.each(cases)('%s', async (_field, change, words) => {
    const { answers } = client();
    answers.on('distributionResolver', 'split-by-score', () => answers.later());
    const body = base();
    change(body);
    const result = await answers.handle(signedBy(body));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: `The signed body is not an app request of version 1. ${words}` });
  });
});

describe('lower finding: the environment defaults', () => {
  it('new Siren() reads SIREN_API_KEY', async () => {
    vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
    const http = new FakeHttpClient([reply(200, { status: 'accepted' })]);
    const siren = new Siren({ httpClient: http });
    await siren.apps.requests.answer(`apr_${'c'.repeat(32)}`, { outcome: 'allow' });
    expect(http.requests[0]!.headers.Authorization ?? http.requests[0]!.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(http.requests[0]!.url.startsWith(LIVE)).toBe(true);
  });

  it('new Siren() with no options at all reads SIREN_API_KEY', () => {
    vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
    expect(() => new Siren()).not.toThrow();
  });

  it('an explicit apiKey wins over SIREN_API_KEY', async () => {
    vi.stubEnv('SIREN_API_KEY', `sk_live_${'z'.repeat(64)}`);
    const http = new FakeHttpClient([reply(200, { status: 'accepted' })]);
    await new Siren({ apiKey: TEST_API_KEY, httpClient: http }).apps.requests.answer(`apr_${'c'.repeat(32)}`, { outcome: 'allow' });
    expect(http.requests[0]!.headers.Authorization ?? http.requests[0]!.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it('an accessToken keeps SIREN_API_KEY out', () => {
    vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
    expect(() => new Siren({ accessToken: 'session-token' })).not.toThrow();
  });

  it('refuses with no key and no SIREN_API_KEY, naming both', () => {
    vi.stubEnv('SIREN_API_KEY', '');
    expect(() => new Siren()).toThrow(/apiKey.*SIREN_API_KEY/s);
  });

  it('requestHandler() reads SIREN_SIGNING_SECRET, and an explicit secret wins', async () => {
    vi.stubEnv('SIREN_SIGNING_SECRET', SECRET);
    const siren = new Siren({ apiKey: TEST_API_KEY, httpClient: new FakeHttpClient([]) });
    const answers = siren.apps.requestHandler();
    answers.on('metricFilter', 'refund-check', () => ({ outcome: 'allow' }));
    expect((await answers.simulate(appRequest('metricFilter', 'refund-check'))).answer).toEqual({ outcome: 'allow' });
    const other = siren.apps.requestHandler({ signingSecret: 'another secret' });
    other.on('metricFilter', 'refund-check', () => ({ outcome: 'allow' }));
    expect((await other.simulate(appRequest('metricFilter', 'refund-check'))).status).toBe(401);
  });

  it('requestHandler() refuses with no secret and no SIREN_SIGNING_SECRET, naming both', () => {
    vi.stubEnv('SIREN_SIGNING_SECRET', '');
    const siren = new Siren({ apiKey: TEST_API_KEY, httpClient: new FakeHttpClient([]) });
    expect(() => siren.apps.requestHandler()).toThrow(/signingSecret.*SIREN_SIGNING_SECRET/s);
  });
});

describe('finding 2: the testing entry is built and exported', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };

  it('package.json exports ./testing for import and require, with types', () => {
    expect(pkg.exports['./testing']).toEqual({
      import: { types: './dist/testing.d.ts', default: './dist/testing.js' },
      require: { types: './dist/testing.d.cts', default: './dist/testing.cjs' },
    });
  });

  it.skipIf(!existsSync(join(root, 'dist', 'index.js')))('the build holds the testing entry in ESM and CJS', () => {
    for (const file of ['testing.js', 'testing.cjs', 'testing.d.ts', 'testing.d.cts']) {
      expect(existsSync(join(root, 'dist', file)), file).toBe(true);
    }
  });
});
