import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import { AppsResource } from '../src/resources/apps';
import type { IncentiveResolverQuestion, TransactionFilterAnswer, TransactionFilterQuestion } from '../src/record-types';
import { FeatureKind } from '../src/taxonomy';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf, pathOf, transportOver } from './record-fakes';
import { APP_KEY, APP_REQUEST_ID } from './apps-siren-answers';

/*
 * Slice C16-3 in the Node SDK: the transaction filter kind. Its name,
 * question and answer rules are the slice's contract. The request envelope
 * is Siren's own distribution resolver ask from
 * test/fixtures/apps-feature-contracts/requests.json, with this kind's feature
 * and data, signed as WebhookSignature::headers() signs it. The question's
 * transaction is the incentive resolver ask's from the same fixture, since
 * both carry the same currency object.
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
const TRANSACTION = (features.kinds.incentiveResolver!.request.data as unknown as IncentiveResolverQuestion).transaction!;

const SITE = 'https://acme.example/siren';

/** The slice's example question, from the program side. */
const QUESTION: TransactionFilterQuestion = {
  for: { type: 'program', id: 3, name: 'Partner program' },
  transaction: TRANSACTION,
  lines: [
    { id: 5501, type: 'lineItem', name: 'Annual plan', quantity: 1, value: 12000, productId: 'prod_annual' },
    { id: 5502, type: 'shipping', name: 'Shipping', quantity: 1, value: 800, productId: null },
  ],
  distribution: null,
  refundDistribution: null,
};

/** A distributor's ask: the period the sale lands in, and a later refund's period. */
const DISTRIBUTOR_QUESTION: TransactionFilterQuestion = {
  ...QUESTION,
  for: { type: 'distributor', id: 2, name: 'Partner leaderboard' },
  distribution: { id: 21 },
  refundDistribution: { id: 22 },
};

const LINE_ITEMS: TransactionFilterAnswer = { outcome: 'filtered', include: [5501] };
const NOTHING: TransactionFilterAnswer = { outcome: 'filtered', include: [] };

function file(declared: Record<string, unknown>, url: string | null = SITE): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { [APP_KEY]: { name: 'Acme', ...(url ? { url } : {}), features: declared } } });
}

function ask(key: string, data: Record<string, unknown>): string {
  // The answer address goes on the test client's base, since the handler refuses one on another Siren.
  const answerUrl = `${BASE}/apps/requests/${String(features.kinds.distributionResolver!.request.id)}/answer`;
  return JSON.stringify({ ...features.kinds.distributionResolver!.request, answerUrl, feature: { kind: 'transactionFilter', key, id: 'app:11' }, data });
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

describe('apps-c16-3: the transaction filter kind', () => {
  it('names the kind with the value Siren stores and the name its catalog gives', () => {
    expect(FeatureKind.TransactionFilter).toBe('transactionFilter');
    expect(kindLabel('transactionFilter')).toBe('Transaction filter (transactionFilter)');
  });

  it('reads an app file with a transaction filter and its answer window', () => {
    const parsed = parseAppFile(file({ lines: { kind: 'transactionFilter', name: 'Plan lines only', answerWindowMinutes: 30 } }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.features).toEqual([
      { kind: 'transactionFilter', key: 'lines', name: 'Plan lines only', answerWindowMinutes: 30 },
    ]);
  });

  it('refuses a transaction filter with no url, since Siren asks the app at its address', () => {
    const parsed = parseAppFile(file({ lines: { kind: 'transactionFilter', name: 'Plan lines only' } }, null), {});
    expect(parsed.problems.map((problem) => problem.path)).toEqual([`apps.${APP_KEY}.features`]);
  });

  it("types on('transactionFilter') by its question and answer, and posts the lines to include", async () => {
    const http = new FakeHttpClient([reply(200, { status: 'accepted' }), reply(200, { status: 'accepted' })]);
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 2 });
    const errors: unknown[] = [];
    const answers = siren.apps.requestHandler({ signingSecret: SECRET, onError: (error) => errors.push(error) });
    answers.on('transactionFilter', 'plan-lines', ({ data }) => ({
      outcome: 'filtered',
      include: data.lines.filter((line) => line.type === 'lineItem').map((line) => line.id),
    }));
    answers.on('transactionFilter', 'nothing-late', ({ data }) => ({
      outcome: 'filtered',
      include: data.refundDistribution && data.distribution ? [] : data.lines.map((line) => line.id),
    }));
    // @ts-expect-error A transaction filter answers filtered, never allow.
    answers.on('transactionFilter', 'wrong', () => ({ outcome: 'allow' }));
    // @ts-expect-error A transaction filter lists line ids as numbers.
    answers.on('transactionFilter', 'text', () => ({ outcome: 'filtered', include: ['5501'] }));

    for (const raw of [ask('plan-lines', { ...QUESTION }), ask('nothing-late', { ...DISTRIBUTOR_QUESTION })]) {
      const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
      expect(result.status, result.body).toBe(200);
      await result.after!();
    }
    expect(errors).toEqual([]);
    expect(http.requests.map(bodyOf)).toEqual([LINE_ITEMS, NOTHING]);
    expect(http.requests.map(pathOf)).toEqual([
      expect.stringMatching(/\/apps\/requests\/[^/]+\/answer$/),
      expect.stringMatching(/\/apps\/requests\/[^/]+\/answer$/),
    ]);
  });

  it('sends the lines to include, and an empty list, by hand through the one answer route', async () => {
    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    expect(await resource.requests.answer(APP_REQUEST_ID, LINE_ITEMS)).toEqual(accepted);
    expect(await resource.requests.answer(APP_REQUEST_ID, NOTHING)).toEqual(accepted);
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([LINE_ITEMS, NOTHING]);
  });
});
