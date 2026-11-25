import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { SANDBOX_BASE_URL } from '../src/http';
import { AuthAnswers, EMAIL, PASSWORD, harness, session } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * CLI pass 3, should-fixes 9, 11, 12 and 14 (review/cli-dx/pass-3-review.md
 * in the run folder).
 */

const ESC = '\u001b[';
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const UAT = 'https://uat.example.com/siren/v1';
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const appFile = JSON.stringify({ version: 1, apps: { [APP_KEY]: { name: 'Acme', url: '${SIREN_APP_URL}' } } });
const tty = (h: ReturnType<typeof harness>) => ({ ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });

describe('should-fix 9: the bare siren screen is styled', () => {
  it('signed in: a ✓ line with the email in bold, and the host with no scheme, live in amber', async () => {
    const h = harness([]);
    h.signedIn({ 'http://127.0.0.1:33917/siren/v1': session({ baseUrl: 'http://127.0.0.1:33917/siren/v1', edition: 'production' }) });
    expect(await runCli(['--base-url', 'http://127.0.0.1:33917/siren/v1'], tty(h))).toBe(0);
    const text = h.out();
    expect(text).toContain(`Logged in as ${ESC}1m${EMAIL}${ESC}0m.`);
    expect(strip(text)).toContain(`✓ Logged in as ${EMAIL}.`);
    expect(strip(text)).toContain('Siren: 127.0.0.1:33917, live.');
    expect(text).not.toContain('http://');
    expect(text).toMatch(/\u001b\[[\d;]*m+live\u001b\[0m/);
  });

  it('signed out: an amber ! before "Not logged in."', async () => {
    const h = harness([]);
    expect(await runCli([], tty(h))).toBe(0);
    expect(strip(h.out())).toContain('! Not logged in. Run siren login to log in.');
  });

  it('keeps the plain words when piped', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run([])).toBe(0);
    expect(h.out()).toContain(`Logged in as ${EMAIL}.`);
    expect(h.out()).not.toContain('✓');
    expect(h.out()).not.toContain(ESC);
  });
});

describe('should-fix 11: tips keep --live on a live Siren', () => {
  it('diff and init name siren apps apply --live after a live login', async () => {
    const h = harness([AuthAnswers.oneOrg(), reply(200, appRecord({ name: 'Old name' }))], { edition: 'production', stdin: PASSWORD, env: URL_ENV });
    expect(await h.run(['login', '--base-url', UAT, '--live', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    h.write('siren.app.json', appFile);
    expect(await h.run(['apps', 'diff'])).toBe(3);
    expect(h.out()).toContain('siren apps apply --live makes these changes.');

    const fresh = harness([AuthAnswers.oneOrg()], { edition: 'production', stdin: PASSWORD });
    expect(await fresh.run(['login', '--base-url', UAT, '--live', '--email', EMAIL, '--password-stdin']), fresh.err()).toBe(0);
    const before = fresh.out().length;
    expect(await fresh.run(['apps', 'init', '--key', 'acme-payouts']), fresh.err()).toBe(0);
    expect(fresh.out().slice(before)).toContain('siren apps apply --live');
  });
});

describe('should-fix 12: the delete question names the organization and fits 80 columns', () => {
  it('warns, then asks for the key with the organization named', async () => {
    const h = harness([reply(200, { success: true })], { interactive: true, typed: [APP_KEY] });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['apps', 'delete', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toContain(`Deleting ${APP_KEY} revokes its key and can't be undone.`);
    expect(h.prompts).toEqual([`Type ${APP_KEY} to delete it from Acme (acme), sandbox: `]);
    for (const line of [...h.out().split('\n'), ...h.prompts]) expect([...line].length, line).toBeLessThanOrEqual(80);
  });
});

describe('should-fix 14: login ends with what to do next', () => {
  it('names siren apps init, or siren apps apply when the folder has siren.app.json', async () => {
    const h = harness([AuthAnswers.oneOrg(), AuthAnswers.oneOrg()], { stdin: PASSWORD });
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(h.out()).toMatch(/\nNext\n {2}1 {2}siren apps init +write siren\.app\.json in this folder\n/);

    h.write('siren.app.json', appFile);
    const before = h.out().length;
    expect(await h.run(['login', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(h.out().slice(before)).toMatch(/\nNext\n {2}1 {2}siren apps apply +declare the app on Siren and save its key\n/);
  });
});
