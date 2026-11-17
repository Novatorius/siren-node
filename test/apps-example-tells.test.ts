import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAcmeApp, describeTell } from '../examples/apps/acme/handler.mjs';
import { Siren } from '../src/client';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';
import { AppCurrencies, AppTells } from './apps-siren-answers';

/*
 * The example app reads the amount in each tell with `apps.shownAmount()`,
 * so it never prints the stored integer as if it were the amount. The tells
 * are built as Siren's AppActionSubjects builds them (test/apps-siren-answers.ts)
 * and signed as Siren signs a request (X-Siren-Signature-V2 over "<t>.<body>").
 */

const SECRET = 'ab'.repeat(32);
const T = 1794913200;
const siren = new Siren({ apiKey: `sk_test_${'0a'.repeat(32)}`, baseUrl: BASE, httpClient: new FakeHttpClient([]), maxRetries: 0 });

function tell(kind: string, key: string, data: unknown): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    version: 1,
    id: 'apr_0123456789abcdef0123456789abcdef',
    type: 'app.request',
    mode: 'tell',
    app: 'acme-payouts',
    item: { kind, key, id: 'app:11' },
    createdAt: '2026-11-17T09:14:03+00:00',
    data,
  });
  const v1 = createHmac('sha256', SECRET).update(`${T}.${body}`).digest('hex');
  return { body, headers: { 'X-Siren-Event': 'app.request', 'X-Siren-Signature-V2': `t=${T},v1=${v1}`, 'X-Siren-Timestamp': String(T) } };
}

describe('apps-sdk-followups-1: the example app reads the amount in a tell', () => {
  it('logs the reward of an approved conversion as a person reads it, yen and points included', async () => {
    for (const [value, currency, shown] of [
      [1500, AppCurrencies.usd(), '$15.00'],
      [10000, AppCurrencies.jpy(), '¥100'],
      [10000, AppCurrencies.points(), '10,000 pts'],
    ] as const) {
      const lines: string[] = [];
      const app = createAcmeApp({ siren, signingSecret: SECRET, now: () => T, log: (line) => lines.push(line) });
      const { body, headers } = tell('postConversionAction', 'notify-crm', AppTells.conversionApproved(value, currency));
      expect((await app.handle(body, headers)).status).toBe(200);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`reward ${shown}`);
      expect(lines[0]).toContain('conversion 51');
    }
  });

  it('logs a completed allocation with its amount, and a conversion with no reward as such', () => {
    expect(describeTell(siren, { item: { kind: 'postAllocationAction' }, data: AppTells.allocationCompleted(2500) })).toBe(
      'allocation 21:40 completed for collaborator 4 by distributor Partner pool, $25.00.',
    );
    expect(describeTell(siren, { item: { kind: 'postConversionAction' }, data: AppTells.conversionApproved(10000, AppCurrencies.jpy()) })).toBe(
      'conversion 51 approved for collaborator 4 in program Partners, reward ¥100.',
    );
    expect(describeTell(siren, { item: { kind: 'postConversionAction' }, data: AppTells.conversionWithoutReward() })).toBe(
      'conversion 52 approved for collaborator 4 in program Partners, with no reward.',
    );
  });

  it('logs the data as it came for a tell it does not know, and never reads an amount without its currency', () => {
    expect(describeTell(siren, { item: { kind: 'someNewKind' }, data: { value: 10000 } })).toBe('{"value":10000}');
    const noCurrency = { ...AppTells.allocationCompleted(10000), allocation: { ...AppTells.allocationCompleted(10000).allocation, currency: undefined } };
    expect(describeTell(siren, { item: { kind: 'postAllocationAction' }, data: noCurrency })).toBe(JSON.stringify(noCurrency));
  });
});
