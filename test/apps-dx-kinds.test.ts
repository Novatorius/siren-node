import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { SirenError } from '../src/errors';
import { kindLabel } from '../src/cli/app-kinds';
import { FEATURE_KIND_NAMES } from '../src/resources/app-feature-kinds';
import { FeatureKind } from '../src/taxonomy';
import { appRequest } from '../src/testing';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * DX pass 2, finding 1 (review/sdk-dx/pass-2-review.md in the apps run
 * folder): `on()` refuses a kind Siren never sends when the function is
 * registered, and says what to write instead. The list is the 13 kinds
 * Siren's registry snapshot (src/app-kinds.json) marks tell or ask, which
 * leaves out `customEvent`. Siren's own contract file
 * (test/fixtures/apps-feature-contracts/requests.json) holds one request
 * for each. test/feature-kind.test.ts holds the snapshot itself.
 */

const SECRET = 'a-secret-for-the-kind-checks';

interface FeatureFixture {
  kinds: Record<string, unknown>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;

function handler(options: { extraKinds?: readonly string[] } = {}) {
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]) });
  return siren.apps.requestHandler({ signingSecret: SECRET, onError: () => undefined, ...options });
}

/** The message `on(kind, fn)` and `on(kind, key, fn)` both refuse `kind` with. */
function refusal(kind: string, options: { extraKinds?: readonly string[] } = {}): string {
  const messages = [
    () => handler(options).on(kind as never, (() => undefined) as never),
    () => handler(options).on(kind as never, 'a-key', (() => undefined) as never),
  ].map((register) => {
    try {
      register();
    } catch (error) {
      expect(error).toBeInstanceOf(SirenError);
      return (error as Error).message;
    }
    throw new Error(`on() took ${kind}`);
  });
  expect(messages[0]).toBe(messages[1]);
  return messages[0]!;
}

describe('DX pass 2, finding 1: on() takes only a kind Siren sends', () => {
  it("holds the 13 kinds Siren sends, equal to Siren's contract file, with the names Siren's registry gives", () => {
    expect(Object.keys(FEATURE_KIND_NAMES).sort()).toEqual(Object.keys(features.kinds).sort());
    expect(Object.keys(FEATURE_KIND_NAMES).sort()).toEqual(
      Object.values(FeatureKind)
        .filter((kind) => kind !== 'customEvent')
        .sort(),
    );
    for (const [kind, name] of Object.entries(FEATURE_KIND_NAMES)) {
      expect(kindLabel(kind)).toBe(`${name} (${kind})`);
    }
  });

  it('takes every kind Siren sends, both ways', () => {
    for (const kind of Object.keys(FEATURE_KIND_NAMES)) {
      const answers = handler();
      expect(answers.on(kind as never, 'a-key', (() => answers.later()) as never)).toBe(answers);
      expect(answers.on(kind as never, (() => answers.later()) as never)).toBe(answers);
    }
  });

  it.each([
    ['distributionResolvr', 'distributionResolvr is not a feature kind. Did you mean distributionResolver?'],
    ['DistributionResolver', 'DistributionResolver is not a feature kind. Did you mean distributionResolver?'],
    ['payoutMethd', 'payoutMethd is not a feature kind. Did you mean payoutMethod?'],
    ['attributionModel', 'The kind for Attribution model is incentiveResolver.'],
    ['Attribution model', 'The kind for Attribution model is incentiveResolver.'],
    ['customer filter for programs', 'The kind for Customer filter for programs is engagementFilter.'],
    ['incentiveStructure', 'The kind for Incentive structure is incentiveType.'],
    ['distribution_resolver', 'Kinds are camelCase, as Siren sends them: distributionResolver.'],
    ['post_conversion_action', 'Kinds are camelCase, as Siren sends them: postConversionAction.'],
    ['customEvent', 'Siren never sends a custom event. Your app sends one with events.ingest().'],
    ['conversion.approved', 'conversion.approved is a webhook event. Register it with onEvent().'],
    ['fulfillmentMethod', 'fulfillmentMethod is the old name. Use payoutMethod.'],
  ])('refuses %s and says what to write instead', (kind, words) => {
    expect(refusal(kind)).toBe(words);
  });

  it('lists the kinds for any other name, and names the extraKinds option', () => {
    expect(refusal('somethingElse')).toBe(
      'somethingElse is not a feature kind. The kinds are: ' +
        Object.keys(FEATURE_KIND_NAMES).join(', ') +
        '. Pass a kind newer than this SDK in the extraKinds option.',
    );
  });

  it('takes a kind a newer Siren sends when extraKinds names it, and still refuses the rest', async () => {
    const answers = handler({ extraKinds: ['brandNewKind'] });
    answers.on('brandNewKind', 'a-key', () => ({ outcome: 'done' }));
    expect(() => answers.on('anotherNewKind' as never, 'a-key', (() => undefined) as never)).toThrow(/is not a feature kind/);
    const result = await answers.simulate(appRequest('brandNewKind', 'a-key', { secret: SECRET, baseUrl: BASE, data: {} }));
    expect(result.status).toBe(200);
    expect(result.answer).toEqual({ outcome: 'done' });
    expect(result.error).toBeUndefined();
  });

  it('refuses extraKinds that is not a list of kind names when it is made', () => {
    for (const extraKinds of ['brandNewKind', [''], [3], [null]]) {
      expect(() => handler({ extraKinds: extraKinds as never })).toThrow(
        'apps.requestHandler() takes extraKinds as a list of kind names, such as [\'brandNewKind\'].',
      );
    }
  });
});

describe("DX pass 2, finding 5: the old payout kind's name is gone", () => {
  it('drops FeatureKind.FulfillmentMethod', () => {
    expect(Object.keys(FeatureKind)).not.toContain('FulfillmentMethod');
    expect(Object.values(FeatureKind)).not.toContain('fulfillmentMethod');
    expect(readFileSync(new URL('../src/taxonomy.ts', import.meta.url), 'utf8')).not.toContain('FulfillmentMethod');
  });

  it("names the dedupe id in the request type's doc comments", () => {
    const types = readFileSync(new URL('../src/record-types.ts', import.meta.url), 'utf8');
    const base = types.slice(types.indexOf('interface AppRequestBase'), types.indexOf('export interface AppTell'));
    expect(base).toContain('the same on every send of this request, so write once by `id`');
    expect(base).toContain('`feature.id` names the feature');
    expect(base).toContain('changes on every send');
  });
});
