import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppEnv } from '../examples/apps/acme/env.mjs';
import { answerFor, createAcmeApp } from '../examples/apps/acme/handler.mjs';
import { saleLine, sendSale } from '../examples/apps/acme/sale.mjs';
import { Siren } from '../src/client';
import type { HttpResponse } from '../src/http';
import { FakeHttpClient, reply } from './http-fakes';
import { capturedReply } from './cloud-captures';
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
    expect(answerFor({ item: { kind: 'payoutMethod', key: 'acme-ledger', id: 'app:12' }, data: { payoutId: 88, amount: 2500, currency: 'USD' } })).toEqual({
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

  // Slice C6 item 9: the key and the signing secret change apart, so each missing line names its own command.
  it('names the command that writes each missing line, never the old joint rotate', () => {
    const folder = mkdtempSync(join(tmpdir(), 'acme-env-'));
    writeFileSync(join(folder, '.env.sandbox'), `SIREN_BASE_URL=${BASE}\nSIREN_API_KEY=${APP_KEY}\n`);
    expect(() => loadAppEnv(folder, {})).toThrow(
      'has no SIREN_SIGNING_SECRET. siren apps rotate-secret writes a new signing secret, and an app with no url has none, so give siren.app.json a url and run siren apps apply.',
    );
    writeFileSync(join(folder, '.env.sandbox'), `SIREN_BASE_URL=${BASE}\nSIREN_SIGNING_SECRET=${fixture.secret}\n`);
    expect(() => loadAppEnv(folder, {})).toThrow(
      'has no SIREN_API_KEY. siren apps rotate-key writes a new key, or siren apps add-key for an app that holds none.',
    );
    let message = '';
    try {
      loadAppEnv(folder, {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/siren apps rotate(?!-)/);
  });

  it("the example's README walks through the question apply asks, the split rotation and features", () => {
    const readme = readFileSync(new URL('../examples/apps/acme/README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    for (const text of ['siren apps apply --yes', 'siren apps rotate-key acme-payouts', 'siren apps rotate-secret acme-payouts', 'requires Pro', '`payoutMethod`']) {
      expect(readme, text).toContain(text);
    }
    expect(readme.replace(/`[^`]*`/g, '')).not.toMatch(/\bitems?\b/i);
    expect(readme).not.toMatch(/siren apps rotate(?!-)/);
  });

  it("sends a real sale with the app's own key: a visit, then a sale on its opportunity", async () => {
    // A real Cloud answers both with `recorded` when no program pays for them
    // (captures events-site-visited-200 and events-sale-200-no-program).
    const http = new FakeHttpClient([capturedReply('events-site-visited-200'), capturedReply('events-sale-200-no-program')]);
    const siren = new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: http });
    const result = await sendSale(siren, { collaborator: 'tracking:ada', total: 49, currency: 'USD', externalId: 'acme-1' });

    expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual(['/siren/v1/event/site-visited', '/siren/v1/event/sale']);
    expect(http.bearers()).toEqual([`Bearer ${APP_KEY}`, `Bearer ${APP_KEY}`]);
    expect(bodyOf(http.requests[0])).toMatchObject({ collaboratorId: 'tracking:ada' });
    const sale = bodyOf(http.requests[1]) as Record<string, unknown>;
    expect(sale).toMatchObject({ trackingId: 1, total: 49, currency: 'USD', externalId: 'acme-1', source: 'acme-example' });
    expect(sale.test).not.toBe(true);
    expect(result).toEqual({
      opportunityId: 1,
      status: 'recorded',
      conversions: 0,
      reason: 'no_program',
      message: 'The sale was recorded. Nothing was awarded because no active program accepts sales.',
    });
  });

  it('prints a sale that made a conversion apart from one that made none, with the reason Siren gave', async () => {
    // A sale that made conversions: SaleIngestionService::ingest() answers
    // `created` with each conversion's id and status
    // (lib/Conversions/Engine/Core/Services/SaleIngestionService.php lines
    // 208 to 217 and 478 to 493 on feat/apps at 1557b0030).
    const made = new FakeHttpClient([
      capturedReply('events-site-visited-200'),
      reply(200, { status: 'created', created: true, transactionId: 7, conversions: [{ id: 88, status: 'pending' }], message: 'The sale was recorded and attributed.' }),
    ]);
    const conversion = await sendSale(new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: made }), { collaborator: 'tracking:ada', total: 49, currency: 'USD', externalId: 'acme-2' });
    expect(saleLine('49', '/acme/.env.sandbox', conversion)).toBe(
      'Sent a sale of 49 USD through /acme/.env.sandbox: Siren made 1 conversion on opportunity 1.',
    );

    const none = new FakeHttpClient([capturedReply('events-site-visited-200'), capturedReply('events-sale-200-no-program')]);
    const recorded = await sendSale(new Siren({ apiKey: APP_KEY, baseUrl: BASE, httpClient: none }), { collaborator: 'tracking:ada', total: 49, currency: 'USD', externalId: 'acme-3' });
    expect(saleLine('49', '/acme/.env.sandbox', recorded)).toBe(
      'Sent a sale of 49 USD through /acme/.env.sandbox: Siren recorded it on opportunity 1 and made no conversion (no_program). ' +
        'The sale was recorded. Nothing was awarded because no active program accepts sales.',
    );
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
