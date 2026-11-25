import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRequestStatus, SirenError } from '../src/index';
import { Siren } from '../src/client';
import { appRequest } from '../src/testing';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Added to the pass 4 fold after its first push
 * (review/sdk-dx/pass-4-recheck-fold-spec.md, "Added after the first push").
 *
 * 1. Siren feat/apps 0383186437, lib/Apps/Core/Models/AppRequest.php, holds
 *    eight request statuses as STATUS_* constants, `applying` among them,
 *    and ListAppRequests.php takes any of them as `?status=`.
 * 2. `siren apps apply` writes SIREN_BASE_URL to `.env.sandbox` beside the
 *    key, and a sandbox ask's answerUrl is on that host. The client reads
 *    SIREN_BASE_URL as its default base, the way it reads SIREN_API_KEY,
 *    and a baseUrl passed in code wins.
 */

const SECRET = 'a-secret-for-the-pass-4-additions';
const LOCAL = 'http://siren.local:8080/siren/v1';

afterEach(() => {
  vi.unstubAllEnvs();
});

const pathOf = (url: string) => `${new URL(url).origin}${new URL(url).pathname}`;

describe('every request status Siren returns', () => {
  it('holds the eight statuses of AppRequest.php at 0383186437', () => {
    expect(Object.values(AppRequestStatus)).toEqual([
      'pending',
      'sent',
      'delivered',
      'answered',
      'applying',
      'applied',
      'needs_attention',
      'dropped',
    ]);
  });

  it('lets apps.requests.list() filter by applying', async () => {
    const http = new FakeHttpClient([reply(200, [])]);
    const siren = new Siren({ accessToken: 't', baseUrl: LOCAL, httpClient: http, maxRetries: 0 });
    await siren.apps.requests.list({ status: 'applying' }).catch(() => undefined);
    expect(new URL(http.requests[0]!.url).searchParams.get('status')).toBe('applying');
  });
});

const sirenCheckout = process.env.SIREN_CHECKOUT;
const statusFile = sirenCheckout ? resolve(sirenCheckout, 'lib/Apps/Core/Models/AppRequest.php') : undefined;

describe.skipIf(statusFile === undefined)('request statuses read from AppRequest.php (set SIREN_CHECKOUT to run)', () => {
  it('has every STATUS_* constant and nothing more', () => {
    expect(existsSync(statusFile!), statusFile).toBe(true);
    const php = readFileSync(statusFile!, 'utf8');
    const statuses = [...php.matchAll(/const STATUS_[A-Z_]+ = '([^']+)';/g)].map((match) => match[1]!);
    expect(statuses.length).toBeGreaterThan(0);
    expect([...Object.values(AppRequestStatus)].sort()).toEqual([...statuses].sort());
  });
});

describe('SIREN_BASE_URL', () => {
  it('is the default base, for an API key from the environment or a token', async () => {
    vi.stubEnv('SIREN_BASE_URL', LOCAL);
    vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
    for (const options of [{}, { accessToken: 't' }]) {
      const http = new FakeHttpClient([reply(200, [])]);
      await new Siren({ ...options, httpClient: http, maxRetries: 0 }).apps.requests.list().catch(() => undefined);
      expect(pathOf(http.requests[0]!.url)).toBe(`${LOCAL}/apps/requests`);
    }
  });

  it('gives way to a baseUrl passed in code', async () => {
    vi.stubEnv('SIREN_BASE_URL', LOCAL);
    const http = new FakeHttpClient([reply(200, [])]);
    await new Siren({ accessToken: 't', baseUrl: 'http://other.local/siren/v1', httpClient: http, maxRetries: 0 }).apps.requests.list().catch(() => undefined);
    expect(pathOf(http.requests[0]!.url)).toBe('http://other.local/siren/v1/apps/requests');
  });

  it('names SIREN_BASE_URL when its value is refused', () => {
    vi.stubEnv('SIREN_BASE_URL', 'not a url');
    expect(() => new Siren({ accessToken: 't' })).toThrow(/SIREN_BASE_URL/);
    vi.stubEnv('SIREN_BASE_URL', 'https://api.sirenaffiliates.com/siren/v1');
    const sandboxKey = `sk_test_${'a'.repeat(64)}`;
    expect(() => new Siren({ apiKey: sandboxKey })).toThrow(SirenError);
    expect(() => new Siren({ apiKey: sandboxKey })).toThrow(/SIREN_BASE_URL/);
  });

  it('signs a sandbox ask for that host, and the handler answers it there', async () => {
    vi.stubEnv('SIREN_BASE_URL', LOCAL);
    vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
    vi.stubEnv('SIREN_SIGNING_SECRET', SECRET);
    const http = new FakeHttpClient([reply(200, { status: 'accepted', duplicate: false })]);
    const errors: unknown[] = [];
    const answers = new Siren({ httpClient: http, maxRetries: 0 }).apps.requestHandler({ onError: (error) => errors.push(error) });
    answers.on('payoutMethod', 'acme-ledger', () => ({ outcome: 'failed', reason: 'A test request, so nothing was paid.' }));

    const request = appRequest('payoutMethod', 'acme-ledger', { test: true });
    expect((JSON.parse(request.rawBody) as { answerUrl: string }).answerUrl.startsWith(`${LOCAL}/apps/requests/`)).toBe(true);
    const result = await answers.handle(request);
    expect(result.status).toBe(200);
    await result.after!();
    expect(errors).toEqual([]);
    expect(http.requests).toHaveLength(1);
    expect(pathOf(http.requests[0]!.url).startsWith(`${LOCAL}/apps/requests/`)).toBe(true);
  });
});
