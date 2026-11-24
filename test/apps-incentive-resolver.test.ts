import { describe, expect, it } from 'vitest';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppErrorCode, ConflictError, appErrorCode } from '../src/errors';
import { AppsResource } from '../src/resources/apps';
import type { AppRewardAnswer, AppRewardQuestion } from '../src/record-types';
import { AppItemKind } from '../src/taxonomy';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID } from './apps-siren-answers';

/*
 * Slice C16-2 in the Node SDK: the incentive resolver kind. Its name is
 * Siren's catalog entry for the slice (lib/Apps/Core/Enums/AppItemKindCatalog.php
 * on Siren's pkt/apps-c16-2), the question is AppRewardQuestion::build() and
 * the example is tests/Fixtures/apps-feature-contracts/requests.json there.
 */

const URL = 'https://acme.example/siren';

const USD = { id: 'USD', symbol: '$', position: 'before', name: 'US Dollar', scale: 2, decimalPlaces: 2, type: 'monetary' };

/** Siren's example question, from the feature contracts fixture. */
const QUESTION: AppRewardQuestion = {
  reason: 'sale',
  program: { id: 3, name: 'Partner program', status: 'active' },
  conversionType: 'sale',
  transaction: { id: 3307, units: 'USD', currency: USD },
  pool: { value: 1500, units: 'USD', currency: USD },
  conversions: [
    { conversionId: 1042, engagementId: 880, collaboratorId: 42, collaboratorStatus: 'active', score: 60, engagementCreatedDate: '2026-11-02T09:15:00+00:00' },
    { conversionId: 1043, engagementId: 881, collaboratorId: 57, collaboratorStatus: 'active', score: 40, engagementCreatedDate: '2026-11-09T16:40:00+00:00' },
  ],
};

function file(items: Record<string, unknown>, url: string | null = URL): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', ...(url ? { url } : {}), features: items } } });
}

describe('apps-c16-2: the incentive resolver kind', () => {
  it('names the kind with the value Siren stores and the name its catalog gives', () => {
    expect(AppItemKind.IncentiveResolver).toBe('incentiveResolver');
    expect(kindLabel('incentiveResolver')).toBe('Attribution model (incentiveResolver)');
  });

  it('reads an app file with an incentive resolver and its answer window', () => {
    const parsed = parseAppFile(file({ split: { kind: 'incentiveResolver', name: 'Split the reward', answerWindowMinutes: 30 } }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.items).toEqual([{ kind: 'incentiveResolver', key: 'split', name: 'Split the reward', answerWindowMinutes: 30 }]);
  });

  it('refuses an incentive resolver with no url, since Siren asks the app at its address', () => {
    const parsed = parseAppFile(file({ split: { kind: 'incentiveResolver', name: 'Split' } }, null), {});
    expect(parsed.problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features`]);
  });

  it('answers the reward ask with the typed answer, through the one answer route', async () => {
    const rewards: Record<string, number | null> = {};
    const total = QUESTION.conversions.reduce((sum, conversion) => sum + conversion.score, 0);
    for (const conversion of QUESTION.conversions) rewards[String(conversion.conversionId)] = Math.floor((QUESTION.pool.value * conversion.score) / total);
    const answer: AppRewardAnswer = { outcome: 'rewards', units: QUESTION.pool.units, rewards };
    const nothing: AppRewardAnswer = { outcome: 'rewards', units: 'USD', rewards: { '1042': 1500, '1043': null } };

    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    expect(await resource.requests.answer(APP_REQUEST_ID, answer)).toEqual(accepted);
    expect(await resource.requests.answer(APP_REQUEST_ID, nothing)).toEqual(accepted);
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([
      { outcome: 'rewards', units: 'USD', rewards: { '1042': 900, '1043': 600 } },
      nothing,
    ]);
  });

  it('raises the answer to a dropped ask as ConflictError app_request_dropped, sent once', async () => {
    // AppRequestService::dropped() on Siren's pkt/apps-c16-2, through AppAnswerResult::refused().
    const over = transportOver([
      reply(409, {
        error: {
          message: "Siren stopped waiting for this answer: the app didn't answer within 24 hours, so the work went on without it.",
          code: 'app_request_dropped',
          context: [],
        },
      }),
    ]);
    const error = await new AppsResource(over.transport).requests
      .answer(APP_REQUEST_ID, { outcome: 'rewards', units: 'USD', rewards: { '1042': 900, '1043': 600 } })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ConflictError);
    expect(appErrorCode(error)).toBe(AppErrorCode.Dropped);
    expect(AppErrorCode.Dropped).toBe('app_request_dropped');
    expect(over.http.requests).toHaveLength(1);
  });
});
