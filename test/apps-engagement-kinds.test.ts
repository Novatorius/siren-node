import { describe, expect, it } from 'vitest';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type {
  EngagementCalculationAnswer,
  EngagementCalculationQuestion,
  EngagementFilterAnswer,
  EngagementFilterQuestion,
  AppFeatureFunctions,
} from '../src/record-types';
import { FeatureKind } from '../src/taxonomy';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID } from './apps-siren-answers';

/*
 * Slice C16-4 in the Node SDK: the two engagement kinds,
 * `engagementCalculation` and `engagementFilter`. Their names are Siren's
 * catalog entries on pkt/apps-c16-4 (lib/Apps/Core/Enums/AppItemKindCatalog.php),
 * and the questions are AppEngagementQuestion::forCalculation() and
 * forFilter(), copied from the feature contracts fixture there
 * (tests/Fixtures/apps-feature-contracts/requests.json).
 */

const URL = 'https://acme.example/siren';

/** Siren's example calculation question, from the feature contracts fixture. */
const CALCULATION: EngagementCalculationQuestion = {
  program: { id: 3, name: 'Partner program' },
  engagementType: 'referredSiteVisit',
  programEngagementTypeId: 55,
  args: { weight: '2' },
  opportunity: { id: 615, customerId: 77 },
  triggeringCollaborator: { id: 42, name: 'Riley Rep' },
  cause: { id: '9f2c4e1a7b3d5c60', event: 'referredSiteVisit', occurredAt: '2026-11-17T12:20:00+00:00' },
};

/** Siren's example filter question, from the feature contracts fixture. */
const FILTER: EngagementFilterQuestion = {
  program: { id: 3, name: 'Partner program' },
  collaborator: { id: 42, name: 'Riley Rep' },
  opportunity: { id: 615, customerId: 77 },
  engagementType: 'referredSiteVisit',
  cause: { id: '4b7e0c9d2a1f3e58', event: 'referredSiteVisit', occurredAt: '2026-11-17T12:20:00+00:00' },
};

function file(declared: Record<string, unknown>, url: string | null = URL): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', ...(url ? { url } : {}), features: declared } } });
}

describe('apps-c16-4: the engagement kinds', () => {
  it('names both kinds with the values Siren stores and the names its catalog gives', () => {
    expect(FeatureKind.EngagementCalculation).toBe('engagementCalculation');
    expect(FeatureKind.EngagementFilter).toBe('engagementFilter');
    expect(kindLabel('engagementCalculation')).toBe('Engagement calculation (engagementCalculation)');
    expect(kindLabel('engagementFilter')).toBe('Customer filter for programs (engagementFilter)');
  });

  it('reads an app file with both kinds and an answer window', () => {
    const parsed = parseAppFile(
      file({
        weight: { kind: 'engagementCalculation', name: 'Visit weight', answerWindowMinutes: 30 },
        staff: { kind: 'engagementFilter', name: 'Staff check' },
      }),
      {},
    );
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.features).toEqual([
      { kind: 'engagementCalculation', key: 'weight', name: 'Visit weight', answerWindowMinutes: 30 },
      { kind: 'engagementFilter', key: 'staff', name: 'Staff check' },
    ]);
  });

  it('lets only a url placeholder go unset for a sandbox, and still refuses one anywhere else (review of PR 94)', () => {
    const elsewhere = parseAppFile(file({ staff: { kind: 'engagementFilter', name: '${SIREN_APP_SHOP}' } }, 'https://${SIREN_APP_HOST}/siren'), {}, { urlMayBeUnset: true });
    expect(elsewhere.file).toBeNull();
    expect(elsewhere.problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features.staff.name`]);
    const inUrl = parseAppFile(file({ staff: { kind: 'engagementFilter', name: 'Staff' } }, 'https://${SIREN_APP_HOST}/siren'), {}, { urlMayBeUnset: true });
    expect(inUrl.problems).toEqual([]);
    expect(inUrl.file === null ? [] : (inUrl as { unset?: string[] }).unset).toEqual(['SIREN_APP_HOST']);
  });

  it('refuses an engagement kind with no url, since Siren asks the app at its address', () => {
    const parsed = parseAppFile(file({ staff: { kind: 'engagementFilter', name: 'Staff' } }, null), {});
    expect(parsed.problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features`]);
  });

  it('refuses scoresMoney on an engagement calculation, which only a metric calculation takes', () => {
    const parsed = parseAppFile(file({ weight: { kind: 'engagementCalculation', name: 'Weight', scoresMoney: true } }), {});
    expect(parsed.problems.map((problem) => problem.message)).toEqual([
      `apps.${APP_KEY}.features.weight.scoresMoney is only for a Metric calculation (metricCalculation).`,
    ]);
  });

  it('types each kind’s function by its question and answer', async () => {
    const calculate: AppFeatureFunctions['engagementCalculation'] = ({ data }) => ({
      outcome: 'engagements',
      results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.opportunity.customerId ? 10 : 1 }],
    });
    const filter: AppFeatureFunctions['engagementFilter'] = ({ data }) =>
      data.collaborator.id === 42 ? { outcome: 'suppress', reason: 'The visitor works for the partner.' } : { outcome: 'allow' };

    const ask = { id: APP_REQUEST_ID, version: 1, type: 'app.request', mode: 'ask', app: APP_KEY, createdAt: '', answerBy: '', answerUrl: '' } as const;
    expect(await calculate({ ...ask, feature: { kind: 'engagementCalculation', key: 'weight', id: 'app:21' }, data: CALCULATION } as never)).toEqual({
      outcome: 'engagements',
      results: [{ collaboratorId: 42, score: 10 }],
    });
    expect(await filter({ ...ask, feature: { kind: 'engagementFilter', key: 'staff', id: 'app:22' }, data: FILTER } as never)).toEqual({
      outcome: 'suppress',
      reason: 'The visitor works for the partner.',
    });
  });

  it('answers both asks with the typed answers, through the one answer route', async () => {
    const engagements: EngagementCalculationAnswer = { outcome: 'engagements', results: [{ collaboratorId: 42, score: 10 }, { collaboratorId: 57, score: 2 }] };
    const nobody: EngagementCalculationAnswer = { outcome: 'engagements', results: [] };
    const suppress: EngagementFilterAnswer = { outcome: 'suppress', reason: 'The visitor works for the partner.' };
    const allow: EngagementFilterAnswer = { outcome: 'allow' };

    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted), reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    for (const answer of [engagements, nobody, suppress, allow]) {
      expect(await resource.requests.answer(APP_REQUEST_ID, answer)).toEqual(accepted);
    }
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([engagements, nobody, suppress, allow]);
  });
});
