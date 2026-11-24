import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { AppErrorCode, ConflictError, appErrorCode } from '../src/errors';
import { AppsResource } from '../src/resources/apps';
import type { AppPayoutAnswer, AppPayoutQuestion } from '../src/record-types';
import { AppItemKind } from '../src/taxonomy';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf, pathOf, transportOver } from './record-fakes';
import { APP_REQUEST_ID } from './apps-siren-answers';

/*
 * The payout method ask in the Node SDK. The envelope and data are the
 * contract the orchestrator fixed for the kind: one payout, the amount in the
 * currency's smallest unit, and the collaborator. The answer is paid with a
 * reference or failed with a reason.
 */

const SECRET = (
  JSON.parse(readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8')) as { secret: string }
).secret;

const ID = 'apr_9c60190a4501399d0ae55f041c237b39';

const ENVELOPE = JSON.stringify({
  version: 1,
  id: ID,
  type: 'app.request',
  mode: 'ask',
  app: 'acme-crm',
  item: { kind: 'payoutMethod', key: 'acme-ledger', id: 'app:12' },
  createdAt: '2026-11-20T10:00:00+00:00',
  answerBy: '2026-11-21T10:00:00+00:00',
  answerUrl: `${BASE}/apps/requests/${ID}/answer`,
  data: {
    payout: { id: 88, fulfillmentId: 31, attempt: 1 },
    amount: {
      value: 2500,
      units: 'USD',
      currency: { id: 'USD', symbol: '$', position: 'before', name: 'US Dollar', scale: 2, decimalPlaces: 2, type: 'monetary' },
    },
    collaborator: { id: 42, name: 'Ana Ruiz', email: 'ana@example.com' },
  },
});

function headers(raw: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  return {
    'Content-Type': 'application/json',
    'X-Siren-Signature': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    'X-Siren-Event': 'app.request',
    'X-Siren-Delivery': `${ID}.1`,
    'X-Siren-Timestamp': String(t),
    'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`,
    'Idempotency-Key': ID,
  };
}

describe('the payout method ask', () => {
  it('names the kind with the value Siren stores', () => {
    expect(AppItemKind.PayoutMethod).toBe('payoutMethod');
  });

  it('reads the question from the JSON Siren sends', () => {
    const question = (JSON.parse(ENVELOPE) as { data: AppPayoutQuestion }).data;
    expect(question.payout.id).toBe(88);
    expect(question.payout.attempt).toBe(1);
    expect(question.amount.value).toBe(2500);
    expect(question.amount.currency.decimalPlaces).toBe(2);
    expect(question.collaborator.email).toBe('ana@example.com');
  });

  it('sends a paid and a failed answer through the one answer route', async () => {
    const paid: AppPayoutAnswer = { outcome: 'paid', reference: 'acme-ledger-5521' };
    const failed: AppPayoutAnswer = { outcome: 'failed', reason: 'The account is closed.' };
    const accepted = { status: 'accepted', duplicate: false };
    const over = transportOver([reply(200, accepted), reply(200, accepted)]);
    const resource = new AppsResource(over.transport);
    expect(await resource.requests.answer(APP_REQUEST_ID, paid)).toEqual(accepted);
    expect(await resource.requests.answer(APP_REQUEST_ID, failed)).toEqual(accepted);
    expect(over.http.requests.map((request) => bodyOf(request))).toEqual([paid, failed]);
  });

  it('refuses an answer that is neither paid nor failed at compile time', () => {
    // @ts-expect-error a paid answer carries a reference, not a reason
    const wrong: AppPayoutAnswer = { outcome: 'paid', reason: 'x' };
    expect(wrong.outcome).toBe('paid');
  });

  it('posts the paid answer a typed payoutMethod function returns', async () => {
    const http = new FakeHttpClient([reply(200, { status: 'accepted', duplicate: false })]);
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
    const seen: number[] = [];
    const answers = siren.apps.requestHandler({ signingSecret: SECRET });
    answers.on('payoutMethod', 'acme-ledger', ({ data }) => {
      seen.push(data.payout.id, data.amount.value);
      return { outcome: 'paid', reference: `acme-ledger-${data.payout.id}` };
    });
    const result = await answers.handle({ method: 'POST', headers: headers(ENVELOPE), rawBody: ENVELOPE });
    expect(result.status).toBe(200);
    await result.after!();
    expect(seen).toEqual([88, 2500]);
    expect(http.requests).toHaveLength(1);
    expect(pathOf(http.requests[0])).toBe(`/apps/requests/${ID}/answer`);
    expect(bodyOf(http.requests[0])).toEqual({ outcome: 'paid', reference: 'acme-ledger-88' });
  });

  it('raises the answer to a dropped ask as ConflictError app_request_dropped', async () => {
    const over = transportOver([
      reply(409, { error: { message: 'Siren stopped waiting for this answer.', code: 'app_request_dropped', context: [] } }),
    ]);
    const error = await new AppsResource(over.transport).requests
      .answer(APP_REQUEST_ID, { outcome: 'paid', reference: 'acme-ledger-5521' })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ConflictError);
    expect(appErrorCode(error)).toBe(AppErrorCode.Dropped);
  });
});
