import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appChanges } from '../src/cli/app-changes';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type { App, AppAsk, AppFeatureFunctions, AppIncentiveTypeAnswer, AppIncentiveTypeQuestion } from '../src/record-types';
import { AppItemKind } from '../src/taxonomy';
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

function file(items: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', url: ADDRESS, items } } });
}

describe('apps-c16-6: the incentive type kind', () => {
  it('names the kind with the value Siren stores and the name its catalog gives', () => {
    expect(AppItemKind.IncentiveType).toBe('incentiveType');
    expect(kindLabel('incentiveType')).toBe('Incentive structure (incentiveType)');
  });

  it("types Siren's sample question and answer, and the handler's function for the kind", async () => {
    const question = features.kinds.incentiveType!.request.data as AppIncentiveTypeQuestion;
    expect(question.engagements.map((engagement) => [engagement.engagementId, engagement.createdDate])).toEqual([
      [880, '2026-11-02T09:15:00+00:00'],
      [881, '2026-11-09T16:40:00+00:00'],
    ]);
    const decide: AppFeatureFunctions['incentiveType'] = ({ data }) => {
      const sale = data.transaction;
      if (sale === null || sale.units !== data.program.units) return { outcome: 'none' };
      return { outcome: 'award', units: sale.units, pool: Math.floor(sale.total / 10), engagementIds: data.engagements.map((e) => e.engagementId) };
    };
    expect(await decide({ data: question } as AppAsk<AppIncentiveTypeQuestion>)).toEqual(features.kinds.incentiveType!.answer);
    expect(await decide({ data: { ...question, transaction: null, binding: { type: 'crm_lead', id: 'L-1' } } } as AppAsk<AppIncentiveTypeQuestion>)).toEqual({
      outcome: 'none',
    });
  });

  it('reads an incentive type with its conversions and declares them in the catalog order', () => {
    const parsed = parseAppFile(file({ deals: { kind: 'incentiveType', name: 'Pay on deals', conversionTypes: ['renewal', 'sale'] } }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.items).toEqual([
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
      `apps.${APP_KEY}.items.${key}.conversionTypes is required for an Incentive structure (incentiveType): a list of the conversions it pays, each once, from sale, lead, renewal.`;
    expect(parsed.problems.map((problem) => problem.message)).toEqual([
      required('none'),
      required('empty'),
      required('twice'),
      required('refund'),
      `apps.${APP_KEY}.items.filter.conversionTypes is only for an Incentive structure (incentiveType).`,
    ]);
  });

  it('declare and the item routes send conversionTypes, and apply shows a changed set', async () => {
    const item = { kind: AppItemKind.IncentiveType, key: 'deals', name: 'Pay on deals', conversionTypes: ['sale' as const, 'renewal' as const] };
    const over = transportOver([reply(200, appRecord()), reply(201, appRecord().items[0]), reply(200, appRecord().items[0])]);
    const apps = new AppsResource(over.transport);
    await apps.declare(APP_KEY, { name: 'Acme', url: ADDRESS, items: [item] });
    await apps.items.create(APP_KEY, { kind: AppItemKind.IncentiveType, name: 'Pay on deals', conversionTypes: ['lead'] });
    await apps.items.update(APP_KEY, 3, { conversionTypes: ['sale'] });
    expect((bodyOf(over.http.requests[0]!) as { items: unknown[] }).items).toEqual([item]);
    expect(bodyOf(over.http.requests[1]!)).toMatchObject({ kind: 'incentiveType', conversionTypes: ['lead'] });
    expect(bodyOf(over.http.requests[2]!)).toEqual({ conversionTypes: ['sale'] });

    const have = appRecord({
      items: [{ ...appRecord().items[0], kind: 'incentiveType', key: 'deals', name: 'Pay on deals', settings: { conversionTypes: ['sale'] } }],
    }) as unknown as App;
    expect(appChanges(have, { name: 'Acme', description: "Siren's example app.", url: ADDRESS, items: [item] }).lines).toEqual([
      'changes feature deals, Incentive structure (incentiveType): conversions it pays',
    ]);
    const same = { ...item, conversionTypes: ['sale' as const] };
    expect(appChanges(have, { name: 'Acme', description: "Siren's example app.", url: ADDRESS, items: [same] }).lines).toEqual([]);
  });

  it('sends both answers through the one answer route', async () => {
    const award = features.kinds.incentiveType!.answer as AppIncentiveTypeAnswer;
    const none: AppIncentiveTypeAnswer = { outcome: 'none' };
    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    for (const answer of [award, none]) {
      expect(await resource.requests.answer(APP_REQUEST_ID, answer)).toEqual(accepted);
    }
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([award, none]);
  });
});
