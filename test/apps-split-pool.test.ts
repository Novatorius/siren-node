import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { SirenError } from '../src/errors';
import type { AppCurrency, AppDistributionQuestion, AppRewardQuestion } from '../src/record-types';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * `apps.splitPool()`, packet apps-answer-handler. Contract:
 * docs/architecture/apps-request-handler.md, "Splitting a pool".
 *
 * The two resolver answers come from Siren's own fixture, copied byte for
 * byte from tests/Fixtures/apps-feature-contracts/requests.json on Siren's
 * pkt/apps-c16-2 (f97b42820). Siren's AppFeatureContractsTest builds each
 * question with Siren's builders and checks it equals that file, so the
 * split here matches what the feature page shows.
 */

interface FeatureFixture {
  kinds: Record<string, { request: { data: unknown }; answer: Record<string, unknown> | null }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]) });

const USD: AppCurrency = { id: 'USD', symbol: '$', position: 'before', name: 'US Dollar', scale: 2, decimalPlaces: 2, type: 'monetary' };
const JPY: AppCurrency = { id: 'JPY', symbol: '¥', position: 'before', name: 'Japanese Yen', scale: 2, decimalPlaces: 0, type: 'monetary' };

function sum(shares: Record<string, number>): number {
  return Object.values(shares).reduce((total, share) => total + share, 0);
}

function refusal(run: () => unknown): SirenError {
  try {
    run();
  } catch (error) {
    if (error instanceof SirenError) return error;
    throw error;
  }
  throw new Error('splitPool answered instead of refusing');
}

describe('apps-answer-handler: apps.splitPool', () => {
  it("splits the distribution resolver's pool as Siren's fixture answers it", () => {
    const entry = fixture.kinds.distributionResolver!;
    const data = entry.request.data as AppDistributionQuestion;
    const shares = siren.apps.splitPool(data.pool, data.metrics.map((metric) => [metric.metricId, metric.score]));
    expect(shares).toEqual((entry.answer as { shares: Record<string, number> }).shares);
    expect(shares).toEqual({ '41': 6000, '43': 4000 });
    expect(sum(shares)).toBeLessThanOrEqual(data.pool.value);
  });

  it("splits the incentive resolver's pool as Siren's fixture answers it", () => {
    const entry = fixture.kinds.incentiveResolver!;
    const data = entry.request.data as AppRewardQuestion;
    const rewards = siren.apps.splitPool(data.pool, data.conversions.map((conversion) => [conversion.conversionId, conversion.score]));
    expect(rewards).toEqual((entry.answer as { rewards: Record<string, number> }).rewards);
    expect(rewards).toEqual({ '1042': 900, '1043': 600 });
  });

  it('splits a dollar pool in whole cents, rounded down so the sum never passes the pool', () => {
    const pool = { value: 1000, currency: USD };
    const shares = siren.apps.splitPool(pool, { a: 1, b: 1, c: 1 });
    expect(shares).toEqual({ a: 333, b: 333, c: 333 });
    expect(sum(shares)).toBe(999);
    expect(sum(shares)).toBeLessThanOrEqual(pool.value);
  });

  it('splits a yen pool (scale 2, no decimal places) in whole yen, multiples of 100 stored', () => {
    const pool = { value: 100_000, currency: JPY };
    const shares = siren.apps.splitPool(pool, [
      ['7', 2],
      ['8', 1],
      ['9', 1],
    ]);
    expect(shares).toEqual({ '7': 50_000, '8': 25_000, '9': 25_000 });
    const thirds = siren.apps.splitPool(pool, { x: 1, y: 1, z: 1 });
    expect(thirds).toEqual({ x: 33_300, y: 33_300, z: 33_300 });
    for (const share of Object.values(thirds)) expect(share % 100).toBe(0);
    expect(sum(thirds)).toBeLessThanOrEqual(pool.value);
  });

  it('drops a pool remainder smaller than one step', () => {
    // 150 stored yen is 1.5 yen, which no one can see, so only 100 is split.
    expect(siren.apps.splitPool({ value: 150, currency: JPY }, { a: 1 })).toEqual({ a: 100 });
  });

  it('splits evenly when every weight is 0', () => {
    const pool = { value: 1000, currency: USD };
    const shares = siren.apps.splitPool(pool, { a: 0, b: 0, c: 0 });
    expect(shares).toEqual({ a: 333, b: 333, c: 333 });
    expect(sum(shares)).toBeLessThanOrEqual(pool.value);
    expect(siren.apps.splitPool({ value: 100_000, currency: JPY }, [[1, 0], [2, 0], [3, 0]])).toEqual({
      '1': 33_300,
      '2': 33_300,
      '3': 33_300,
    });
  });

  it('gives a weight of 0 nothing when another weight is above 0', () => {
    expect(siren.apps.splitPool({ value: 1000, currency: USD }, { a: 0, b: 5 })).toEqual({ a: 0, b: 1000 });
  });

  it('splits fractional weights in whole steps, rounded down', () => {
    expect(siren.apps.splitPool({ value: 1000, currency: USD }, { a: 1.5, b: 1.5, c: 1.5 })).toEqual({ a: 333, b: 333, c: 333 });
    expect(siren.apps.splitPool({ value: 100_000, currency: JPY }, { a: 0.5, b: 0.25, c: 0.25 })).toEqual({ a: 50_000, b: 25_000, c: 25_000 });
  });

  it('keeps the sum within the pool for fractional weights', () => {
    const pool = { value: 999_999, currency: USD };
    const weights = { a: 0.1, b: 0.2, c: 0.3, d: 1 / 3, e: Math.PI };
    const shares = siren.apps.splitPool(pool, weights);
    expect(sum(shares)).toBeLessThanOrEqual(pool.value);
    for (const share of Object.values(shares)) expect(Number.isSafeInteger(share) && share >= 0).toBe(true);
  });

  it('answers an empty object for no weights', () => {
    expect(siren.apps.splitPool({ value: 1000, currency: USD }, {})).toEqual({});
    expect(siren.apps.splitPool({ value: 1000, currency: USD }, [])).toEqual({});
  });

  it('refuses a negative or non-finite weight with SirenError', () => {
    const pool = { value: 1000, currency: USD };
    for (const weight of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const error = refusal(() => siren.apps.splitPool(pool, { a: 1, b: weight }));
      expect(error.message).toContain('apps.splitPool()');
      expect(error.message).toContain('b');
    }
    expect(refusal(() => siren.apps.splitPool(pool, { a: '3' as unknown as number })).message).toContain('a');
  });

  it('refuses a pool it cannot split, and an id given twice', () => {
    const refuse = (pool: unknown, weights: unknown = { a: 1 }) =>
      refusal(() => siren.apps.splitPool(pool as { value: number; currency: AppCurrency }, weights as Record<string, number>));
    expect(refuse({ value: -1, currency: USD }).message).toContain('pool.value');
    expect(refuse({ value: 1.5, currency: USD }).message).toContain('pool.value');
    expect(refuse({ value: 100, currency: { scale: 2 } }).message).toContain('decimalPlaces');
    expect(refuse({ value: 100, currency: { scale: 9, decimalPlaces: 0 } }).message).toContain('scale');
    expect(refuse(null).message).toContain('pool');
    expect(refuse({ value: 100, currency: USD }, [[1, 1], ['1', 2]]).message).toContain('1');
    expect(refuse({ value: 100, currency: USD }, 'a').message).toContain('weights');
  });
});
