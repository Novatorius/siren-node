import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type {
  CollaboratorGroupStructureAnswer,
  CollaboratorGroupStructureDistributorQuestion,
  CollaboratorGroupStructureProgramQuestion,
  CollaboratorGroupStructureQuestion,
} from '../src/record-types';
import { FeatureKind } from '../src/taxonomy';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf, pathOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID } from './apps-siren-answers';

/*
 * Slice C16-7 in the Node SDK: the collaborator group structure kind. Its
 * name, question and answer rules are the slice's contract. The request
 * envelope is Siren's own distribution resolver ask from
 * test/fixtures/apps-feature-contracts/requests.json, with this kind's feature
 * and data, signed as WebhookSignature::headers() signs it.
 */

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown> }>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const SECRET = (
  JSON.parse(readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8')) as { secret: string }
).secret;

const SITE = 'https://acme.example/siren';

/** The slice's example question, from the distributor side. */
const QUESTION: CollaboratorGroupStructureDistributorQuestion = {
  group: { id: 4, name: 'Northeast team' },
  members: [
    { collaboratorId: 42, name: 'Riley Rep', status: 'active', metadata: { rank: 3 } },
    { collaboratorId: 57, name: 'Sam Lead', status: 'active', metadata: { rank: 2 } },
    { collaboratorId: 63, name: 'Jo Manager', status: 'active', metadata: { rank: 1 } },
  ],
  for: { type: 'distributor', id: 2 },
  triggeringCollaborator: { id: 42, name: 'Riley Rep' },
  cause: { id: '9f2c4e1a7b3d5c60', type: null, causeId: null },
  distributor: { id: 2, name: 'Partner leaderboard' },
  distribution: { id: 21, periodEnd: '2026-12-01T00:00:00+00:00' },
  metricType: 'referredSiteVisit',
  distributorMetricTypeId: 55,
  opportunityId: 615,
  points: null,
  sale: null,
};

/** A program-side ask: the group's fields, and the engagement trigger's beside them. */
const PROGRAM_QUESTION: CollaboratorGroupStructureProgramQuestion = {
  group: { id: 4, name: 'Northeast team' },
  members: QUESTION.members,
  for: { type: 'program', id: 3 },
  program: { id: 3, name: 'Partner program' },
  engagementType: 'referredSiteVisit',
  programEngagementTypeId: 55,
  args: { pointsAtLayer1: '10' },
  opportunity: { id: 615, customerId: null },
  triggeringCollaborator: { id: 42, name: 'Riley Rep' },
  cause: { id: '9f2c4e1a7b3d5c60', event: 'referredSiteVisit', occurredAt: '2026-11-17T12:20:00+00:00' },
};

const CHAIN: CollaboratorGroupStructureAnswer = { outcome: 'structure', shape: 'chain', order: [63, 57, 42] };
const TREE: CollaboratorGroupStructureAnswer = { outcome: 'structure', shape: 'tree', parents: { '42': 57, '57': 63, '63': null } };

function file(declared: Record<string, unknown>, url: string | null = SITE): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', ...(url ? { url } : {}), features: declared } } });
}

function ask(key: string, data: Record<string, unknown>): string {
  // The answer address goes on the test client's base, since the handler refuses one on another Siren.
  const answerUrl = `${BASE}/apps/requests/${String(features.kinds.distributionResolver!.request.id)}/answer`;
  return JSON.stringify({ ...features.kinds.distributionResolver!.request, answerUrl, feature: { kind: 'collaboratorGroupStructure', key, id: 'app:11' }, data });
}

function signed(raw: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  return {
    'Content-Type': 'application/json',
    'X-Siren-Signature': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    'X-Siren-Event': 'app.request',
    'X-Siren-Timestamp': String(t),
    'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`,
  };
}

describe('apps-c16-7: the collaborator group structure kind', () => {
  it('names the kind with the value Siren stores and the name its catalog gives', () => {
    expect(FeatureKind.CollaboratorGroupStructure).toBe('collaboratorGroupStructure');
    expect(kindLabel('collaboratorGroupStructure')).toBe('Collaborator group structure (collaboratorGroupStructure)');
  });

  it('reads an app file with a group structure and its answer window', () => {
    const parsed = parseAppFile(file({ shape: { kind: 'collaboratorGroupStructure', name: 'Team shape', answerWindowMinutes: 30 } }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.features).toEqual([
      { kind: 'collaboratorGroupStructure', key: 'shape', name: 'Team shape', answerWindowMinutes: 30 },
    ]);
  });

  it('refuses a group structure with no url, since Siren asks the app at its address', () => {
    const parsed = parseAppFile(file({ shape: { kind: 'collaboratorGroupStructure', name: 'Team shape' } }, null), {});
    expect(parsed.problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features`]);
  });

  it("types on('collaboratorGroupStructure') by its question and answer, and posts a chain and a tree", async () => {
    const http = new FakeHttpClient([reply(200, { status: 'accepted' }), reply(200, { status: 'accepted' })]);
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 2 });
    const errors: unknown[] = [];
    const answers = siren.apps.requestHandler({ signingSecret: SECRET, onError: (error) => errors.push(error) });
    answers.on('collaboratorGroupStructure', 'by-rank', ({ data }) => ({
      outcome: 'structure',
      shape: 'chain',
      order: [...data.members].sort((a, b) => Number(a.metadata.rank) - Number(b.metadata.rank)).map((member) => member.collaboratorId),
    }));
    answers.on('collaboratorGroupStructure', 'by-lead', ({ data }) => {
      const parents: Record<string, number | null> = {};
      for (const [index, member] of data.members.entries()) parents[String(member.collaboratorId)] = data.members[index + 1]?.collaboratorId ?? null;
      return { outcome: 'structure', shape: 'tree', parents };
    });
    // @ts-expect-error A group structure answers a chain or a tree, never scores.
    answers.on('collaboratorGroupStructure', 'wrong', () => ({ outcome: 'scores', results: [] }));
    // @ts-expect-error A chain lists its order, never parents.
    answers.on('collaboratorGroupStructure', 'mixed', () => ({ outcome: 'structure', shape: 'chain', parents: {} }));

    for (const raw of [ask('by-rank', { ...QUESTION }), ask('by-lead', { ...PROGRAM_QUESTION })]) {
      const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
      expect(result.status, result.body).toBe(200);
      await result.after!();
    }
    expect(errors).toEqual([]);
    expect(http.requests.map(bodyOf)).toEqual([CHAIN, TREE]);
    expect(http.requests.map(pathOf)).toEqual([
      expect.stringMatching(/\/apps\/requests\/[^/]+\/answer$/),
      expect.stringMatching(/\/apps\/requests\/[^/]+\/answer$/),
    ]);
  });

  it('sends a chain and a tree by hand, through the one answer route', async () => {
    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    expect(await resource.requests.answer(APP_REQUEST_ID, CHAIN)).toEqual(accepted);
    expect(await resource.requests.answer(APP_REQUEST_ID, TREE)).toEqual(accepted);
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([CHAIN, TREE]);
  });
});
