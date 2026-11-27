import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type { AppFunctionFor } from '../src/resources/app-request-handler';
import type { ProgramGroupSorterAnswer, ProgramGroupSorterQuestion } from '../src/record-types';
import { FeatureKind } from '../src/taxonomy';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID } from './apps-siren-answers';

/*
 * Slice C16-5 in the Node SDK: the program group structure kind. Its name is
 * Siren's catalog entry for the slice (lib/Apps/Core/Enums/AppItemKindCatalog.php
 * on Siren's pkt/apps-c16-5), the question is AppGroupOrderQuestion::build()
 * and the example is tests/Fixtures/apps-feature-contracts/requests.json
 * there, which test/fixtures copies.
 *
 * `refusalOf()` holds the rules of Siren's AppGroupOrderQuestion::validate(),
 * in its order, and Siren's AppFeatureContractsTest runs the fixture's answer
 * through validate() itself.
 */

interface FeatureFixture {
  kinds: Record<string, { request: { data: unknown }; answer: Record<string, unknown> | null }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const QUESTION = fixture.kinds.programGroupSorter!.request.data as ProgramGroupSorterQuestion;
const URL_ = 'https://acme.example/siren';

/** Siren's AppGroupOrderQuestion::validate(): why it refuses the answer with 422, or null. */
function refusalOf(question: ProgramGroupSorterQuestion, answer: Record<string, unknown>): string | null {
  if (answer.outcome !== 'sorted') return 'outcome';
  const order = answer.programIds;
  if (!Array.isArray(order)) return 'programIds';
  const asked = question.programs.map((program) => program.id);
  const seen = new Set<number>();
  for (const id of order as unknown[]) {
    if (!Number.isInteger(id)) return 'not whole';
    if (!asked.includes(id as number)) return `not asked ${String(id)}`;
    if (seen.has(id as number)) return `twice ${String(id)}`;
    seen.add(id as number);
  }
  for (const id of asked) {
    if (!seen.has(id)) return `left out ${id}`;
  }
  return null;
}

function file(declared: Record<string, unknown>, url: string | null = URL_): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', ...(url ? { url } : {}), features: declared } } });
}

/** The sample's function, as README and test/answer-samples/program-group-sorter.js write it, typed as on('programGroupSorter', ...) takes it. */
const sample: AppFunctionFor<'programGroupSorter'> = ({ data }) => {
  const best = (program: ProgramGroupSorterQuestion['programs'][number]) => Math.max(0, ...program.engagements.map((engagement) => engagement.score));
  const programs = [...data.programs].sort((a, b) => best(b) - best(a));
  return { outcome: 'sorted', programIds: programs.map((program) => program.id) };
};

function ask(data: ProgramGroupSorterQuestion): Parameters<typeof sample>[0] {
  return { id: APP_REQUEST_ID, mode: 'ask', data } as unknown as Parameters<typeof sample>[0];
}

describe('apps-c16-5: the program group structure kind', () => {
  it('names the kind with the value Siren stores and the name its catalog gives', () => {
    expect(FeatureKind.ProgramGroupSorter).toBe('programGroupSorter');
    expect(kindLabel('programGroupSorter')).toBe('Program group structure (programGroupSorter)');
  });

  it('reads an app file with a program group structure and its answer window', () => {
    const parsed = parseAppFile(file({ pick: { kind: 'programGroupSorter', name: 'Pick the program', answerWindowMinutes: 30 } }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.features).toEqual([{ kind: 'programGroupSorter', key: 'pick', name: 'Pick the program', answerWindowMinutes: 30 }]);
  });

  it('refuses a program group structure with no url, since Siren asks the app at its address', () => {
    const parsed = parseAppFile(file({ pick: { kind: 'programGroupSorter', name: 'Pick' } }, null), {});
    expect(parsed.problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features`]);
  });

  it("gives Siren's fixture answer for Siren's fixture question, one Siren takes", async () => {
    const answer = (await sample(ask(QUESTION))) as ProgramGroupSorterAnswer;
    expect(answer).toEqual(fixture.kinds.programGroupSorter!.answer);
    expect(refusalOf(QUESTION, answer as unknown as Record<string, unknown>)).toBeNull();
  });

  it('keeps the group order for a tie and lists a program with no engagement', async () => {
    const tied: ProgramGroupSorterQuestion = {
      ...QUESTION,
      programs: [
        { id: 4, name: 'Quiet', engagements: [] },
        { id: 12, name: 'Resellers', engagements: [{ engagementId: 880, collaboratorId: 42, score: 40, createdDate: '2026-11-02T09:15:00+00:00' }] },
        { id: 9, name: 'Affiliates', engagements: [{ engagementId: 881, collaboratorId: 57, score: 40, createdDate: '2026-11-09T16:40:00+00:00' }] },
      ],
    };
    const answer = (await sample(ask(tied))) as ProgramGroupSorterAnswer;
    expect(answer.programIds).toEqual([12, 9, 4]);
    expect(refusalOf(tied, answer as unknown as Record<string, unknown>)).toBeNull();
  });

  it('holds the rules Siren checks: each program once, none left out, none added', () => {
    expect(refusalOf(QUESTION, { outcome: 'sorted', programIds: [9] })).toBe('left out 12');
    expect(refusalOf(QUESTION, { outcome: 'sorted', programIds: [9, 12, 9] })).toBe('twice 9');
    expect(refusalOf(QUESTION, { outcome: 'sorted', programIds: [9, 12, 40] })).toBe('not asked 40');
    expect(refusalOf(QUESTION, { outcome: 'allocated', programIds: [9, 12] })).toBe('outcome');
  });

  it('answers through the one answer route, sent once', async () => {
    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted)]);
    const answer: ProgramGroupSorterAnswer = { outcome: 'sorted', programIds: [9, 12] };
    expect(await new AppsResource(over.transport).requests.answer(APP_REQUEST_ID, answer)).toEqual(accepted);
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([answer]);
  });
});
