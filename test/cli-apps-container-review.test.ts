import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthenticationError, UnexpectedResponseError } from '../src/errors';
import { SANDBOX_BASE_URL } from '../src/http';
import { Siren } from '../src/client';
import { FakeHttpClient, reply } from './http-fakes';
import { harness, session } from './cli-fakes';
import { APP_KEY, PartAnswers, appRecord, payoutKind } from './apps-siren-answers';
import { kindLabel } from '../src/cli/app-kinds';
import { parseAppFile } from '../src/cli/app-file';
import { capturedReply } from './cloud-captures';

/*
 * Slice C6, the review's fixes (review/apps-sdk-container-review.md in the
 * run folder). Contract: docs/architecture/apps-sdk-container.md. The
 * answers are Siren's, from test/apps-siren-answers.ts.
 */

const KEY = APP_KEY;
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };

function exampleFile(scopes: string[] = []): string {
  return JSON.stringify({
    version: 1,
    name: 'Acme payouts',
    description: 'Example.',
    apps: {
      [KEY]: {
        name: 'Acme',
        description: "Siren's example app.",
        url: '${SIREN_APP_URL}',
        scopes,
        events: [],
        items: {
          'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' },
          'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['usd'], answerWindowMinutes: 1 },
        },
      },
    },
  });
}

/** An app made in the dashboard as an address only: Siren holds no key for it. */
const noKey = appRecord({ apiKey: null, apiKeyPrefix: null, scopes: [] });

describe('apps-sdk-container review fix 1: the command for a missing key fits the app', () => {
  it('apply names add-key, never rotate-key, when the app holds no key and this machine has none', async () => {
    for (const scopes of [[], ['records:programs:read']]) {
      const h = harness([reply(200, { ...noKey, name: 'Old' }), reply(200, noKey)], { env: URL_ENV });
      h.signedIn();
      h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
      h.write('siren.app.json', exampleFile(scopes));
      expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
      expect(h.out()).toContain(
        `${KEY} holds no key, so ${join(h.cwd, '.env.sandbox')} has none. Run siren apps add-key ${KEY} to make one and save it there.`,
      );
      expect(h.printed(), String(scopes)).not.toContain('rotate-key');
    }
  });

  it('apply names rotate-key, never add-key, when the app holds a key this machine lacks', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    h.write('siren.app.json', exampleFile());
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain(`Run siren apps rotate-key ${KEY} to make a new key and save it there.`);
    expect(h.printed()).not.toContain('add-key');
  });

  function keyed(replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) {
    const h = harness(replies, options);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [KEY]: join(h.cwd, '.env.sandbox') } }) });
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    return h;
  }

  it('rotate-key on an app with no key names add-key, and leaves the env file alone', async () => {
    const h = keyed([PartAnswers.keyMissing()]);
    expect(await h.run(['apps', 'rotate-key', KEY, '--yes'])).toBe(1);
    expect(h.paths()).toEqual([`POST /apps/${KEY}/key/rotate`]);
    expect(h.err()).toBe(`siren: ${KEY} holds no key to rotate, so nothing changed. Run siren apps add-key ${KEY} to make one.\n`);
    expect(h.file('.env.sandbox')).toBe(`SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
  });

  it('add-key on an app that holds a key names rotate-key', async () => {
    const h = keyed([PartAnswers.keyExists()]);
    expect(await h.run(['apps', 'add-key', KEY])).toBe(1);
    expect(h.err()).toBe(
      `siren: ${KEY} already holds a key, so nothing changed. Run siren apps rotate-key ${KEY} for a new one, which revokes the old one at once.\n`,
    );
  });

  it('rotate-secret on an app with no address says it has no secret, and names apply with a url', async () => {
    const h = keyed([PartAnswers.addressMissing()]);
    expect(await h.run(['apps', 'rotate-secret', KEY, '--yes'])).toBe(1);
    expect(h.err()).toBe(
      `siren: ${KEY} has no address, so it has no signing secret to rotate. Give it a url in its app file, then run siren apps apply.\n`,
    );
  });

  it('the 401 hint on the answer route names add-key for an app that holds no key, and rotate-key for a lost one', async () => {
    const siren = new Siren({
      apiKey: 'made-up-key',
      baseUrl: SANDBOX_BASE_URL,
      httpClient: new FakeHttpClient([capturedReply('apps-answer-401-unknown-key')]),
      maxRetries: 0,
    });
    const error = await siren.apps.requests.answer('apr_e221f712e2dd08c2daa566d3ac5ce340', { outcome: 'paid' }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toContain('When that key is lost, run siren apps rotate-key <app key> to make a new one.');
    expect((error as Error).message).toContain('When the app holds no key, as after its key was revoked, run siren apps add-key <app key>.');
  });
});

describe('apps-sdk-container review fix 2: apply says what will change, and claims no dashboard change', () => {
  it('a change made only in the file prints a header that names no dashboard change', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', exampleFile());
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain(`Applying siren.app.json changes ${KEY} on ${SANDBOX_BASE_URL}:\n  name: Old becomes Acme\n`);
    expect(h.out()).not.toContain('made in the dashboard');
  });
});

describe('apps-sdk-container review fix 3: a name the env file holds twice', () => {
  const OLD_KEY = `sk_test_${'2c'.repeat(32)}`;
  const twice = `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nPORT=8787\nSIREN_API_KEY=${OLD_KEY}\n`;

  it('rotate-key, rotate-secret and add-key refuse before sending, name the lines, and leave the file and the key as they are', async () => {
    for (const command of ['rotate-key', 'rotate-secret', 'add-key']) {
      const h = harness([reply(200, { ...appRecord(), rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })]);
      h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [KEY]: join(h.cwd, '.env.sandbox') } }) });
      h.write('.env.sandbox', twice);
      expect(await h.run(['apps', command, KEY, ...(command === 'add-key' ? [] : ['--yes'])]), command).toBe(1);
      expect(h.http.requests, command).toHaveLength(0);
      expect(h.file('.env.sandbox')).toBe(twice);
      expect(h.err(), command).toContain(
        `${join(h.cwd, '.env.sandbox')} holds SIREN_API_KEY on lines 2 and 4, and a program that reads it takes only one of them. Keep the line you use, delete the other, then run the command again.`,
      );
      expect(h.printed()).not.toContain(RAW_KEY);
      expect(h.printed()).not.toContain(OLD_KEY);
    }
  });

  it('apply refuses before it reads the app', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('.env.sandbox', twice);
    h.write('siren.app.json', exampleFile());
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('holds SIREN_API_KEY on lines 2 and 4');
    expect(h.err()).toContain('Nothing was sent.');
  });
});

/**
 * Each kind's readable name as Siren's catalog gives it, `name` in
 * AppItemKindCatalog::entries() (lib/Apps/Core/Enums/AppItemKindCatalog.php
 * lines 189, 199, 209 and 228 on Siren's feat/apps at c8dbb1ab3), and the
 * two metric kinds' names from slice C16-1's catalog entries, the
 * incentive resolver's name from slice C16-2's catalog entry, the two
 * engagement kinds' names from slice C16-4's, the program group
 * structure's from slice C16-5's, the incentive type's from slice
 * C16-6's, the transaction filter's from slice C16-3's, and the
 * collaborator group structure's from slice C16-7's.
 */
const SIREN_KIND_NAMES = {
  postConversionAction: 'Action after a conversion',
  postAllocationAction: 'Action after an allocation',
  payoutMethod: 'Payout method',
  distributionResolver: 'Distribution resolver',
  metricCalculation: 'Metric calculation',
  metricFilter: 'Customer filter for distributors',
  incentiveResolver: 'Incentive resolver',
  incentiveType: 'Incentive structure',
  engagementCalculation: 'Engagement calculation',
  engagementFilter: 'Customer filter for programs',
  programGroupSorter: 'Program group structure',
  transactionFilter: 'Transaction filter',
  collaboratorGroupStructure: 'Collaborator group structure',
};

/*
 * Each kind's readable name as Siren's dashboard and kinds catalog give it
 * now: `name` in AppItemKindCatalog::entries() and APP_KINDS in
 * frontend/src/platform/saas/apps/apps.ts, on Siren's feat/apps at
 * 6d2abd936a. Three of them differ from the tool's own copy above, which
 * the README follows the dashboard in.
 */
const DASHBOARD_KIND_NAMES = {
  ...SIREN_KIND_NAMES,
  postConversionAction: 'Post-conversion action',
  postAllocationAction: 'Post-allocation action',
  incentiveResolver: 'Attribution model',
};

describe('apps-sdk-container review fix 4: a kind shows its readable name beside its technical one', () => {
  it("labels each kind with Siren's catalog name, and a kind the catalog lacks with its term alone", () => {
    for (const [kind, name] of Object.entries(SIREN_KIND_NAMES)) expect(kindLabel(kind)).toBe(`${name} (${kind})`);
    expect(kindLabel('payoutMethod')).toBe(`${payoutKind().name} (payoutMethod)`);
    expect(kindLabel('futureKind')).toBe('futureKind');
  });

  it('show, list and apply print the readable name beside the kind', async () => {
    const h = harness([reply(200, appRecord()), reply(200, [appRecord()]), reply(200, appRecord({ name: 'Old', items: [appRecord().items[0]] })), reply(200, appRecord())], {
      env: URL_ENV,
    });
    h.signedIn();
    h.write('siren.app.json', exampleFile());
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    const out = h.out();
    expect(out).toContain('  app:11  Action after a conversion (postConversionAction)  notify-crm  Tell the CRM\n');
    expect(out).toContain('  app:12  Payout method (payoutMethod)  acme-ledger  Acme ledger\n');
    expect(out).toContain('  adds feature acme-ledger, Payout method (payoutMethod), named Acme ledger\n');
  });

  it("the app file's kind messages name each kind readably beside the word the file takes", () => {
    const file = (item: Record<string, unknown>) =>
      JSON.stringify({ version: 1, name: 'A', description: '', apps: { [KEY]: { name: 'A', url: 'https://acme.example', items: { pay: item } } } });
    expect(parseAppFile(file({ kind: 'other', name: 'Pay' }), {}).problems[0]?.message).toBe(
      `apps.${KEY}.items.pay.kind must be one of Action after a conversion (postConversionAction), Action after an allocation (postAllocationAction), ` +
        'Payout method (payoutMethod), Distribution resolver (distributionResolver), Custom event (customEvent), ' +
        'Metric calculation (metricCalculation), Customer filter for distributors (metricFilter), Incentive resolver (incentiveResolver), ' +
        'Incentive structure (incentiveType), Engagement calculation (engagementCalculation), Customer filter for programs (engagementFilter), Program group structure (programGroupSorter), ' +
        'Transaction filter (transactionFilter), Collaborator group structure (collaboratorGroupStructure).',
    );
    expect(parseAppFile(file({ kind: 'payoutMethod', name: 'Pay' }), {}).problems[0]?.message).toBe(
      `apps.${KEY}.items.pay.currencies is required for a Payout method (payoutMethod): a list of the currency codes it pays.`,
    );
  });

  it("the README's feature table and headings name each kind as the dashboard does, beside its term", () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const [kind, name] of Object.entries(DASHBOARD_KIND_NAMES)) {
      expect(readme, kind).toContain(`| ${name} (\`${kind}\`) |`);
      const level = kind === 'payoutMethod' ? '##' : '###';
      expect(readme, kind).toContain(`\n${level} ${name} (\`${kind}\`)\n`);
    }
    expect(readme).toContain('The Payout method kind is `payoutMethod`');
  });
});

describe('apps-sdk-container review fix 5: scopes compared the way Siren stores them', () => {
  /** The key as Siren stores a list with `*`: `*` first, then the record scopes beside it (ApiKeyService::normalizeScopes()). */
  const stored = (scopes: string[]) => appRecord({ apiKey: { ...appRecord().apiKey, scopes } });

  it('a file with * beside event scopes, record scopes and a repeat matches what Siren stored, and writes nothing', async () => {
    const cases: Array<[string[], string[]]> = [
      [['*', 'event:*'], ['*']],
      [['event:sale', '*', 'records:programs:read', 'event:*'], ['*', 'records:programs:read']],
      [['records:programs:read', 'records:programs:read'], ['records:programs:read']],
    ];
    for (const [file, held] of cases) {
      const h = harness([reply(200, stored(held))], { env: URL_ENV });
      h.signedIn();
      h.write('siren.app.json', exampleFile(file));
      expect(await h.run(['apps', 'apply']), `${file.join(',')}: ${h.err()}`).toBe(0);
      expect(h.paths(), file.join(',')).toEqual([`GET /apps/${KEY}`]);
      expect(h.out(), file.join(',')).toBe(`${KEY} on ${SANDBOX_BASE_URL} already matches siren.app.json, so nothing was sent.\n`);
    }
  });

  it('still prints a real scope change, in the stored form', async () => {
    const h = harness([reply(200, stored(['*'])), reply(200, stored(['*', 'records:programs:read']))], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', exampleFile(['event:sale', '*', 'records:programs:read']));
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain('  key scopes: adds records:programs:read\n');
    expect(h.out()).not.toContain('event:sale');
  });
});

describe('apps-sdk-container review fix 6: small command-line edges', () => {
  it('siren apps rotate with no key prints the same split explanation, and sends nothing', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['apps', 'rotate'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain(
      `Rotating is now two commands, since an app's key and its signing secret change apart. Nothing was sent. ` +
        'Run siren apps rotate-key <key> for a new key, or siren apps rotate-secret <key> for a new signing secret.',
    );
  });

  it("each reserved word gets the tool's own refusal, never one that names an SDK method", async () => {
    for (const word of ['requests', 'events', 'scopes', 'kinds']) {
      for (const command of ['show', 'on', 'rotate-key']) {
        const h = harness([reply(200, appRecord())]);
        h.signedIn();
        expect(await h.run(['apps', command, word, ...(command === 'rotate-key' ? ['--yes'] : [])]), `${command} ${word}`).toBe(2);
        expect(h.http.requests, `${command} ${word}`).toHaveLength(0);
        expect(h.err()).toContain('never requests, events, scopes or kinds');
        expect(h.err()).not.toContain('apps.');
      }
      const init = harness([]);
      expect(await init.run(['apps', 'init', '--key', word]), `init ${word}`).toBe(2);
      expect(() => init.file('siren.app.json')).toThrow();
    }
  });
});

describe('apps-sdk-container review fix 8: a malformed answer never carries a secret in error.data', () => {
  function client(body: unknown, status = 200) {
    return new Siren({ accessToken: 't', baseUrl: SANDBOX_BASE_URL, httpClient: new FakeHttpClient([reply(status, body)]), maxRetries: 0 });
  }

  it('drops rawKey and signingSecret from the body it keeps, and keeps the rest', async () => {
    const malformed = { key: KEY, name: 'Acme', rawKey: RAW_KEY, signingSecret: SIGNING_SECRET };
    const calls: Array<[string, (siren: Siren) => Promise<unknown>, number]> = [
      ['rotateKey', (siren) => siren.apps.rotateKey(KEY), 200],
      ['rotateSecret', (siren) => siren.apps.rotateSecret(KEY), 200],
      ['createKey', (siren) => siren.apps.createKey(KEY), 201],
      ['declare', (siren) => siren.apps.declare(KEY, { name: 'Acme' }), 201],
      ['create', (siren) => siren.apps.create({ name: 'Acme' }), 201],
    ];
    for (const [name, call, status] of calls) {
      const error = await call(client(malformed, status)).then(() => undefined, (caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(UnexpectedResponseError);
      const data = (error as UnexpectedResponseError).data as Record<string, unknown>;
      expect(data, name).toEqual({ key: KEY, name: 'Acme' });
      expect(JSON.stringify(data), name).not.toContain(RAW_KEY);
      expect(JSON.stringify(data), name).not.toContain(SIGNING_SECRET);
    }
  });

  it('drops them too when the secret itself is the malformed part', async () => {
    const error = await client({ ...appRecord(), rawKey: 42, signingSecret: SIGNING_SECRET })
      .apps.rotateKey(KEY)
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toContain('without rawKey as text');
    expect((error as UnexpectedResponseError).data).not.toHaveProperty('rawKey');
    expect((error as UnexpectedResponseError).data).not.toHaveProperty('signingSecret');
  });
});
