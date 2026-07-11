import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  SirenError,
  ValidationError,
} from '../src/index';
import { emptyResponse, jsonResponse, makeClient } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Structured (object) error body — used by login/entitlement endpoints. */
function structuredErr(message: string, code?: string, data?: unknown) {
  return { error: { message, code, data } };
}

/** Plain-string error body — the shape most endpoints emit. */
function stringErr(message: string) {
  return { error: message };
}

describe('error mapping by status', () => {
  const cases: Array<[number, unknown, string]> = [
    [400, BadRequestError, 'bad request'],
    [401, AuthenticationError, 'invalid api key'],
    [403, PermissionError, 'missing scope'],
    [404, NotFoundError, 'no such sale'],
    [409, ConflictError, 'already exists'],
    [422, ValidationError, 'validation failed'],
    [500, ApiError, 'server exploded'],
    [503, ApiError, 'unavailable'],
  ];

  for (const [status, ErrorClass, message] of cases) {
    it(`maps ${status} to ${(ErrorClass as { name: string }).name} (structured body)`, async () => {
      const ctx = makeClient([jsonResponse(status, structuredErr(message, `code_${status}`))], {
        maxRetries: 0,
      });

      const err = await ctx.client.conversions.list().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ErrorClass as never);
      expect(err).toBeInstanceOf(SirenError);
      const sirenErr = err as SirenError;
      expect(sirenErr.message).toBe(message);
      expect(sirenErr.code).toBe(`code_${status}`);
      expect(sirenErr.statusCode).toBe(status);
    });
  }

  it('parses the plain-string error shape: message set, code null', async () => {
    const ctx = makeClient([jsonResponse(404, stringErr('no such sale'))], { maxRetries: 0 });

    const err = await ctx.client.events
      .refund({ source: 'stripe', externalId: 'nope' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toBe('no such sale');
    expect((err as NotFoundError).code).toBeUndefined();
  });

  it('does not treat a string error body as field errors on ValidationError', async () => {
    const ctx = makeClient([jsonResponse(422, stringErr('total must be positive'))], {
      maxRetries: 0,
    });

    const err = await ctx.client.conversions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toBe('total must be positive');
    expect((err as ValidationError).fieldErrors).toBeUndefined();
  });

  it('maps 429 to RateLimitError and exposes retryAfter from the header', async () => {
    const ctx = makeClient(
      [jsonResponse(429, structuredErr('slow down', 'rate_limited'), { 'Retry-After': '17' })],
      { maxRetries: 0 },
    );

    const err = await ctx.client.conversions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(17);
    expect((err as RateLimitError).statusCode).toBe(429);
  });

  it('exposes field errors on ValidationError from error.data', async () => {
    const fieldErrors = { total: 'must be a positive number', source: 'required' };
    const ctx = makeClient(
      [jsonResponse(422, structuredErr('validation failed', 'invalid_payload', fieldErrors))],
      { maxRetries: 0 },
    );

    const err = await ctx.client.events
      .sale({ source: '', externalId: 'x', total: -1, trackingId: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors).toEqual(fieldErrors);
    expect((err as ValidationError).data).toEqual(fieldErrors);
  });

  it('falls back to the HTTP status text when the body is not JSON', async () => {
    const ctx = makeClient(
      [new Response('<html>gateway</html>', { status: 502, statusText: 'Bad Gateway' })],
      { maxRetries: 0 },
    );

    const err = await ctx.client.conversions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Bad Gateway');
  });

  it('falls back to a status message when there is no error key at all', async () => {
    const ctx = makeClient([jsonResponse(500, { unrelated: true })], { maxRetries: 0 });

    const err = await ctx.client.conversions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('500');
  });

  it('maps network failures to ConnectionError with the cause attached', async () => {
    const cause = new TypeError('fetch failed');
    const ctx = makeClient([cause], { maxRetries: 0 });

    const err = await ctx.client.payouts.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).cause).toBe(cause);
  });
});

describe('retry behavior', () => {
  it('retries idempotent reads on 5xx and succeeds', async () => {
    vi.useFakeTimers();
    const ctx = makeClient(
      [jsonResponse(500, structuredErr('flaky')), jsonResponse(200, [{ id: 1 }])],
      { maxRetries: 2 },
    );

    const promise = ctx.client.conversions.list();
    await vi.advanceTimersByTimeAsync(10_000);
    const page = await promise;

    expect(page).toEqual([{ id: 1 }]);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries event ingestion on network errors', async () => {
    vi.useFakeTimers();
    const ctx = makeClient(
      [new TypeError('socket hang up'), emptyResponse(200, { 'X-Siren-OID': '42' })],
      { maxRetries: 2 },
    );

    const promise = ctx.client.events.sale({
      source: 'stripe',
      externalId: 'x',
      total: 9.99,
      trackingId: 1,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result).toEqual({ opportunityId: 42 });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on 429 before retrying', async () => {
    const ctx = makeClient(
      [
        jsonResponse(429, structuredErr('slow down'), { 'Retry-After': '0' }),
        jsonResponse(200, []),
      ],
      { maxRetries: 1 },
    );

    const page = await ctx.client.conversions.list();
    expect(page).toEqual([]);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and throws the mapped error', async () => {
    vi.useFakeTimers();
    const ctx = makeClient([jsonResponse(500, structuredErr('still broken'))], { maxRetries: 1 });

    const promise = ctx.client.conversions.list().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await promise;

    expect(err).toBeInstanceOf(ApiError);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never auto-retries API key creation', async () => {
    const ctx = makeClient([jsonResponse(500, structuredErr('boom'))], { maxRetries: 3 });

    await expect(ctx.client.apiKeys.create({ label: 'Production server' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retriable statuses like 401', async () => {
    const ctx = makeClient([jsonResponse(401, structuredErr('bad key'))], { maxRetries: 3 });

    await expect(ctx.client.conversions.list()).rejects.toBeInstanceOf(AuthenticationError);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('apiKeys resource', () => {
  it('creates a key and surfaces the one-time rawKey', async () => {
    const ctx = makeClient([
      jsonResponse(201, {
        id: 9,
        keyPrefix: 'sk_live_a1b2c3d4',
        label: 'Production server',
        status: 'active',
        rawKey: `sk_live_${'b'.repeat(64)}`,
      }),
    ]);

    const key = await ctx.client.apiKeys.create({ label: 'Production server' });
    expect(ctx.lastCall().url).toBe('https://api.sirenaffiliates.com/siren/v1/api-keys');
    expect(ctx.lastCall().body).toEqual({ label: 'Production server' });
    expect(key.rawKey).toBe(`sk_live_${'b'.repeat(64)}`);
  });

  it('lists keys and revokes by id', async () => {
    const ctx = makeClient([
      jsonResponse(200, [{ id: 9, label: 'Production server' }]),
      emptyResponse(200),
    ]);

    const keys = await ctx.client.apiKeys.list();
    expect(keys).toEqual([{ id: 9, label: 'Production server' }]);

    await ctx.client.apiKeys.revoke(9);
    const call = ctx.lastCall();
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/api-keys/9');
  });
});
