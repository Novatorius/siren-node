import { describe, expect, it } from 'vitest';
import { parseAppFile } from '../src/cli/app-file';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, membershipAcme, membershipTwo, session } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { capturedReply } from './cloud-captures';
import { reply } from './http-fakes';

/*
 * CLI pass 2, finding 6 (review/cli-dx/pass-2-review.md in the run
 * folder): no command wrote a file from an app that already exists, so
 * the reviewer wrote siren.app.json by hand from `siren apps show`.
 * `siren apps pull <key>` writes it from the app on Siren, so `siren apps
 * diff` finds nothing to change straight after.
 */

const KEY = APP_KEY;
const URL = 'https://acme.example/siren';
type Written = { $schema?: string; version: number; org?: string; apps: Record<string, Record<string, unknown>> };
const written = (h: ReturnType<typeof harness>, name = 'siren.app.json') => JSON.parse(h.file(name)) as Written;

describe('siren apps pull', () => {
  it('writes siren.app.json from the app on Siren, after one read, and apps diff then finds it matches', async () => {
    const h = harness([reply(200, appRecord()), reply(200, appRecord())]);
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY]), h.err()).toBe(0);
    expect(h.paths()).toEqual([`GET /apps/${KEY}`]);
    const file = written(h);
    expect(file.version).toBe(1);
    expect(file.$schema).toContain('siren.app.schema.json');
    expect(file.org).toBeUndefined();
    expect(file.apps[KEY]).toEqual({
      name: 'Acme',
      description: "Siren's example app.",
      url: URL,
      features: {
        'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' },
        'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['USD'], answerWindowMinutes: 1 },
      },
    });
    expect(parseAppFile(h.file('siren.app.json'), {}).problems).toEqual([]);

    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
    expect(h.out()).toContain('already matches siren.app.json');
  });

  it('prints a ✓ report with the app, its features and the url it wrote, and never the url itself', async () => {
    const h = harness([reply(200, appRecord())]);
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY]), h.err()).toBe(0);
    expect(h.out()).toContain(`Wrote siren.app.json from ${KEY}`);
    expect(h.out()).toMatch(/Features +notify-crm, acme-ledger/);
    expect(h.out()).toMatch(/URL +acme\.example, written in the file/);
    expect(h.out()).not.toContain(URL);
    expect(h.out()).toContain('siren apps diff');
  });

  it('with --url-env writes ${SIREN_APP_URL} for the url, which diff fills from the shell', async () => {
    const h = harness([reply(200, appRecord()), reply(200, appRecord())], { env: { SIREN_APP_URL: URL } });
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY, '--url-env']), h.err()).toBe(0);
    expect(written(h).apps[KEY]!.url).toBe('${SIREN_APP_URL}');
    expect(h.out()).toMatch(/URL +from SIREN_APP_URL/);
    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
  });

  it('writes the key scopes as Siren stores them, the events, the contacts and each kind\'s settings, and leaves out archived features', async () => {
    const app = appRecord({
      description: 'Pays partners.',
      scopes: ['records:programs:read'],
      apiKey: { ...appRecord().apiKey, scopes: ['records:programs:read'] },
      events: ['sale.created'],
      contacts: ['ops@acme.example'],
      features: [
        ...appRecord().features,
        { ...appRecord().features[0], id: 13, ref: 'app:13', key: 'old-notify', name: 'Old', status: 'archived' },
        { ...appRecord().features[0], id: 14, ref: 'app:14', kind: 'metricCalculation', key: 'score', name: 'Score', settings: { scoresMoney: true } },
        { ...appRecord().features[0], id: 15, ref: 'app:15', kind: 'incentiveType', key: 'bonus', name: 'Bonus', settings: { conversionTypes: ['sale', 'lead'] } },
        { ...appRecord().features[0], id: 16, ref: 'app:16', kind: 'customEvent', key: 'signup', name: 'Signup', description: 'A signup.', settings: { fields: { plan: { type: 'string', required: true } }, domains: ['acme.example'] } },
      ],
    });
    const h = harness([reply(200, app), reply(200, app)], { env: { SIREN_APP_URL: URL } });
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY]), h.err()).toBe(0);
    const pulled = written(h).apps[KEY]!;
    expect(pulled).toMatchObject({ description: 'Pays partners.', scopes: ['records:programs:read'], events: ['sale.created'], contacts: ['ops@acme.example'] });
    const features = pulled.features as Record<string, Record<string, unknown>>;
    expect(Object.keys(features)).toEqual(['notify-crm', 'acme-ledger', 'score', 'bonus', 'signup']);
    expect(features.score).toEqual({ kind: 'metricCalculation', name: 'Score', scoresMoney: true });
    expect(features.bonus).toEqual({ kind: 'incentiveType', name: 'Bonus', conversionTypes: ['sale', 'lead'] });
    expect(features.signup).toEqual({ kind: 'customEvent', name: 'Signup', description: 'A signup.', fields: { plan: { type: 'string', required: true } }, domains: ['acme.example'] });
    expect(h.out()).toMatch(/Left out +old-notify, archived/);
    expect(parseAppFile(h.file('siren.app.json'), {}).problems).toEqual([]);
    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
  });

  it('writes no url and no events for an app with no address', async () => {
    const keyOnly = appRecord({ url: null, address: null, events: [], features: [] });
    const h = harness([reply(200, keyOnly)]);
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY]), h.err()).toBe(0);
    expect(written(h).apps[KEY]).toEqual({ name: 'Acme', description: "Siren's example app." });
  });

  it('names the organization in the file for a person in several, so later commands act in the same one', async () => {
    const h = harness([reply(200, appRecord())]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme', memberships: [membershipAcme, membershipTwo] }) });
    expect(await h.run(['apps', 'pull', KEY, '--org', 'acme']), h.err()).toBe(0);
    expect(written(h).org).toBe('acme');
  });

  it('writes to the file named, and keeps the env files apply writes out of git', async () => {
    const h = harness([reply(200, appRecord())]);
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY, 'apps/acme.json']), h.err()).toBe(0);
    expect(written(h, 'apps/acme.json').apps[KEY]!.name).toBe('Acme');
    expect(h.file('.gitignore')).toContain('.env.sandbox');
  });

  it('asks before replacing a file, refuses with no terminal and no --yes, and replaces it with --yes', async () => {
    const quiet = harness([reply(200, appRecord())]);
    quiet.signedIn();
    quiet.write('siren.app.json', '{"keep":true}');
    expect(await quiet.run(['apps', 'pull', KEY])).toBe(1);
    expect(quiet.file('siren.app.json')).toBe('{"keep":true}');
    expect(quiet.err()).toContain('Nothing written');
    expect(quiet.err()).toContain(`siren apps pull ${KEY} --yes`);

    const no = harness([reply(200, appRecord())], { interactive: true, typed: ['n'] });
    no.signedIn();
    no.write('siren.app.json', '{"keep":true}');
    expect(await no.run(['apps', 'pull', KEY])).toBe(1);
    expect(no.prompts).toEqual(['Replace siren.app.json? [y/N] ']);
    expect(no.file('siren.app.json')).toBe('{"keep":true}');

    const yes = harness([reply(200, appRecord())]);
    yes.signedIn();
    yes.write('siren.app.json', '{"keep":true}');
    expect(await yes.run(['apps', 'pull', KEY, '--yes']), yes.err()).toBe(0);
    expect(written(yes).apps[KEY]!.name).toBe('Acme');
  });

  it('with --json prints where it wrote and what, and nothing else', async () => {
    const h = harness([reply(200, appRecord())]);
    h.signedIn();
    expect(await h.run(['apps', 'pull', KEY, '--json']), h.err()).toBe(0);
    const printed = JSON.parse(h.out()) as { path: string; file: Written };
    expect(printed.path).toBe('siren.app.json');
    expect(printed.file).toEqual(written(h));
  });

  it('refuses a key that is no app key before sending, and says when Siren has no such app', async () => {
    const bad = harness([]);
    bad.signedIn();
    expect(await bad.run(['apps', 'pull', 'Not A Key'])).toBe(2);
    expect(bad.sent()).toEqual([]);

    const missing = harness([capturedReply('apps-retrieve-404')]);
    missing.signedIn();
    expect(await missing.run(['apps', 'pull', KEY])).toBe(1);
    expect(() => missing.file('siren.app.json')).toThrow();
  });
});
