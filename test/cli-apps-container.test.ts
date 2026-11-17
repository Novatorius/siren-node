import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { harness } from './cli-fakes';
import { APP_KEY, appRecord, itemPage } from './apps-siren-answers';
import { capturedReply } from './cloud-captures';

/*
 * Slice C6: the `siren` command for the app as a container of its key, its
 * address and its features. Contract: docs/architecture/apps-sdk-container.md.
 * The answers are Siren's, from test/apps-siren-answers.ts.
 */

const KEY = APP_KEY;
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);

function appFile(app: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: 'Example.', apps: { [KEY]: app } }, null, 2);
}

const keyOnlyFile = appFile({ name: 'Acme', scopes: ['records:programs:read'] });
const keyOnly = appRecord({ url: null, address: null, events: [], items: [] });
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };

/** Siren's answer to `GET /apps/{key}` for a key it lacks, as a real Cloud sent it. */
const missing = () => capturedReply('apps-retrieve-404');

describe('apps-sdk-container item 3: a key-only app from the file', () => {
  it('declares an app with no url, and writes only its key, never an empty signing secret', async () => {
    const h = harness([missing(), reply(201, { ...keyOnly, rawKey: RAW_KEY })]);
    h.signedIn();
    h.write('siren.app.json', keyOnlyFile);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests.at(-1))).toEqual({ name: 'Acme', scopes: ['records:programs:read'] });
    const lines = h.file('.env.sandbox').trimEnd().split('\n');
    expect(lines).toEqual([`SIREN_BASE_URL=${SANDBOX_BASE_URL}`, `SIREN_API_KEY=${RAW_KEY}`]);
    expect(h.out()).toContain(`Key ${RAW_KEY.slice(0, 16)} is in ${join(h.cwd, '.env.sandbox')}.`);
    expect(h.printed()).not.toContain(RAW_KEY);
  });

  it('saves the signing secret a later apply gets when the file adds a url, and keeps the key', async () => {
    const h = harness([reply(200, keyOnly), reply(200, { ...appRecord({ items: [] }), signingSecret: SIGNING_SECRET })], { env: URL_ENV });
    h.signedIn();
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\n`);
    h.write('siren.app.json', appFile({ name: 'Acme', description: "Siren's example app.", url: '${SIREN_APP_URL}' }));
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain('  adds an address, with a new signing secret');
    expect(h.file('.env.sandbox').trimEnd().split('\n')).toEqual([
      `SIREN_BASE_URL=${SANDBOX_BASE_URL}`,
      `SIREN_API_KEY=${RAW_KEY}`,
      `SIREN_SIGNING_SECRET=${SIGNING_SECRET}`,
    ]);
    expect(h.out()).toContain(`Its new signing secret is in ${join(h.cwd, '.env.sandbox')}.`);
    expect(h.printed()).not.toContain(SIGNING_SECRET);
  });

  it('refuses a file with features and no url before anything is sent', async () => {
    const h = harness([reply(201, keyOnly)]);
    h.signedIn();
    h.write('siren.app.json', appFile({ name: 'Acme', items: { notify: { kind: 'postConversionAction', name: 'Tell me' } } }));
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('has features and no url');
  });
});

/** The example's three features, as the file in examples/apps/acme declares them. */
const exampleFile = JSON.stringify({
  version: 1,
  name: 'Acme payouts',
  description: 'Example.',
  apps: {
    [KEY]: {
      name: 'Acme',
      description: "Siren's example app.",
      url: '${SIREN_APP_URL}',
      scopes: [],
      events: [],
      items: {
        'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' },
        'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['usd'], answerWindowMinutes: 1 },
      },
    },
  },
});

describe('apps-sdk-container item 4: apply shows what it will change and asks', () => {
  it('reads the app first, and with nothing to change says so and writes nothing', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.paths()).toEqual([`GET /apps/${KEY}`]);
    expect(h.out()).toBe(`${KEY} on ${SANDBOX_BASE_URL} already matches siren.app.json, so nothing was sent.\n`);
    expect(() => h.file('.env.sandbox')).toThrow();
    expect(h.credentials().sessions[SANDBOX_BASE_URL]?.envFiles).toBeUndefined();
  });

  it('prints each difference, a dashboard change and a feature the file lacks included, then asks and writes on yes', async () => {
    const changed = appRecord({
      name: 'Acme from the dashboard',
      description: 'Changed in the dashboard.',
      url: 'https://elsewhere.example/siren',
      address: { id: 31, url: 'https://elsewhere.example/siren', events: ['sale.created'], status: 'active', dateCreated: null },
      events: ['sale.created'],
      apiKey: { ...appRecord().apiKey, scopes: ['event:sale'] },
      items: [
        { ...appRecord().items[0], name: 'Tell the CRM, renamed' },
        { ...appRecord().items[1], status: 'archived' },
        { ...appRecord().items[0], id: 13, ref: 'app:13', key: 'added-in-dashboard', name: 'Added' },
        { ...appRecord().items[0], id: 14, ref: 'app:14', key: 'unused', name: 'Unused' },
      ],
    });
    const h = harness(
      [reply(200, changed), reply(200, itemPage({ id: 13, uses: 2 })), reply(200, itemPage({ id: 14, uses: 0, usedBy: [] })), reply(200, appRecord())],
      { env: URL_ENV, interactive: true, typed: ['yes'] },
    );
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.paths()).toEqual([`GET /apps/${KEY}`, `GET /apps/${KEY}/items/13`, `GET /apps/${KEY}/items/14`, `PUT /apps/${KEY}`]);
    const out = h.out();
    for (const line of [
      `Applying siren.app.json changes ${KEY} on ${SANDBOX_BASE_URL}, a change made in the dashboard included:`,
      '  name: Acme from the dashboard becomes Acme',
      '  description changes',
      '  moves the address to a new url, keeping its signing secret',
      '  events: removes sale.created',
      '  key scopes: removes event:sale',
      '  changes feature postConversionAction notify-crm: name',
      '  brings back the archived feature payoutMethod acme-ledger',
      '  removes feature postConversionAction added-in-dashboard: 2 records select it, so Siren archives it and never calls it',
      '  removes feature postConversionAction unused: nothing selects it, so Siren deletes it',
    ]) {
      expect(out, line).toContain(`${line}\n`);
    }
    expect(h.printed()).not.toContain('elsewhere.example');
    expect(h.printed()).not.toContain(URL_ENV.SIREN_APP_URL);
    expect(h.prompts).toEqual(['Apply these changes? The last write wins, so this replaces anything changed in the dashboard since. Type yes to apply: ']);
  });

  it('sends nothing when the person does not type yes, or when no terminal can ask and --yes is missing', async () => {
    const asked = harness([reply(200, appRecord({ name: 'Old' }))], { env: URL_ENV, interactive: true, typed: ['no'] });
    asked.signedIn();
    asked.write('siren.app.json', exampleFile);
    expect(await asked.run(['apps', 'apply'])).toBe(1);
    expect(asked.paths()).toEqual([`GET /apps/${KEY}`]);
    expect(asked.err()).toContain('Nothing was sent.');

    const script = harness([reply(200, appRecord({ name: 'Old' }))], { env: URL_ENV });
    script.signedIn();
    script.write('siren.app.json', exampleFile);
    expect(await script.run(['apps', 'apply'])).toBe(1);
    expect(script.paths()).toEqual([`GET /apps/${KEY}`]);
    expect(script.prompts).toEqual([]);
    expect(script.err()).toContain('Nothing was sent. Run siren apps apply --yes to apply it without asking.');
  });

  it('lists what a new app gets, and --yes skips the question', async () => {
    const h = harness([missing(), reply(201, { ...appRecord(), rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: URL_ENV, interactive: true });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.out()).toContain(
      `${KEY} is new on ${SANDBOX_BASE_URL}. Applying siren.app.json:\n` +
        '  makes the app with a key, an address and 2 features\n' +
        '  adds feature postConversionAction notify-crm (Tell the CRM)\n' +
        '  adds feature payoutMethod acme-ledger (Acme ledger)\n',
    );
    expect(h.paths()).toEqual([`GET /apps/${KEY}`, `PUT /apps/${KEY}`]);
  });
});
