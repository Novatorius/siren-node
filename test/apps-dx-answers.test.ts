import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import { SirenError, ValidationError } from '../src/errors';
import type { HttpResponse } from '../src/http';
import type { AppRequest } from '../src/record-types';
import { appRequest, sampleData } from '../src/testing';
import type { WebhookEvent } from '../src/types';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf } from './record-fakes';

/*
 * DX pass 2 (review/sdk-dx/pass-2-review.md in the apps run folder):
 * finding 3, an ask's function says "answer later" with answers.later(),
 * and returning nothing is an error; finding 4, the default onError line
 * for a failed ask says when Siren sends it again; and the feature carried
 * from pass 1, that simulate() checks an answer the way Siren's answer
 * route does, with Siren's own words.
 */

const SECRET = 'a-secret-for-the-answer-checks';
const ID = 'apr_9c60190a4501399d0ae55f041c237b39';

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown>; answer: Record<string, unknown> | null }>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;

const ASKS = Object.entries(features.kinds)
  .filter(([, kind]) => kind.request.mode === 'ask')
  .map(([name]) => name);

function setup(replies: Array<HttpResponse | Error> = [reply(200, { status: 'accepted' })], withOnError = true) {
  const http = new FakeHttpClient(replies);
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
  const errors: Array<{ error: unknown; request: AppRequest | WebhookEvent | undefined }> = [];
  const answers = siren.apps.requestHandler({
    signingSecret: SECRET,
    ...(withOnError ? { onError: (error: unknown, request?: AppRequest | WebhookEvent) => errors.push({ error, request }) } : {}),
  });
  return { http, siren, answers, errors };
}

function ask(kind: string, key: string, options: { timestamp?: number; data?: Record<string, unknown> } = {}) {
  return appRequest(kind, key, { secret: SECRET, baseUrl: BASE, id: ID, ...options });
}

/** A request signed by hand, for a body appRequest() would not build. */
function signedBy(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  return {
    method: 'POST',
    rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Siren-Event': 'app.request',
      'X-Siren-Timestamp': String(t),
      'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')}`,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const NOTHING =
  'The function for distributionResolver split-by-score returned nothing. Return the answer, or return answers.later() when you will answer with apps.requests.answer().';

describe('DX pass 2, finding 3: an ask says "answer later" with answers.later()', () => {
  it('posts nothing and reports nothing for an ask whose function returns answers.later()', async () => {
    const { answers, http, errors } = setup();
    expect(answers.later()).toBe(answers.later());
    answers.on('distributionResolver', 'split-by-score', () => answers.later());
    const result = await answers.handle(ask('distributionResolver', 'split-by-score'));
    expect(result.status).toBe(200);
    await result.after!();
    expect(http.requests).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('reports an ask whose function returns %s, and posts nothing', async (_name, value) => {
    const { answers, http, errors } = setup();
    answers.on('distributionResolver', 'split-by-score', (() => value) as never);
    const result = await answers.handle(ask('distributionResolver', 'split-by-score'));
    expect(result.status).toBe(200);
    await result.after!();
    expect(http.requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(SirenError);
    expect((errors[0]!.error as Error).message).toBe(NOTHING);
    expect(errors[0]!.request).toMatchObject({ id: ID, mode: 'ask' });
  });

  it('gives simulate() the same error, so a test fails, and answers.later() with no error', async () => {
    const { answers } = setup();
    answers.on('distributionResolver', 'split-by-score', (async () => undefined) as never);
    answers.on('payoutMethod', () => answers.later());
    const forgot = await answers.simulate(ask('distributionResolver', 'split-by-score'));
    expect(forgot.status).toBe(200);
    expect((forgot.error as Error).message).toBe(NOTHING);
    const later = await answers.simulate(ask('payoutMethod', 'acme-ledger'));
    expect(later.answer).toBeNull();
    expect(later.error).toBeNull();
  });

  it("ignores what a tell's function returns", async () => {
    const { answers, errors } = setup();
    answers.on('postConversionAction', (() => ({ outcome: 'ignored' })) as never);
    const result = await answers.simulate(ask('postConversionAction', 'tell-the-crm'));
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(errors).toHaveLength(0);
  });
});

/** The UTC time the default line names for an answerBy, with the day when it is not today. */
function closes(seconds: number): string {
  const at = new Date(seconds * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  return at.slice(0, 10) === today ? `${at.slice(11, 16)} UTC` : `${at.slice(11, 16)} UTC on ${at.slice(0, 10)}`;
}

describe('DX pass 2, finding 4: the default line for a failed ask says when Siren sends it again', () => {
  const next = (t: number) =>
    `Siren sends it again after ${closes(t + 3600)}, when its answer window closes. ` +
    `Resend it sooner with \`siren apps resend ${ID}\`.`;

  it('names the time for a function that throws', async () => {
    const { answers } = setup([], false);
    const failure = new Error('ledger down');
    answers.on('distributionResolver', () => {
      throw failure;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = Math.floor(Date.now() / 1000);
    const result = await answers.handle(ask('distributionResolver', 'split-by-score', { timestamp: t }));
    await result.after!();
    // DX pass 4: one string, with the stack after it because the app's own function threw.
    expect(log.mock.calls).toHaveLength(1);
    expect(String(log.mock.calls[0]![0]).split('\n')[0]).toBe(`Siren request handler (distributionResolver split-by-score ${ID}): ${next(t)} Error: ledger down`);
    void failure;
  });

  it('prints when Siren sends it again before the stack trace, so a reader sees it without scrolling', async () => {
    const { answers } = setup([], false);
    answers.on('distributionResolver', () => {
      throw new Error('ledger down');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = Math.floor(Date.now() / 1000);
    await (await answers.handle(ask('distributionResolver', 'split-by-score', { timestamp: t }))).after!();
    const printed = format(...(log.mock.calls[0] as unknown[]));
    expect(printed.indexOf(next(t))).toBeGreaterThan(-1);
    expect(printed.indexOf(next(t))).toBeLessThan(printed.indexOf('Error: ledger down'));
    expect(printed.indexOf('Error: ledger down')).toBeLessThan(printed.indexOf('    at '));
  });

  it('names it for a function that returns nothing, and for an answer Siren refuses with 422', async () => {
    const refused = reply(422, { error: { message: 'outcome must be allocated', code: 'app_answer_invalid', context: [] } });
    const { answers } = setup([refused], false);
    answers.on('distributionResolver', 'split-by-score', (() => undefined) as never);
    answers.on('distributionResolver', () => ({ outcome: 'allocated', units: 'USD', shares: {} }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = Math.floor(Date.now() / 1000);
    await (await answers.handle(ask('distributionResolver', 'split-by-score', { timestamp: t }))).after!();
    await (await answers.handle(ask('distributionResolver', 'another-key', { timestamp: t }))).after!();
    expect(log.mock.calls).toHaveLength(2);
    expect(String(log.mock.calls[0]![0])).toContain(`${next(t)} AppHandlerError: ${NOTHING}`);
    // DX pass 4: after a 422 app_answer_invalid, a resend would give the same answer, so the line
    // says to reproduce it with simulate() instead of when Siren sends it again.
    expect(String(log.mock.calls[1]![0])).not.toContain(next(t));
    expect(String(log.mock.calls[1]![0])).toContain(`Reproduce it with simulate() on this request's data`);
    expect(String(log.mock.calls[1]![0])).toContain('ValidationError: outcome must be allocated');
  });

  it('says nothing of a resend when Siren already holds an answer', async () => {
    const taken = reply(409, { error: { message: 'Another answer came first.', code: 'app_request_already_answered', context: [] } });
    const { answers } = setup([taken], false);
    answers.on('distributionResolver', () => ({ outcome: 'allocated', units: 'USD', shares: { '41': 1, '43': 1 } }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await (await answers.handle(ask('distributionResolver', 'split-by-score'))).after!();
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(String(log.mock.calls[0]![0])).not.toContain('Siren sends it again');
    expect(String(log.mock.calls[0]![0])).toContain('ConflictError: Another answer came first.');
  });

  it('leaves the time out when answerBy is not a date', async () => {
    const { answers } = setup([], false);
    answers.on('distributionResolver', () => {
      throw new Error('ledger down');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = { ...features.kinds.distributionResolver!.request, answerBy: 'soon', answerUrl: `${BASE}/apps/requests/${ID}/answer` };
    await (await answers.handle(signedBy(body))).after!();
    expect(String(log.mock.calls[0]![0])).toContain(
      `Siren sends it again when its answer window closes. Resend it sooner with \`siren apps resend ${ID}\`.`,
    );
  });
});

/** The answer Siren's contract file gives `kind`, changed by `change`. */
function answerFor(kind: string, change: (answer: Record<string, unknown>) => void = () => undefined): Record<string, unknown> {
  const answer = structuredClone(features.kinds[kind]!.answer!);
  change(answer);
  return answer;
}

describe("DX pass 2, from pass 1: simulate() checks an answer as Siren's answer route does", () => {
  it.each(ASKS)("takes Siren's own answer to its own question for %s", async (kind) => {
    const { answers } = setup();
    expect(sampleData(kind)).toEqual(features.kinds[kind]!.request.data);
    answers.on(kind as never, (() => answerFor(kind)) as never);
    const result = await answers.simulate(ask(kind, 'a-key'));
    expect(result.error).toBeNull();
    expect(result.answer).toEqual(features.kinds[kind]!.answer);
  });

  const cases: Array<[string, (answer: Record<string, unknown>) => void, string]> = [
    // lib/Apps/Service/Resolvers/AppDistributionQuestion.php, unfitness()
    ['distributionResolver', (a) => (a.outcome = 'allocate'), 'outcome must be allocated'],
    ['distributionResolver', (a) => (a.units = 'EUR'), 'units must be USD, the units of the pool'],
    ['distributionResolver', (a) => (a.shares = 'all'), 'shares must be an object of metric id to amount'],
    ['distributionResolver', (a) => (a.shares = { '41': 6000, '43': 3000, '99': 1000 }), 'shares names metric 99, which this distribution does not hold'],
    ['distributionResolver', (a) => (a.shares = { '41': 6000.5, '43': 3000 }), 'the share for metric 41 must be a whole number of the smallest unit'],
    ['distributionResolver', (a) => (a.shares = { '41': -1, '43': 3000 }), 'the share for metric 41 must not be below 0'],
    ['distributionResolver', (a) => (a.shares = { '41': 6000 }), 'shares has no amount for metric 43, and every metric needs one, 0 included'],
    ['distributionResolver', (a) => (a.shares = { '41': 6000, '43': 4001 }), 'the shares add up to 10001, more than the pool of 10000'],
    // lib/Apps/Service/Rewards/AppRewardQuestion.php, validate()
    ['incentiveResolver', (a) => (a.outcome = 'reward'), 'The answer\'s outcome must be "rewards".'],
    ['incentiveResolver', (a) => (a.rewards = [900, 600]), "The answer's rewards must be an object with one key per conversion id in the question."],
    ['incentiveResolver', (a) => (a.rewards = { '1042': 900 }), 'The answer has no reward for conversion 1043. Give every conversion of the question a key, null for one the app did not choose.'],
    ['incentiveResolver', (a) => (a.rewards = { '1042': 1600, '1043': null }), 'The reward for conversion 1042 is 1600, more than the pool of 1500 Siren offered.'],
    // lib/Apps/Service/IncentiveTypes/AppIncentiveTypeQuestion.php, validate()
    ['incentiveType', (a) => (a.engagementIds = [880, 999]), 'The answer names engagement 999, which the question does not hold.'],
    ['incentiveType', (a) => (a.engagementIds = [880, 880]), 'The answer names engagement 880 more than once.'],
    ['incentiveType', (a) => (a.note = 'hi'), 'The answer has fields Siren does not read: note.'],
    ['incentiveType', (a) => Object.assign(a, { outcome: 'none' }), 'An answer of "none" carries nothing else, and this one has units, pool, engagementIds.'],
    // lib/Apps/Service/Payouts/AppPayoutQuestion.php, validate()
    ['payoutMethod', (a) => (a.reference = '  '), 'A paid answer names the payment\'s reference in your system, as "reference".'],
    ['payoutMethod', (a) => (a.reference = 'r'.repeat(192)), 'A reference is at most 191 characters.'],
    ['payoutMethod', (a) => (a.outcome = 'done'), 'The outcome is "paid" or "failed".'],
    // lib/Apps/Service/Handlers/AppMetricCalculationAnswerHandler.php, validate()
    ['metricCalculation', (a) => (a.results = [{ collaboratorId: 42, score: -1 }]), 'results[0].score must be a whole number of 0 or more.'],
    ['metricCalculation', (a) => (a.results = [{ collaboratorId: 42, score: 1 }, { collaboratorId: 42, score: 2 }]), 'results names collaborator 42 more than once.'],
    // lib/Apps/Service/Engagements/AppEngagementCalculationAnswerHandler.php, validate()
    ['engagementCalculation', (a) => (a.outcome = 'scores'), 'outcome must be engagements.'],
    // lib/Apps/Service/Handlers/AppMetricFilterAnswerHandler.php, validate()
    ['metricFilter', (a) => (a.reason = 'x'.repeat(201)), 'reason may be at most 200 characters, and this is 201.'],
    // lib/Apps/Service/Engagements/AppEngagementFilterAnswerHandler.php, validate()
    ['engagementFilter', (a) => (a.reason = 'A <b>bold</b> reason'), 'reason must be plain text, with no markup or control characters.'],
    // lib/Apps/Service/GroupOrders/AppGroupOrderQuestion.php, validate()
    ['programGroupSorter', (a) => (a.programIds = [9]), 'The answer leaves out program 12. List every program Siren asked about.'],
    // lib/Apps/Service/TransactionFilters/AppTransactionFilterQuestion.php, validate()
    ['transactionFilter', (a) => (a.include = [5501, 7000]), 'The answer includes line 7000, which is not a line of the sale Siren asked about.'],
    // lib/Apps/Service/Handlers/AppGroupStructureAnswerHandler.php, problem(), chainProblem() and treeProblem()
    ['collaboratorGroupStructure', (a) => (a.order = [63, 57]), 'order leaves out member 42. List every member of the question once.'],
    ['collaboratorGroupStructure', (a) => Object.assign(a, { shape: 'tree', parents: { '63': null, '57': 42, '42': 57 } }), 'parents form a cycle through member 42. Every member must reach the top.'],
    ['collaboratorGroupStructure', (a) => (a.shape = 'ring'), 'shape must be chain or tree.'],
  ];

  it.each(cases)('refuses a bad %s answer with Siren\'s words: %#', async (kind, change, words) => {
    const { answers, http } = setup();
    answers.on(kind as never, (() => answerFor(kind, change)) as never);
    const result = await answers.simulate(ask(kind, 'a-key'));
    expect(result.status).toBe(200);
    expect(result.error).toBeInstanceOf(ValidationError);
    expect((result.error as ValidationError).message).toBe(words);
    expect((result.error as ValidationError).code).toBe('app_answer_invalid');
    expect((result.error as ValidationError).statusCode).toBe(422);
    expect(http.requests).toHaveLength(0);
  });

  it("measures the answer's size as Siren's json_encode writes it, slashes and all", async () => {
    const { answers } = setup();
    answers.on('metricFilter', () => ({ outcome: 'allow', note: '/'.repeat(9000) }));
    const result = await answers.simulate(ask('metricFilter', 'a-key'));
    expect((result.error as ValidationError).message).toBe('The answer is larger than 16384 bytes of JSON.');
  });

  it('leaves the live handler as it was: it posts the answer, and Siren decides', async () => {
    const { answers, http } = setup();
    answers.on('distributionResolver', () => answerFor('distributionResolver', (a) => (a.shares = { '41': 6000 })) as never);
    await (await answers.handle(ask('distributionResolver', 'split-by-score'))).after!();
    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0])).toEqual({ outcome: 'allocated', units: 'USD', shares: { '41': 6000 } });
  });
});
