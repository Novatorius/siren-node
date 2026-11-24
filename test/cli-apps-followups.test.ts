import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appLines } from '../src/cli/commands/apply';
import type { App } from '../src/record-types';
import { APP_KEY, AppAnswers, appBefore, appRecord } from './apps-siren-answers';
import { harness } from './cli-fakes';
import { Siren } from '../src/client';
import { AuthenticationError } from '../src/errors';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';
import { capturedBody, capturedReply } from './cloud-captures';
import { reply } from './http-fakes';

/*
 * What the `siren` command says about what a real Siren Cloud answered, for
 * the follow-ups after the merge (docs/architecture/apps-cli.md, "Follow-ups
 * after the merge"). The answers are captures from a local sandbox Cloud
 * built from Novatorius/siren feat/apps at 57999d085 (the run folder's
 * e2e2/captures), copied to test/fixtures/cloud-captures.
 */

const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
const appEnv = { SIREN_APP_URL: 'https://acme.example/siren' };
const DROPPED = 'apps-declare-200-dropped-selected-item';
const ARCHIVED_LINE = '  app:1  Post-conversion action (postConversionAction)  notify-crm  Tell the CRM  archived, so Siren no longer calls it';

describe('apps-sdk-followups-1: an archived item', () => {
  it('apply marks the archived item beside it, and says once what archiving means and how to bring it back', async () => {
    const h = harness([appBefore(), capturedReply(DROPPED)], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    const lines = h.out().split('\n');
    expect(lines).toContain(ARCHIVED_LINE);
    // The capture predates the payout kind's new word, so Siren answered the old one.
    expect(lines).toContain('  app:2  fulfillmentMethod  acme-ledger  Acme ledger');
    expect(lines).toContain(
      'An archived feature is one siren.app.json no longer names while a record still selects it. ' +
        'Siren keeps it so that record still points at it, never calls it, and deletes it once nothing selects it. ' +
        'To bring it back, name it in siren.app.json again with the same kind and key, and run siren apps apply.',
    );
    expect(h.out().match(/An archived feature is/g)).toHaveLength(1);
  });

  it('keeps the target flags in the apply hint, and names the file as it was given', async () => {
    const h = harness([appBefore(), capturedReply(DROPPED)], { env: appEnv });
    h.signedIn();
    h.write('my.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', 'my.app.json', '--sandbox', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain('name it in my.app.json again with the same kind and key, and run siren apps apply my.app.json --sandbox.');
  });

  it('says nothing about archiving when no item is archived', async () => {
    const body = capturedBody<App>(DROPPED);
    const h = harness([appBefore(), ...[capturedReply(DROPPED)].map(() => ({ status: 200, headers: {}, body: JSON.stringify({ ...body, items: body.items.map((item) => ({ ...item, status: 'active' })) }) }))], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).not.toContain('archived');
  });

  it('show and list mark the archived item beside it', async () => {
    const body = capturedBody<App>(DROPPED);
    const h = harness([capturedReply(DROPPED), { status: 200, headers: {}, body: JSON.stringify([body]) }]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out().split('\n')).toContain(ARCHIVED_LINE);
    expect(h.out()).not.toContain('An archived feature is');
    const before = h.out().length;
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.out().slice(before).split('\n')).toContain(ARCHIVED_LINE);
    expect(appLines(body)).toContain(ARCHIVED_LINE);
  });
});

const ONE = 'apps-request-one-200-needs-attention';
const ONE_ID = 'apr_e221f712e2dd08c2daa566d3ac5ce340';

describe('apps-sdk-followups-1: siren apps requests <id> reads the one request', () => {
  it('reads it with GET /apps/requests/{id}, and shows its line, the data Siren sent, and that no one has answered', async () => {
    const h = harness([capturedReply(ONE), reply(200, [appRecord({ id: 1 })]), reply(200, [])]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', ONE_ID]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`GET /apps/requests/${ONE_ID}`, 'GET /apps', 'GET /apps/acme-payouts/deliveries']);
    const out = h.out();
    expect(out.split('\n')[0]).toBe(
      `${ONE_ID}  needs_attention  tell Post-conversion action (postConversionAction)  app:1  conversion 2  1 send  2026-11-17T12:21:12+00:00  Could not connect to the host.`,
    );
    expect(out).toContain(`The data Siren sent:\n${JSON.stringify(capturedBody<{ data: unknown }>(ONE).data, null, 2)}\n`);
    expect(out).toContain('A tell takes no answer.');
    expect(out).not.toContain('not among the latest 50');
  });

  it('shows the answer Siren took and the person who gave it, or that the app gave it', async () => {
    const body = capturedBody<Record<string, unknown>>(ONE);
    const byPerson = { ...body, mode: 'ask', status: 'applied', answer: { outcome: 'paid', reference: 'TX-1' }, answeredBy: 'user:5', answeredAt: '2026-11-17T12:40:00+00:00', answeredByUser: { id: 5, email: 'jane@store.invalid' } };
    const h = harness([reply(200, byPerson), reply(200, []), reply(200, { ...byPerson, answeredBy: 'app:1', answeredByUser: null }), reply(200, [])]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', ONE_ID]), h.err()).toBe(0);
    expect(h.out()).toContain('The answer Siren took, from jane@store.invalid (user 5) at 2026-11-17T12:40:00+00:00:\n{\n  "outcome": "paid",\n  "reference": "TX-1"\n}\n');
    const before = h.out().length;
    expect(await h.run(['apps', 'requests', ONE_ID]), h.err()).toBe(0);
    expect(h.out().slice(before)).toContain('The answer Siren took, from the app at 2026-11-17T12:40:00+00:00:');

    const waiting = harness([reply(200, { ...body, mode: 'ask', status: 'sent' }), reply(200, [])]);
    waiting.signedIn();
    expect(await waiting.run(['apps', 'requests', ONE_ID]), waiting.err()).toBe(0);
    expect(waiting.out()).toContain('No answer yet.');
  });

  it('shows a request older than the latest 50, since it no longer looks among them', async () => {
    const h = harness([capturedReply(ONE), reply(200, []), reply(200, [])]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', ONE_ID]), h.err()).toBe(0);
    expect(h.paths()).not.toContain('GET /apps/requests');
  });

  it("refuses a request the organization does not have in one line that says where to see the latest, with the target flags", async () => {
    for (const answer of [capturedReply('apps-request-one-404'), AppAnswers.requestNotFound()]) {
      const h = harness([answer]);
      h.signedIn();
      expect(await h.run(['apps', 'requests', ONE_ID, '--sandbox'])).toBe(1);
      expect(h.err()).toBe(`siren: This organization has no request ${ONE_ID}. See the latest with siren apps requests --sandbox.\n`);
    }
  });
});

describe('apps-sdk-followups-1: how many of an app\'s requests need attention', () => {
  it('types needsAttention as the count Siren sends on every app', () => {
    const listed = capturedBody<App[]>('apps-list-200-count-1');
    const counts: number[] = listed.map((one) => one.needsAttention);
    expect(counts).toEqual([1, 0]);
    expect(capturedBody<App>('apps-retrieve-200-with-count').needsAttention).toBe(0);
  });

  it('list says how many need attention under an app that has any, with the command that shows them', async () => {
    const h = harness([capturedReply('apps-list-200-count-1')]);
    h.signedIn();
    expect(await h.run(['apps', 'list', '--sandbox']), h.err()).toBe(0);
    const lines = h.out().split('\n');
    const note = '  1 request needs attention. See it with siren apps requests --app acme-payouts --attention --sandbox.';
    expect(lines).toContain(note);
    expect(lines.indexOf(note)).toBeLessThan(lines.findIndex((line) => line.startsWith('ledger-sync')));
    expect(h.out().match(/need(s)? attention/g)).toHaveLength(1);
  });

  it('show says the count when it is above zero, and nothing when it is zero', async () => {
    const body = capturedBody<App>('apps-retrieve-200-with-count');
    const h = harness([reply(200, { ...body, needsAttention: 2 }), capturedReply('apps-retrieve-200-with-count')]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out().split('\n')).toContain('  2 requests need attention. See them with siren apps requests --app acme-payouts --attention.');
    const before = h.out().length;
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out().slice(before)).not.toContain('attention');
  });
});

const RESEND_ID = 'apr_e221f712e2dd08c2daa566d3ac5ce340';

describe('apps-sdk-followups-1: hints that send a person the right way', () => {
  it('a delete records still hold says to turn the app off only while it is on', async () => {
    const on = harness([capturedReply('apps-delete-409-in-use'), reply(200, appRecord({ key: 'ledger-sync', status: 'active' }))]);
    on.signedIn();
    expect(await on.run(['apps', 'delete', 'ledger-sync', '--yes', '--sandbox'])).toBe(1);
    expect(on.paths()).toEqual(['DELETE /apps/ledger-sync', 'GET /apps/ledger-sync']);
    expect(on.err()).toBe(
      'siren: Siren kept ledger-sync.\nRecords still select its features: app:4 (1), app:5 (1).\n' +
        'Turn it off instead with siren apps off ledger-sync --sandbox. Siren then stops calling it and keeps what it already did.\n',
    );

    const off = harness([capturedReply('apps-delete-409-in-use'), reply(200, appRecord({ key: 'ledger-sync', status: 'inactive' }))]);
    off.signedIn();
    expect(await off.run(['apps', 'delete', 'ledger-sync', '--yes', '--sandbox'])).toBe(1);
    expect(off.err()).toBe(
      'siren: Siren kept ledger-sync.\nRecords still select its features: app:4 (1), app:5 (1).\n' +
        'It is already off, so Siren no longer calls it. To delete it, change each record that selects those features to another choice, ' +
        'then run siren apps delete ledger-sync --yes --sandbox.\n',
    );
    expect(off.err()).not.toContain('Turn it off');
  });

  it("a resend refused because the app is off says to turn it on, with the command", async () => {
    const request = { ...capturedBody<Record<string, unknown>>('apps-request-one-200-needs-attention'), appId: 4 };
    const h = harness([capturedReply('apps-resend-409-app-off'), reply(200, request), reply(200, [appRecord({ status: 'inactive' })])]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', RESEND_ID, '--sandbox'])).toBe(1);
    expect(h.paths()).toEqual([`POST /apps/requests/${RESEND_ID}/resend`, `GET /apps/requests/${RESEND_ID}`, 'GET /apps']);
    expect(h.err()).toBe(
      `siren: Siren sent nothing: ${APP_KEY} is off, and Siren sends nothing to an app that is off. ` +
        `Turn it on with siren apps on ${APP_KEY} --sandbox, then run siren apps resend ${RESEND_ID} --sandbox.\n`,
    );
  });

  it('a resend refused for an applied request says there is nothing to send, and reads nothing more', async () => {
    const h = harness([AppAnswers.notResendable('applied')]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', RESEND_ID])).toBe(1);
    expect(h.paths()).toEqual([`POST /apps/requests/${RESEND_ID}/resend`]);
    expect(h.err()).toBe(`siren: Siren sent nothing: ${RESEND_ID} is applied, so its answer already did its work.\n`);
  });

  it("the uncoded 401 on the answer route names siren apps rotate-key, not the API keys screen", async () => {
    for (const name of ['apps-answer-401-unknown-key', 'apps-answer-401-no-bearer']) {
      const siren = new Siren({ apiKey: 'made-up-key', baseUrl: BASE, httpClient: new FakeHttpClient([capturedReply(name)]), maxRetries: 0 });
      const error = await siren.apps.requests.answer(RESEND_ID, { outcome: 'paid' }).then(() => undefined, (caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(AuthenticationError);
      expect((error as Error).message, name).toBe(
        "Siren did not accept this key on the answer route. An app answers with its own key, the SIREN_API_KEY that siren apps apply saved beside its app file. " +
          'When that key is lost, run siren apps rotate-key <app key> to make a new one. ' +
          'When the app holds no key, as after its key was revoked, run siren apps add-key <app key>.',
      );
      expect((error as Error).message).not.toContain('under API keys');
    }
  });

  it('the uncoded 401 an admin gets from siren apps answer says to sign in again, with the target flags', async () => {
    const h = harness([capturedReply('apps-answer-401-unknown-key')]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', RESEND_ID, '--body', '{"outcome":"paid"}', '--sandbox'])).toBe(1);
    expect(h.err()).toBe('siren: Your session has ended. Run siren login --sandbox to sign in again.\n');
  });
});
