import { describe, expect, it } from 'vitest';
import { appChanges } from '../src/cli/app-changes';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type {
  App,
  MetricCalculationAnswer,
  MetricCalculationQuestion,
  MetricFilterAnswer,
  MetricFilterQuestion,
} from '../src/record-types';
import { FeatureKind } from '../src/taxonomy';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord } from './apps-siren-answers';

/*
 * Slice C16-1 in the Node SDK: the two metric kinds, `metricCalculation` and
 * `metricFilter`, and a metric calculation's `scoresMoney` setting. The
 * kinds' names and settings are Siren's catalog entries for slice C16-1, and
 * the question and answer shapes are that slice's contracts (the design
 * note c16-nine-registries.md, sections 10 and 12).
 */

const URL = 'https://acme.example/siren';

function file(declared: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', url: URL, features: declared } } });
}

describe('apps-c16-1: the metric kinds', () => {
  it('names both kinds with the values Siren stores and the names its catalog gives', () => {
    expect(FeatureKind.MetricCalculation).toBe('metricCalculation');
    expect(FeatureKind.MetricFilter).toBe('metricFilter');
    expect(kindLabel('metricCalculation')).toBe('Metric calculation (metricCalculation)');
    expect(kindLabel('metricFilter')).toBe('Customer filter for distributors (metricFilter)');
  });

  it('reads an app file with both kinds and a metric calculation that scores money', () => {
    const parsed = parseAppFile(
      file({
        score: { kind: 'metricCalculation', name: 'Partner score', scoresMoney: true, answerWindowMinutes: 30 },
        owned: { kind: 'metricFilter', name: 'Owned customers' },
      }),
      {},
    );
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.features).toEqual([
      { kind: 'metricCalculation', key: 'score', name: 'Partner score', answerWindowMinutes: 30, scoresMoney: true },
      { kind: 'metricFilter', key: 'owned', name: 'Owned customers' },
    ]);
  });

  it('refuses a scoresMoney that is not true or false', () => {
    const parsed = parseAppFile(file({ score: { kind: 'metricCalculation', name: 'Score', scoresMoney: 'yes' } }), {});
    expect(parsed.problems.map((problem) => problem.message)).toEqual([`apps.${APP_KEY}.features.score.scoresMoney must be true or false.`]);
  });

  it('refuses scoresMoney on any kind but a metric calculation', () => {
    for (const kind of ['metricFilter', 'distributionResolver', 'postConversionAction']) {
      const parsed = parseAppFile(file({ other: { kind, name: 'Other', scoresMoney: false } }), {});
      expect(parsed.problems.map((problem) => problem.message), kind).toEqual([
        `apps.${APP_KEY}.features.other.scoresMoney is only for a Metric calculation (metricCalculation).`,
      ]);
    }
  });

  it('refuses a metric kind with no url, since Siren asks the app at its address', () => {
    const text = JSON.stringify({ version: 1, name: 'A', description: '', apps: { [APP_KEY]: { name: 'A', features: { owned: { kind: 'metricFilter', name: 'Owned' } } } } });
    expect(parseAppFile(text, {}).problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features`]);
  });

  it('declare sends scoresMoney on a feature, and apply shows a changed one', async () => {
    const over = transportOver([reply(200, appRecord())]);
    const feature = { kind: FeatureKind.MetricCalculation, key: 'score', name: 'Score', scoresMoney: true };
    await new AppsResource(over.transport).declare(APP_KEY, { name: 'Acme', url: URL, features: [feature] });
    expect((bodyOf(over.http.requests[0]) as { features: unknown[] }).features).toEqual([feature]);

    const have = appRecord({
      features: [{ ...appRecord().features[0], kind: 'metricCalculation', key: 'score', name: 'Score', settings: {} }],
    }) as unknown as App;
    expect(appChanges(have, { name: 'Acme', description: "Siren's example app.", url: URL, features: [feature] }).lines).toEqual([
      'changes feature score, Metric calculation (metricCalculation): scores money no becomes yes',
    ]);
    expect(appChanges(have, { name: 'Acme', description: "Siren's example app.", url: URL, features: [{ ...feature, scoresMoney: false }] }).lines).toEqual([]);
  });

  it('answers both asks with the typed answers, through the one answer route', async () => {
    const question: MetricCalculationQuestion = {
      distributor: { id: 12, name: 'Partner leaderboard' },
      distribution: { id: 340, periodEnd: '2026-11-30T23:59:59+00:00' },
      metricType: 'referredSiteVisit',
      distributorMetricTypeId: 55,
      triggeringCollaborator: { id: 7, name: 'Riley Rep' },
      opportunityId: 901,
      points: null,
      cause: { id: '9f2c4e1a7b3d5c60', type: 'transaction', causeId: '4512' },
      sale: { transactionId: 4512, conversionId: null, excludedLineIds: [5503] },
    };
    const filter: MetricFilterQuestion = {
      distributor: question.distributor,
      distribution: { id: 340 },
      collaborator: { id: 7, name: 'Riley Rep' },
      metricType: 'referredSiteVisit',
      opportunityId: null,
      points: null,
      cause: { id: '9f2c4e1a7b3d5c60', type: null, causeId: null },
      sale: null,
    };
    const scores: MetricCalculationAnswer = { outcome: 'scores', results: [{ collaboratorId: question.triggeringCollaborator.id, score: 10 }] };
    const suppress: MetricFilterAnswer = { outcome: 'suppress', reason: 'Customer already owned by a partner' };
    const allow: MetricFilterAnswer = { outcome: 'allow' };
    expect(filter.collaborator.id).toBe(7);

    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    for (const answer of [scores, suppress, allow]) {
      expect(await resource.requests.answer(APP_REQUEST_ID, answer)).toEqual(accepted);
    }
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([scores, suppress, allow]);
  });
});
