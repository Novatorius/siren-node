import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppEnv } from '../examples/apps/acme/env.mjs';
import { answerFor, createAcmeApp } from '../examples/apps/acme/handler.mjs';
import { sendSale } from '../examples/apps/acme/sale.mjs';
import { Siren } from '../src/client';
import type { HttpResponse } from '../src/http';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf, unavailable } from './record-fakes';

/*
 * Acceptance tests for the example app, packet example-app. Contract:
 * docs/architecture/apps-cli.md, "The example app", and the comment at the
 * top of examples/apps/acme/handler.mjs.
 *
 * The request is Siren's signed fixture. The distribution resolver's data
 * and answer shapes are a claim on slice 5, written down in the note.
 */

interface SignedFixture {
  secret: string;
  timestamp: number;
  body: string;
  headers: Record<string, string>;
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8'),
) as SignedFixture;
const APP_KEY = `sk_test_${'0a'.repeat(32)}`;
const REQUEST = 'apr_b79943ff8ca353ce5cf5312bb3fa66c7';

function acme(replies: Array<HttpResponse | Error>, now = fixture.timestamp) {
  const http = new FakeHttpClient(replies);
  const siren = new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
  const app = createAcmeApp({ siren, signingSecret: fixture.secret, now: () => now, log: () => {} });
  return { http, app };
}

describe('apps-cli: the example app', () => {
  it("answers Siren's signed ask with 200, then pays it with the app's key", async () => {
    const { http, app } = acme([reply(200, { status: 'accepted' })]);
    const result = await app.handle(fixture.body, fixture.headers);
    expect(result.status).toBe(200);
    await result.answered;

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe('POST');
    expect(new URL(http.requests[0]!.url).pathname).toBe(`/siren/v1/apps/requests/${REQUEST}/answer`);
    expect(http.bearers()[0]).toBe(`Bearer ${APP_KEY}`);
    expect(bodyOf(http.requests[0])).toEqual({ outcome: 'paid', reference: 'acme-88' });
  });

  it('answers a repeat with 200 and acts on it once', async () => {
    const { http, app } = acme([reply(200, { status: 'accepted' })]);
    await (await app.handle(fixture.body, fixture.headers)).answered;
    const again = await app.handle(Buffer.from(fixture.body), fixture.headers);
    expect(again.status).toBe(200);
    await again.answered;
    expect(http.requests).toHaveLength(1);
  });

  it('answers again after an answer that failed', async () => {
    const { http, app } = acme([unavailable(), reply(200, { status: 'accepted' })]);
    await (await app.handle(fixture.body, fixture.headers)).answered;
    await (await app.handle(fixture.body, fixture.headers)).answered;
    expect(http.requests).toHaveLength(2);
  });

  it('refuses a request it cannot check with 400 and sends nothing', async () => {
    const changed = acme([reply(200, { status: 'accepted' })]);
    expect((await changed.app.handle(fixture.body.replace('2500', '2600'), fixture.headers)).status).toBe(400);
    const stale = acme([reply(200, { status: 'accepted' })], fixture.timestamp + 3600);
    expect((await stale.app.handle(fixture.body, fixture.headers)).status).toBe(400);
    expect(changed.http.requests).toHaveLength(0);
    expect(stale.http.requests).toHaveLength(0);
  });

  it('pays a payout with its own reference, and divides a pool by each metric in whole minor units', () => {
    expect(answerFor({ item: { kind: 'fulfillmentMethod', key: 'acme-ledger', id: 'app:12' }, data: { payoutId: 88, amount: 2500, currency: 'USD' } })).toEqual({
      outcome: 'paid',
      reference: 'acme-88',
    });
    const split = (amount: number, values: number[]) =>
      answerFor({
        item: { kind: 'distributionResolver', key: 'acme-split', id: 'app:13' },
        data: { amount, currency: 'USD', metrics: values.map((value, index) => ({ id: `m${index + 1}`, value })) },
      });
    expect(split(1000, [3, 1])).toEqual({ outcome: 'resolved', shares: [{ id: 'm1', amount: 750 }, { id: 'm2', amount: 250 }] });
    expect(split(100, [1, 1, 1])).toEqual({
      outcome: 'resolved',
      shares: [{ id: 'm1', amount: 34 }, { id: 'm2', amount: 33 }, { id: 'm3', amount: 33 }],
    });
    expect(split(10, [0, 0])).toEqual({ outcome: 'resolved', shares: [{ id: 'm1', amount: 5 }, { id: 'm2', amount: 5 }] });
    expect(answerFor({ item: { kind: 'postConversionAction', key: 'notify-crm', id: 'app:11' }, data: {} })).toBeNull();
  });

  it('reads the env file apply wrote, and never guesses between the sandbox and live', () => {
    const lines = (base: string) => `PORT=8787\nSIREN_BASE_URL=${base}\nSIREN_API_KEY=${APP_KEY}\nSIREN_SIGNING_SECRET=${fixture.secret}\n`;
    const one = mkdtempSync(join(tmpdir(), 'acme-env-'));
    writeFileSync(join(one, '.env.live'), lines('https://api.sirenaffiliates.com/siren/v1'));
    expect(loadAppEnv(one, {})).toEqual({
      path: join(one, '.env.live'),
      values: { SIREN_BASE_URL: 'https://api.sirenaffiliates.com/siren/v1', SIREN_API_KEY: APP_KEY, SIREN_SIGNING_SECRET: fixture.secret },
    });

    writeFileSync(join(one, '.env.sandbox'), lines(BASE));
    expect(() => loadAppEnv(one, {})).toThrow(/SIREN_ENV_FILE/);
    expect(loadAppEnv(one, { SIREN_ENV_FILE: join(one, '.env.sandbox') }).values.SIREN_BASE_URL).toBe(BASE);

    const none = mkdtempSync(join(tmpdir(), 'acme-env-'));
    expect(() => loadAppEnv(none, {})).toThrow(/siren apps apply/);
    writeFileSync(join(none, '.env.sandbox'), 'PORT=8787\n');
    expect(() => loadAppEnv(none, {})).toThrow(/SIREN_API_KEY/);
  });

  it("sends a real sale with the app's own key: a visit, then a sale on its opportunity", async () => {
    const http = new FakeHttpClient([
      reply(200, { status: 'attributed' }, { 'X-Siren-OID': '501' }),
      reply(200, { status: 'created' }, { 'X-Siren-OID': '501' }),
    ]);
    const siren = new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: http });
    const result = await sendSale(siren, { collaborator: 'tracking:ada', total: 49, currency: 'USD', externalId: 'acme-1' });

    expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual(['/siren/v1/event/site-visited', '/siren/v1/event/sale']);
    expect(http.bearers()).toEqual([`Bearer ${APP_KEY}`, `Bearer ${APP_KEY}`]);
    expect(bodyOf(http.requests[0])).toMatchObject({ collaboratorId: 'tracking:ada' });
    const sale = bodyOf(http.requests[1]) as Record<string, unknown>;
    expect(sale).toMatchObject({ trackingId: 501, total: 49, currency: 'USD', externalId: 'acme-1', source: 'acme-example' });
    expect(sale.test).not.toBe(true);
    expect(result).toMatchObject({ opportunityId: 501, status: 'created' });
  });

  it('declares the scopes a sale needs and the shortest answer window on each ask', () => {
    const file = JSON.parse(readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8')) as {
      apps: Record<string, { scopes: string[]; items: Record<string, { answerWindowMinutes?: number }> }>;
    };
    const scopes = readFileSync(new URL('./fixtures/api-key-scopes.json', import.meta.url), 'utf8');
    const app = file.apps['acme-payouts']!;
    expect(app.scopes).toEqual(expect.arrayContaining(['event:site-visited', 'event:sale']));
    for (const scope of app.scopes) expect(scopes, scope).toContain(`"scope": "${scope}"`);
    expect(app.items['acme-ledger']!.answerWindowMinutes).toBe(1);
    expect(app.items['acme-split']!.answerWindowMinutes).toBe(1);
  });
});
