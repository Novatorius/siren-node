import { describe, expect, it } from 'vitest';
import { createAcmeApp } from '../examples/apps/acme/handler.mjs';
import { sendSale } from '../examples/apps/acme/sale.mjs';
import { Siren } from '../src/client';
import { ask, fixture } from './apps-example-ask';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * The implementer's tests for packet example-app, beside the acceptance
 * tests in test/apps-example.test.ts. They hold the rules those tests do not
 * reach: a repeat that arrives while the first answer is still on its way,
 * and a visit Siren opens no opportunity for.
 */

const APP_KEY = `sk_test_${'0a'.repeat(32)}`;

describe('the example app, beyond the contract', () => {
  it('answers once when a repeat arrives while the first answer is on its way', async () => {
    const http = new FakeHttpClient([reply(200, { status: 'accepted' }), reply(200, { status: 'accepted', duplicate: true })]);
    const siren = new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
    const app = createAcmeApp({ siren, signingSecret: fixture.secret, now: () => fixture.timestamp });

    const first = await app.handle(ask.body, ask.headers);
    const repeat = await app.handle(ask.body, ask.headers);
    expect(repeat.status).toBe(200);
    await Promise.all([first.answered, repeat.answered]);
    expect(http.requests).toHaveLength(1);
  });

  it('sends no sale when Siren opens no opportunity for the visit', async () => {
    const http = new FakeHttpClient([reply(200, { status: 'not_attributed' })]);
    const siren = new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: http });
    await expect(sendSale(siren, { collaborator: 'tracking:nobody', total: 49, externalId: 'acme-2' })).rejects.toThrow(
      /opened no opportunity for tracking:nobody \(not_attributed\)/,
    );
    expect(http.requests).toHaveLength(1);
  });
});
