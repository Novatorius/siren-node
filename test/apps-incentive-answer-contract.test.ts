import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import type { AppAsk, AppRewardQuestion } from '../src/record-types';
import type { AppFunctionFor } from '../src/resources/app-request-handler';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * Slice C16-2: the answer the request handler's incentive resolver sample
 * builds with `apps.splitPool()` passes Siren's answer check for the kind.
 *
 * The question is Siren's own fixture (tests/Fixtures/apps-feature-contracts/
 * requests.json on Siren's pkt/apps-c16-2), the same file this SDK copies.
 * `refusalOf()` holds the rules of Siren's AppRewardQuestion::validate(), in
 * its order, and Siren's AppFeatureContractsTest runs the fixture's answer
 * through validate() itself. This test checks the sample's answer equals that
 * answer and meets the same rules, so a change on either side fails here.
 */

interface FeatureFixture {
  kinds: Record<string, { request: { data: unknown }; answer: Record<string, unknown> | null }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]) });

/** Siren's AppRewardQuestion::validate(): the reason it refuses the answer with 422, or null. */
function refusalOf(question: AppRewardQuestion, answer: Record<string, unknown>): string | null {
  if (answer.outcome !== 'rewards') return 'outcome';
  if (answer.units !== question.pool.units) return 'units';
  const rewards = answer.rewards;
  if (typeof rewards !== 'object' || rewards === null || Array.isArray(rewards)) return 'rewards';
  const asked = question.conversions.map((conversion) => conversion.conversionId);
  for (const [key, value] of Object.entries(rewards as Record<string, unknown>)) {
    if (!asked.includes(Number(key)) || String(Number(key)) !== key) return `unknown ${key}`;
    if (value !== null && (!Number.isInteger(value) || (value as number) < 0)) return `not whole ${key}`;
    if (value !== null && (value as number) > question.pool.value) return `above the pool ${key}`;
  }
  for (const id of asked) {
    if (!(String(id) in (rewards as Record<string, unknown>))) return `missing ${id}`;
  }
  return null;
}

describe("C16-2: the incentive resolver sample answer meets Siren's check", () => {
  it("splitPool over Siren's fixture question gives an answer Siren takes", async () => {
    const entry = fixture.kinds.incentiveResolver!;
    const data = entry.request.data as AppRewardQuestion;

    // The sample's function, as README and test/answer-samples/incentive-resolver.js
    // write it, typed as on('incentiveResolver', ...) takes it.
    const sample: AppFunctionFor<'incentiveResolver'> = ({ data: question }) => ({
      outcome: 'rewards',
      units: question.pool.units,
      rewards: siren.apps.splitPool(question.pool, question.conversions.map((conversion) => [conversion.conversionId, conversion.score])),
    });
    const answer = (await sample({ data } as AppAsk<AppRewardQuestion>))!;

    expect(refusalOf(data, answer as unknown as Record<string, unknown>)).toBeNull();
    expect(answer).toEqual(entry.answer);
    expect(refusalOf(data, { ...answer, rewards: { ...answer.rewards, '1042': data.pool.value + 1 } })).toBe('above the pool 1042');
  });
});
