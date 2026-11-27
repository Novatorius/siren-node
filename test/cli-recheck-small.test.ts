import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * The pass 3 re-check's small should-fixes, 7, 8, 9, 11, 12 and 13
 * (review/cli-dx/pass-3-recheck.md in the run folder).
 */

const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const tty = (h: ReturnType<typeof harness>) => ({ ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });
const appFile = JSON.stringify({ version: 1, apps: { [APP_KEY]: { name: 'Acme', url: '${SIREN_APP_URL}' } } });

describe('re-check should-fix 7: the short-id rule says what the tool takes', () => {
  it('says the first 4 or more characters will do', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', '590'])).toBe(2);
    expect(h.err()).toContain('Its first 4 or more characters after apr_ will do.');
    expect(h.err()).not.toContain('first 8');
  });
});

describe("re-check should-fix 8: apps show reads the folder's app, and counts arguments in good grammar", () => {
  it("shows siren.app.json's one app when no key is given", async () => {
    const h = harness([reply(200, appRecord())]);
    h.signedIn();
    h.write('siren.app.json', appFile);
    expect(await h.run(['apps', 'show']), h.err()).toBe(0);
    expect(h.paths()).toEqual([`GET /apps/${APP_KEY}`]);
  });

  it('says "1 argument", not "1 arguments", with no app file', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['apps', 'off'])).toBe(2);
    expect(h.err()).toContain('siren apps off takes 1 argument, and got 0.');
  });
});

describe('re-check should-fix 9: a missing environment variable is fixed in .env, not the file', () => {
  it('names the variable and .env in the fix', async () => {
    const h = harness([]);
    h.signedIn();
    h.write('siren.app.json', appFile);
    expect(await runCli(['apps', 'diff'], tty(h))).toBe(1);
    expect(strip(h.err()).trimEnd().split('\n').at(-1)).toBe('› Set SIREN_APP_URL in .env, then run siren apps diff again.');
  });
});

describe('re-check should-fix 11: the browser-login refusal says what the person does', () => {
  it('says once that there is no browser login, then asks for the email and password (review round 1, C1 and C27)', async () => {
    const h = harness([reply(404, { error: { message: 'Not found.', context: [] } })], { interactive: true, typed: [''] });
    expect(await h.run(['login'])).toBe(1);
    expect(h.err()).toContain('has no browser login yet, so siren asks for your email and password.');
    expect(h.err()).not.toContain('browser sign-in');
    expect(h.prompts).toContain('Email: ');
  });
});

describe('re-check should-fix 12: apps off keeps the command out of the headline', () => {
  it('prints a short ✓ headline and the command on a › tip', async () => {
    const h = harness([reply(200, appRecord({ status: 'inactive' }))]);
    h.signedIn();
    expect(await runCli(['apps', 'off', APP_KEY], tty(h))).toBe(0);
    expect(strip(h.out())).toBe(`✓ ${APP_KEY} is off. Siren sends it nothing.\n› siren apps on ${APP_KEY} turns it back on.\n`);
  });
});

describe('re-check should-fix 13: a wrong delete answer points to asking again, not --yes', () => {
  it('names the same command without --yes', async () => {
    const h = harness([], { interactive: true, typed: ['nope'] });
    h.signedIn();
    expect(await h.run(['apps', 'delete', APP_KEY])).toBe(1);
    expect(h.err()).toContain(`Run siren apps delete ${APP_KEY} to be asked again.`);
    expect(h.err()).not.toContain('--yes');
  });
});
