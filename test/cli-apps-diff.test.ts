import { describe, expect, it } from 'vitest';
import { AuthAnswers, EMAIL, PASSWORD, harness } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { capturedReply } from './cloud-captures';
import { reply } from './http-fakes';

/*
 * CLI pass 2, finding 1 (review/cli-dx/pass-2-review.md in the run
 * folder): a diff and a dry run. `siren apps diff` reads Siren, prints the
 * plan, sends nothing, needs no --live, and exits 0 when the file matches
 * and 3 when apply would change something. It and apply take --json,
 * which prints the plan as data.
 */

const KEY = APP_KEY;
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const file = (name = 'Acme') =>
  JSON.stringify({
    version: 1,
    apps: {
      [KEY]: {
        name,
        description: "Siren's example app.",
        url: '${SIREN_APP_URL}',
        scopes: [],
        events: [],
        features: {
          'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' },
          'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['usd'], answerWindowMinutes: 1 },
        },
      },
    },
  });

describe('siren apps diff', () => {
  it('exits 0 and says so when the file matches, after one read', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file());
    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
    expect(h.out()).toBe(`${KEY} already matches siren.app.json. Nothing to send.\n`);
    expect(h.paths()).toEqual([`GET /apps/${KEY}`]);
  });

  it('prints the plan and exits 3 when apply would change something, and asks nothing and sends nothing', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV, interactive: true, typed: ['y'] });
    h.signedIn();
    h.write('siren.app.json', file('Acme payouts'));
    expect(await h.run(['apps', 'diff']), h.err()).toBe(3);
    expect(h.out()).toContain('Plan  acme-payouts → Acme (3), sandbox');
    expect(h.out()).toContain('  ~ ');
    expect(h.out()).toContain('Acme payouts');
    expect(h.prompts).toEqual([]);
    expect(h.paths()).toEqual([`GET /apps/${KEY}`]);
    expect(h.err()).toBe('');
  });

  it('exits 3 for an app Siren does not have yet', async () => {
    const h = harness([capturedReply('apps-retrieve-404')], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file());
    expect(await h.run(['apps', 'diff']), h.err()).toBe(3);
    expect(h.out()).toContain('  + makes the app');
  });

  it('needs no --live on a live Siren, since it changes nothing', async () => {
    const UAT = 'https://uat.example.com/siren/v1';
    const h = harness([AuthAnswers.oneOrg(), reply(200, appRecord())], { env: URL_ENV, edition: 'production', stdin: PASSWORD });
    expect(await h.run(['login', '--base-url', UAT, '--live', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    h.write('siren.app.json', file('Acme payouts'));
    expect(await h.run(['apps', 'diff']), h.err()).toBe(3);
    expect(h.paths().at(-1)).toBe(`GET /apps/${KEY}`);
    expect(h.http.requests.at(-1)?.url.startsWith(UAT)).toBe(true);
  });

  it('with --json: the plan as data, with each change marked add, remove or change, and the same exit codes', async () => {
    const h = harness([reply(200, appRecord()), reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file('Acme payouts'));
    expect(await h.run(['apps', 'diff', '--json']), h.err()).toBe(3);
    const plan = JSON.parse(h.out()) as { app: string; org: unknown; new: boolean; matches: boolean; changes: Array<{ op: string; text: string }> };
    expect(plan.app).toBe(KEY);
    expect(plan.org).toEqual({ id: 3, name: 'Acme', slug: null });
    expect(plan.new).toBe(false);
    expect(plan.matches).toBe(false);
    expect(plan.changes.length).toBeGreaterThan(0);
    for (const change of plan.changes) expect(['add', 'remove', 'change']).toContain(change.op);
    expect(plan.changes.some((change) => change.text.includes('Acme payouts'))).toBe(true);

    h.write('siren.app.json', file());
    const before = h.out().length;
    expect(await h.run(['apps', 'diff', '--json']), h.err()).toBe(0);
    expect(JSON.parse(h.out().slice(before))).toMatchObject({ app: KEY, matches: true, changes: [] });
  });

  it('refuses an app file with a problem in the usual way, with exit 1', async () => {
    const h = harness([]);
    h.signedIn();
    h.write('siren.app.json', '{ "version": 1, "apps": {} }');
    expect(await h.run(['apps', 'diff'])).toBe(1);
    expect(h.paths()).toEqual([]);
  });
});

describe('siren apps apply --json', () => {
  it('with --yes: prints the plan and the app as data, keeps the key and secret out of it, and writes them to the env file', async () => {
    const h = harness([capturedReply('apps-retrieve-404'), reply(201, { ...appRecord(), rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file());
    expect(await h.run(['apps', 'apply', '--json', '--yes']), h.err()).toBe(0);
    const printed = JSON.parse(h.out()) as { plan: { new: boolean }; applied: boolean; app: Record<string, unknown> };
    expect(printed.applied).toBe(true);
    expect(printed.plan.new).toBe(true);
    expect(printed.app.key).toBe(KEY);
    expect(h.out()).not.toContain(RAW_KEY);
    expect(h.out()).not.toContain(SIGNING_SECRET);
    expect(h.file('.env.sandbox')).toContain(`SIREN_API_KEY=${RAW_KEY}`);
  });

  it('without --yes: prints the plan as data, sends nothing, and exits 1', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file('Acme payouts'));
    expect(await h.run(['apps', 'apply', '--json'])).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ applied: false, plan: { matches: false } });
    expect(h.paths()).toEqual([`GET /apps/${KEY}`]);
  });

  it('with nothing to change: applied false, matches true, exit 0', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file());
    expect(await h.run(['apps', 'apply', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ applied: false, plan: { matches: true, changes: [] } });
  });
});

describe('typos near diff', () => {
  it('suggests apps diff for apps dif, and nothing for a word unlike any command', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'dif'])).toBe(2);
    expect(h.err()).toContain('Did you mean "apps diff"?');
    const far = harness([]);
    expect(await far.run(['apps', 'xyzzy'])).toBe(2);
    expect(far.err()).not.toContain('Did you mean');
  });
});
