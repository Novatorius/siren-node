import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/*
 * A payout method's ask as Siren sends one, for the example app's tests:
 * Siren's signed fixture with its data set to the shape AppPayoutQuestion
 * builds (and the kind's sample in AppFeatureSamples shows), signed again
 * with the fixture's secret. The fixture itself is Siren's, and other tests
 * pin its bytes, so it stays as Siren makes it.
 */

export interface SignedFixture {
  secret: string;
  timestamp: number;
  body: string;
  headers: Record<string, string>;
}

export const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8'),
) as SignedFixture;

/** The data of a payout method's ask, as Siren sends it. */
export const PAYOUT_DATA = {
  payout: { id: 88, fulfillmentId: 31, attempt: 1 },
  amount: { value: 2500, units: 'USD' },
  collaborator: { id: 42, name: 'Ana Ruiz', email: 'ana@example.com' },
};

/** The fixture carrying a payout ask's data, signed again with the fixture's secret. */
export const ask: { body: string; headers: Record<string, string> } = (() => {
  const request = JSON.parse(fixture.body) as Record<string, unknown>;
  request.data = PAYOUT_DATA;
  const body = JSON.stringify(request);
  const v1 = createHmac('sha256', fixture.secret).update(`${fixture.timestamp}.${body}`).digest('hex');
  return { body, headers: { ...fixture.headers, 'X-Siren-Signature-V2': `t=${fixture.timestamp},v1=${v1}` } };
})();
