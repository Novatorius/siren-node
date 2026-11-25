import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appChanges } from '../src/cli/app-changes';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type { App, AppAsk, AppFeatureFunctions, IncentiveTypeAnswer, IncentiveTypeQuestion } from '../src/record-types';
import { FeatureKind } from '../src/taxonomy';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord } from './apps-siren-answers';

/*
 * Slice C16-6 in the Node SDK: the `incentiveType` kind and its
 * `conversionTypes` setting. The kind's name and setting are Siren's catalog
 * entry for slice C16-6 (AppItemKindCatalog.php on Siren's pkt/apps-c16-6),
 * and the question and answer are that slice's contract
 * (AppIncentiveTypeQuestion.php there, the design note
 * c16-nine-registries.md, section 5). The question here is Siren's own
 * sample, test/fixtures/apps-feature-contracts/requests.json.
 */

const ADDRESS = 'https://acme.example/siren';

interface FeatureFixture {
  kinds: Record<string, { request: { data: unknown }; answer: unknown }>;
}
const features = JSON.parse(readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8')) as FeatureFixture;

function file(declared: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', url: ADDRESS, features: declared } } });
}

describe('apps-c16-6: the incentive type kind', () => {
  it('names the kind with the value Siren stores and the name its catalog gives', () => {
    expect(FeatureKind.IncentiveType).toBe('incentiveType');
    expect(kindLabel('incentiveType')).toBe('Incentive structure (incentiveType)');
  });

  it("types Siren's sample question and answer, and the handler's function for the kind", async () => {
    const question = features.kinds.incentiveType!.request.data as IncentiveTypeQuestion;
    expect(question.engagements.map((engagement) => [engagement.engagementId, engagement.createdDate])).toEqual([
      [880, '2026-11-02T09:15:00+00:00'],
      [881, '2026-11-09T16:40:00+00:00'],
    ]);
    const decide: AppFeatureFunctions['incentiveType'] = ({ data }) => {
      const sale = data.transaction;
      if (sale === null || sale.units !== data.program.units) return { outcome: 'none' };
      return { outcome: 'award', units: sale.units, pool: Math.floor(sale.total / 10), engagementIds: data.engagements.map((e) => e.engagementId) };
    };
    expect(await decide({ data: question } as AppAsk<IncentiveTypeQuestion>)).toEqual(features.kinds.incentiveType!.answer);
    expect(await decide({ data: { ...question, transaction: null, binding: { type: 'crm_lead', id: 'L-1' } } } as AppAsk<IncentiveTypeQuestion>)).toEqual({
      outcome: 'none',
    });
  });

  it('reads an incentive type with its conversions and declares them in the catalog order', () => {
    const parsed = parseAppFile(file({ deals: { kind: 'incentiveType', name: 'Pay on deals', conversionTypes: ['renewal', 'sale'] } }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.features).toEqual([
      { kind: 'incentiveType', key: 'deals', name: 'Pay on deals', conversionTypes: ['sale', 'renewal'] },
    ]);
  });

  it('refuses an incentive type with no conversions, a repeated one or an unknown one, and conversionTypes on any other kind', () => {
    const parsed = parseAppFile(
      file({
        none: { kind: 'incentiveType', name: 'None' },
        empty: { kind: 'incentiveType', name: 'Empty', conversionTypes: [] },
        twice: { kind: 'incentiveType', name: 'Twice', conversionTypes: ['sale', 'sale'] },
        refund: { kind: 'incentiveType', name: 'Refund', conversionTypes: ['refund'] },
        filter: { kind: 'metricFilter', name: 'Filter', conversionTypes: ['sale'] },
      }),
      {},
    );
    const required = (key: string) =>
      `apps.${APP_KEY}.features.${key}.conversionTypes is required for an Incentive structure (incentiveType): a list of the conversions it pays, each once, from sale, lead, renewal.`;
    expect(parsed.problems.map((problem) => problem.message)).toEqual([
      required('none'),
      required('empty'),
      required('twice'),
      required('refund'),
      `apps.${APP_KEY}.features.filter.conversionTypes is only for an Incentive structure (incentiveType).`,
    ]);
  });

  it('declare and the feature routes send conversionTypes, and apply shows a changed set', async () => {
    const feature = { kind: FeatureKind.IncentiveType, key: 'deals', name: 'Pay on deals', conversionTypes: ['sale' as const, 'renewal' as const] };
    const over = transportOver([reply(200, appRecord()), reply(201, appRecord().features[0]), reply(200, appRecord().features[0])]);
    const apps = new AppsResource(over.transport);
    await apps.declare(APP_KEY, { name: 'Acme', url: ADDRESS, features: [feature] });
    await apps.features.create(APP_KEY, { kind: FeatureKind.IncentiveType, name: 'Pay on deals', conversionTypes: ['lead'] });
    await apps.features.update(APP_KEY, 3, { conversionTypes: ['sale'] });
    expect((bodyOf(over.http.requests[0]!) as { features: unknown[] }).features).toEqual([feature]);
    expect(bodyOf(over.http.requests[1]!)).toMatchObject({ kind: 'incentiveType', conversionTypes: ['lead'] });
    expect(bodyOf(over.http.requests[2]!)).toEqual({ conversionTypes: ['sale'] });

    const have = appRecord({
      features: [{ ...appRecord().features[0], kind: 'incentiveType', key: 'deals', name: 'Pay on deals', settings: { conversionTypes: ['sale'] } }],
    }) as unknown as App;
    expect(appChanges(have, { name: 'Acme', description: "Siren's example app.", url: ADDRESS, features: [feature] }).lines).toEqual([
      'changes feature deals, Incentive structure (incentiveType): conversions it pays',
    ]);
    const same = { ...feature, conversionTypes: ['sale' as const] };
    expect(appChanges(have, { name: 'Acme', description: "Siren's example app.", url: ADDRESS, features: [same] }).lines).toEqual([]);
  });

  it('sends both answers through the one answer route', async () => {
    const award = features.kinds.incentiveType!.answer as IncentiveTypeAnswer;
    const none: IncentiveTypeAnswer = { outcome: 'none' };
    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    for (const answer of [award, none]) {
      expect(await resource.requests.answer(APP_REQUEST_ID, answer)).toEqual(accepted);
    }
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([award, none]);
  });
});
