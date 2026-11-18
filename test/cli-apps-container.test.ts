import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { harness, session } from './cli-fakes';
import { APP_KEY, AppAnswers, PartAnswers, PlanFields, appRecord, itemPage } from './apps-siren-answers';
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

  it('prints each difference, a feature the file lacks included, then asks and writes on yes', async () => {
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
      `Applying siren.app.json changes ${KEY} on ${SANDBOX_BASE_URL}:`,
      '  name: Acme from the dashboard becomes Acme',
      '  description changes',
      '  moves the address to a new url, keeping its signing secret',
      '  events: removes sale.created',
      '  key scopes: removes event:sale',
      '  changes feature notify-crm, Action after a conversion (postConversionAction): name',
      '  brings back the archived feature acme-ledger, Payout method (payoutMethod)',
      '  removes feature added-in-dashboard, Action after a conversion (postConversionAction): 2 records select it, so Siren archives it and never calls it',
      '  removes feature unused, Action after a conversion (postConversionAction): nothing selects it, so Siren deletes it',
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
        '  adds feature notify-crm, Action after a conversion (postConversionAction), named Tell the CRM\n' +
        '  adds feature acme-ledger, Payout method (payoutMethod), named Acme ledger\n',
    );
    expect(h.paths()).toEqual([`GET /apps/${KEY}`, `PUT /apps/${KEY}`]);
  });
});

describe('apps-sdk-container item 5: siren apps rotate splits in two', () => {
  const OLD = `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`;
  const NEW_KEY = `sk_test_${'1b'.repeat(32)}`;
  const NEW_SECRET = '9c'.repeat(32);

  function rotating(replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) {
    const h = harness(replies, options);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [KEY]: join(h.cwd, '.env.sandbox') } }) });
    h.write('.env.sandbox', OLD);
    return h;
  }

  it('rotate-key asks first, then writes only the new key, mode 0600', async () => {
    const h = rotating([reply(200, { ...appRecord(), rawKey: NEW_KEY })], { interactive: true, typed: ['yes'] });
    expect(await h.run(['apps', 'rotate-key', KEY]), h.err()).toBe(0);
    expect(h.prompts).toEqual([`Rotating ${KEY}'s key revokes the old key at once, so anything still using it stops working. Type yes to rotate it: `]);
    expect(h.paths()).toEqual([`POST /apps/${KEY}/key/rotate`]);
    expect(h.file('.env.sandbox')).toBe(OLD.replace(RAW_KEY, NEW_KEY));
    if (process.platform !== 'win32') expect(h.modeOf(join(h.cwd, '.env.sandbox'))).toBe(0o600);
    expect(h.out()).toContain('Siren revoked the old key. Restart your app so it reads the new key.');
    expect(h.printed()).not.toContain(NEW_KEY);
  });

  it('rotate-secret asks first, then writes only the new signing secret', async () => {
    const h = rotating([reply(200, { ...appRecord(), signingSecret: NEW_SECRET })], { interactive: true, typed: ['y'] });
    expect(await h.run(['apps', 'rotate-secret', KEY]), h.err()).toBe(0);
    expect(h.prompts[0]).toBe(
      `Rotating ${KEY}'s signing secret makes Siren sign with the new one at once, so the app refuses requests until it reads the new one. Type yes to rotate it: `,
    );
    expect(h.paths()).toEqual([`POST /apps/${KEY}/secret/rotate`]);
    expect(h.file('.env.sandbox')).toBe(OLD.replace(SIGNING_SECRET, NEW_SECRET));
    expect(h.out()).toContain(`Its new signing secret is in ${join(h.cwd, '.env.sandbox')}.`);
    expect(h.printed()).not.toContain(NEW_SECRET);
  });

  it('each sends nothing when the person declines, or with no terminal and no --yes', async () => {
    for (const command of ['rotate-key', 'rotate-secret']) {
      const declined = rotating([reply(200, appRecord())], { interactive: true, typed: ['no'] });
      expect(await declined.run(['apps', command, KEY]), command).toBe(1);
      expect(declined.http.requests).toHaveLength(0);
      expect(declined.file('.env.sandbox')).toBe(OLD);

      const script = rotating([reply(200, appRecord())]);
      expect(await script.run(['apps', command, KEY]), command).toBe(1);
      expect(script.http.requests).toHaveLength(0);
      expect(script.err()).toContain(`Run siren apps ${command} ${KEY} --yes to rotate it.`);
    }
  });

  it('siren apps rotate explains the split, sends nothing and exits non-zero', async () => {
    const h = rotating([reply(200, { ...appRecord(), rawKey: NEW_KEY, signingSecret: NEW_SECRET })]);
    expect(await h.run(['apps', 'rotate', KEY])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.editionReads).toHaveLength(0);
    expect(h.file('.env.sandbox')).toBe(OLD);
    expect(h.err()).toContain(
      `Rotating is now two commands, since an app's key and its signing secret change apart. Nothing was sent. ` +
        `Run siren apps rotate-key ${KEY} for a new key, or siren apps rotate-secret ${KEY} for a new signing secret.`,
    );
  });
});

describe('apps-sdk-container item 6: plans in the output', () => {
  /** The app as Siren answers it on Plus (AppsOutIsProFlowTest everyPlan()): the outward feature and the events need Pro. */
  const onPlus = appRecord({
    events: ['obligation.approved'],
    address: { ...appRecord().address, events: ['obligation.approved'] },
    items: [
      { ...appRecord().items[0], ...PlanFields.needsPro() },
      { ...appRecord().items[1], kind: 'distributionResolver', key: 'acme-split', name: 'Acme split', settings: {} },
    ],
    eventsAccess: PlanFields.needsPro(),
  });

  it('show and list print requires Pro beside a feature and the events the plan cannot use, and nothing beside one it can', async () => {
    const h = harness([reply(200, onPlus), reply(200, [onPlus])]);
    h.signedIn();
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    const lines = h.out().split('\n');
    for (const line of [
      '  app:11  Action after a conversion (postConversionAction)  notify-crm  Tell the CRM  requires Pro',
      '  app:12  Distribution resolver (distributionResolver)  acme-split  Acme split',
      '  events  obligation.approved  requires Pro, so Siren does not send them',
    ]) {
      expect(lines.filter((printed) => printed === line), line).toHaveLength(2);
    }
  });

  it('names the plan Siren names, says only that the plan cannot use it when Siren names none, and never guesses', async () => {
    const app = appRecord({
      items: [
        { ...appRecord().items[0], entitled: false, requiredCapability: 'outbound-apps', requiredPlan: 'enterprise' },
        { ...appRecord().items[1], entitled: false, requiredCapability: null, requiredPlan: null },
      ],
    });
    const older = appRecord({ items: appRecord().items.map(({ entitled: _e, requiredCapability: _c, requiredPlan: _p, ...item }) => item) });
    const h = harness([reply(200, app), reply(200, older)]);
    h.signedIn();
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    expect(h.out()).toContain('  app:11  Action after a conversion (postConversionAction)  notify-crm  Tell the CRM  requires Enterprise\n');
    expect(h.out()).toContain('  app:12  Payout method (payoutMethod)  acme-ledger  Acme ledger  your plan cannot use it\n');
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    expect(h.out().split('\n').slice(-3, -1)).toEqual(['  app:11  Action after a conversion (postConversionAction)  notify-crm  Tell the CRM', '  app:12  Payout method (payoutMethod)  acme-ledger  Acme ledger']);
    expect(h.out()).not.toMatch(/requires Pro/);
  });

  it('apply prints the marks on the app it declared', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, onPlus)], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain('  app:11  Action after a conversion (postConversionAction)  notify-crm  Tell the CRM  requires Pro\n');
    expect(h.out()).toContain('  events  obligation.approved  requires Pro, so Siren does not send them\n');
  });

  it('apply warns when the file names scopes and the app holds no key, and names the command that makes one', async () => {
    const noKey = appRecord({ apiKey: null, apiKeyPrefix: null, scopes: [] });
    const h = harness([reply(200, noKey), reply(200, noKey)], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', exampleFile.replace('"scopes":[]', '"scopes":["records:programs:read"]'));
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.err()).toContain(
      `siren: siren.app.json names scopes, and ${KEY} holds no key, so they reach nothing. Make one with siren apps add-key ${KEY}, then run siren apps apply again to give it these scopes.\n`,
    );

    const none = harness([reply(200, noKey), reply(200, noKey)], { env: URL_ENV });
    none.signedIn();
    none.write('siren.app.json', exampleFile);
    await none.run(['apps', 'apply', '--yes']);
    expect(none.err()).not.toContain('add-key');
  });

  it('add-key makes a key once and writes only it to the env file, and Siren refuses one for an app that holds a key', async () => {
    const h = harness([reply(201, { ...appRecord(), rawKey: RAW_KEY }), PartAnswers.keyExists()]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [KEY]: join(h.cwd, '.env.sandbox') } }) });
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    expect(await h.run(['apps', 'add-key', KEY]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`POST /apps/${KEY}/key`]);
    expect(h.file('.env.sandbox')).toBe(`SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\nSIREN_API_KEY=${RAW_KEY}\n`);
    expect(h.out()).toContain('The key holds no scopes yet. Run siren apps apply to give it the scopes your app file names.');
    expect(h.printed()).not.toContain(RAW_KEY);

    expect(await h.run(['apps', 'add-key', KEY])).toBe(1);
    expect(h.err()).toContain('already holds a key');
  });
});

describe('apps-sdk-container item 7: a person reads feature, never item', () => {
  it('the tool says feature in what it prints for apply, show, list and a refused delete', async () => {
    const archived = appRecord({ items: appRecord().items.map((item, at) => (at === 0 ? { ...item, status: 'archived' } : item)) });
    const h = harness(
      [reply(200, appRecord({ name: 'Old' })), reply(200, archived), reply(200, archived), reply(200, [archived]), AppAnswers.inUse(), reply(200, archived)],
      { env: URL_ENV },
    );
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(await h.run(['apps', 'delete', KEY, '--yes'])).toBe(1);
    const printed = h.printed();
    expect(printed).toContain('An archived feature is one siren.app.json no longer names');
    expect(printed).toContain('Records still select its features');
    expect(printed.replace(/app:\d+/g, '')).not.toMatch(/\bitems?\b/i);
  });

  it("the README's apps and command-line sections say feature outside code, but for the line that names the code's word", () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const part = readme.slice(readme.indexOf('## Siren apps'), readme.indexOf('## Other SDKs'));
    const prose = part
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/The code calls a feature an item, so the routes are/, '');
    expect(prose).toMatch(/\bfeatures?\b/);
    expect(prose).not.toMatch(/\bitems?\b/i);
  });
});
