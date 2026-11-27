import { describe, expect, it } from 'vitest';
import { parseAppFile } from '../src/cli/app-file';
import { COMMANDS, COMMAND_SPECS } from '../src/cli/run';
import { LIVE_WRITES, commandLine } from '../src/cli/targets';
import { AuthAnswers, EMAIL, PASSWORD, harness, session } from './cli-fakes';
import { APP_KEY, AppAnswers, appRecord } from './apps-siren-answers';
import { capturedReply } from './cloud-captures';
import { reply } from './http-fakes';

/*
 * CLI pass 2, smaller findings 7 to 11 (review/cli-dx/pass-2-review.md in
 * the run folder).
 */

const KEY = APP_KEY;
const UAT = 'https://uat.example.com/siren/v1';
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const fileWith = (app: Record<string, unknown>) => JSON.stringify({ version: 1, apps: { [KEY]: { name: 'Acme', description: "Siren's example app.", ...app } } });
const features = {
  'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' },
  'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['USD'], answerWindowMinutes: 1 },
};

describe('finding 7: an unknown kind gets the nearest kind, not all fourteen', () => {
  it('suggests the kind a cut-off name starts', () => {
    const { problems } = parseAppFile(fileWith({ url: 'https://acme.example', features: { note: { kind: 'postAllocation', name: 'Note' } } }), {});
    expect(problems.map((problem) => problem.message)).toEqual([
      `apps.${KEY}.features.note.kind postAllocation is not a kind. Did you mean postAllocationAction, a Post-allocation action?`,
    ]);
  });

  it('suggests the nearest kind for a typo', () => {
    const { problems } = parseAppFile(fileWith({ url: 'https://acme.example', features: { pay: { kind: 'payotMethod', name: 'Pay', currencies: ['USD'] } } }), {});
    expect(problems[0]!.message).toContain('Did you mean payoutMethod, a Payout method?');
  });

  it('names where the kinds are listed when nothing is close', () => {
    const { problems } = parseAppFile(fileWith({ url: 'https://acme.example', features: { x: { kind: 'zzz', name: 'X' } } }), {});
    expect(problems[0]!.message).toBe(`apps.${KEY}.features.x.kind zzz is not a kind. The schema lists every kind, and an editor completes them.`);
  });
});

describe('finding 8: --live only on a command that changes a live organization', () => {
  it('names every command that is no read and works online, and logout needs none', () => {
    for (const command of COMMANDS) {
      const spec = COMMAND_SPECS[command];
      const changes = spec.readsOnly !== true && spec.offline !== true && command !== 'logout';
      expect(LIVE_WRITES.includes(command as never), command).toBe(changes);
    }
  });

  it('adds --live to a hint for a record write on a live organization (review of PR 94)', () => {
    expect(commandLine({ addressFlag: '', live: true }, 'programs delete 4')).toBe('siren programs delete 4 --live');
    expect(commandLine({ addressFlag: '', live: true }, 'conversions bulk approve --stdin --yes')).toBe('siren conversions bulk approve --stdin --yes --live');
    expect(commandLine({ addressFlag: '', live: true }, 'collaborator-groups add 5 --stdin --yes')).toBe('siren collaborator-groups add 5 --stdin --yes --live');
  });

  it('shows an unset url variable on a live Siren before asking anyone to sign in (review of PR 94)', async () => {
    const h = harness([], { edition: 'production' });
    h.write('siren.app.json', fileWith({ url: '${SIREN_APP_URL}', features }));
    expect(await h.run(['apps', 'apply', '--base-url', UAT, '--live'])).toBe(1);
    expect(h.err()).toContain('needs the environment variable SIREN_APP_URL');
    expect(h.err()).not.toMatch(/sign in|siren login/i);
  });

  it('says siren apps init, with no --live, when a live apply finds no file', async () => {
    const h = harness([AuthAnswers.oneOrg()], { edition: 'production', stdin: PASSWORD });
    expect(await h.run(['login', '--base-url', UAT, '--live', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(await h.run(['apps', 'apply', '--live'])).toBe(1);
    expect(h.err()).toContain('Run siren apps init to write siren.app.json.');
  });

  it('keeps --live on a hint to a write, and leaves it off a hint to a read', async () => {
    const off = appRecord({ status: 'inactive' });
    const h = harness([AuthAnswers.oneOrg(), reply(200, appRecord({ needsAttention: 2 })), reply(200, off)], { edition: 'production', stdin: PASSWORD, env: URL_ENV });
    expect(await h.run(['login', '--base-url', UAT, '--live', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(await h.run(['apps', 'show', KEY]), h.err()).toBe(0);
    expect(h.out()).toContain(`siren apps requests --app ${KEY} --attention lists the 2`);

    h.write('siren.app.json', fileWith({ url: '${SIREN_APP_URL}', features }));
    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
    expect(h.out()).toContain(`until siren apps on ${KEY} --live.`);
  });
});

describe('finding 9: no app:id note on every apply', () => {
  it('prints each feature\'s app:id in its row, and no sentence about what stores it', async () => {
    const h = harness([capturedReply('apps-retrieve-404'), AppAnswers.scopes(), reply(201, { ...appRecord(), rawKey: `sk_test_${'0a'.repeat(32)}`, signingSecret: 'ef'.repeat(32) })], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', fileWith({ url: '${SIREN_APP_URL}', scopes: ['event:sale'], features }));
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain('app:11');
    expect(h.out()).not.toMatch(/autofulfiller|stores/);
  });
});

describe('finding 10: the plan says when the app is off', () => {
  it('diff: says the app is off and names the command that turns it on, after the changes', async () => {
    const h = harness([reply(200, appRecord({ status: 'inactive' }))], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', fileWith({ name: 'Acme payouts', url: '${SIREN_APP_URL}', features }));
    expect(await h.run(['apps', 'diff'])).toBe(3);
    expect(h.out()).toContain(`${KEY} is off, so Siren sends it nothing until siren apps on ${KEY}.`);
  });

  it('diff: says so when the file matches, and --json carries it', async () => {
    const h = harness([reply(200, appRecord({ status: 'inactive' })), reply(200, appRecord({ status: 'inactive' }))], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', fileWith({ url: '${SIREN_APP_URL}', features }));
    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
    expect(h.out()).toContain(`${KEY} is off, so Siren sends it nothing until siren apps on ${KEY}.`);
    const before = h.out().length;
    expect(await h.run(['apps', 'diff', '--json'])).toBe(0);
    expect(JSON.parse(h.out().slice(before))).toMatchObject({ matches: true, on: false });
  });

  it('says nothing about it when the app is on', async () => {
    const h = harness([reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', fileWith({ url: '${SIREN_APP_URL}', features }));
    expect(await h.run(['apps', 'diff']), h.err()).toBe(0);
    expect(h.out()).not.toContain('is off');
  });
});

describe('finding 11: a file error names its place once', () => {
  it('prints no path before a message that already starts with its app', async () => {
    // On a live organization: a sandbox may leave the url unset for siren listen (the developer tools).
    const h = harness([], { edition: 'production' });
    h.signedIn({ [UAT]: session({ edition: 'production', baseUrl: UAT }) });
    h.write('siren.app.json', fileWith({ features: { note: { kind: 'postConversionAction', name: 'Note' } } }));
    expect(await h.run(['apps', 'apply', '--base-url', UAT, '--live'])).toBe(1);
    const line = h.err().split('\n').find((text) => text.includes('has features and no url'))!;
    expect(line).toMatch(new RegExp(`^siren\\.app\\.json:\\d+:\\d+: apps\\.${KEY} has features and no url\\.`));
  });
});
