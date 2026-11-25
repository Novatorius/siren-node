import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord, requestRow } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * The coordinator's demo against the PR 1188 preview: lines past 80
 * columns in the apply plan, the apps show features table and the request
 * DATA, and `apps show` printing the key twice when the name is the key.
 * In a terminal each line fits 80 columns. The DATA block is indented key
 * and value lines, with the whole JSON under --json.
 */

const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const tty = (h: ReturnType<typeof harness>) => ({ ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color', TZ: 'UTC' } });
const fits = (text: string) => {
  for (const line of strip(text).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
};
const LONG = 'Tell my service about each approved conversion, with its amount and currency';
const DATA = {
  distribution: { id: 41, programId: 7, total: { amount: 2500, currency: 'USD' } },
  metrics: [
    { id: 'metric_0123456789abcdef', collaboratorId: 12, amount: 1500, note: 'A long note about this metric that runs past the edge of an 80 column terminal' },
    { id: 'metric_fedcba9876543210', collaboratorId: 13, amount: 1000 },
  ],
  tags: ['vip', 'spring'],
  memo: null,
};

describe('the request view DATA', () => {
  const detail = () => reply(200, { ...requestRow({ sendCount: 0 }), data: DATA, answer: null, answeredByUser: null });

  it('prints nested data as indented key and value lines, each list item under its number, and fits 80 columns in a terminal', async () => {
    const h = harness([detail(), reply(200, [appRecord()]), reply(200, [])]);
    h.signedIn();
    expect(await runCli(['apps', 'requests', APP_REQUEST_ID], tty(h)), h.err()).toBe(0);
    fits(h.out());
    const text = strip(h.out());
    const data = text.slice(text.indexOf('DATA\n'));
    expect(data).toContain('\n  distribution\n    id         41\n    programId  7\n    total\n      amount    2500\n      currency  USD\n');
    expect(data).toContain('\n  metrics\n    1\n      id' + ' '.repeat(14) + 'metric_0123456789abcdef\n');
    expect(data).toContain('\n    2\n      id' + ' '.repeat(14) + 'metric_fedcba9876543210\n');
    expect(data).toContain('\n  tags          vip, spring\n');
    expect(data).toContain('\n  memo          null\n');
    expect(data).not.toContain('{"');
  });

  it('prints the same lines through a pipe, unwrapped, and the whole JSON with --json', async () => {
    const h = harness([detail(), reply(200, [appRecord()]), reply(200, [])]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', APP_REQUEST_ID]), h.err()).toBe(0);
    expect(h.out()).toContain('\n  distribution\n    id         41\n');
    expect(h.out()).toContain(`note${' '.repeat(12)}A long note about this metric that runs past the edge of an 80 column terminal`);

    const json = harness([detail(), reply(200, [appRecord()]), reply(200, [])]);
    json.signedIn();
    expect(await json.run(['apps', 'requests', APP_REQUEST_ID, '--json'])).toBe(0);
    expect((JSON.parse(json.out()) as { data: unknown }).data).toEqual(DATA);
  });
});

describe('siren apps show', () => {
  it('names the app once when its name is its key', async () => {
    const h = harness([reply(200, appRecord({ name: APP_KEY }))]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe(APP_KEY);
  });

  it('keeps the name beside the key when they differ', async () => {
    const h = harness([reply(200, appRecord({ name: 'Acme' }))]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe(`${APP_KEY}  Acme`);
  });

  it('fits a long feature name in 80 columns in a terminal', async () => {
    const app = appRecord();
    const features = (app.features as Array<Record<string, unknown>>).map((item) => ({ ...item, name: LONG }));
    const h = harness([reply(200, { ...app, features })]);
    h.signedIn();
    expect(await runCli(['apps', 'show', APP_KEY], tty(h)), h.err()).toBe(0);
    // The last column, NAME, is cut with an ellipsis to fit. --json holds it whole.
    expect(strip(h.out())).toMatch(/app:11 +notify-crm +Post-conversion action \(postConversionAction\) +Tell my ser…\n/);
    fits(h.out());
  });
});

describe('the apply plan', () => {
  it('wraps a long change at 80 columns in a terminal', async () => {
    const file = JSON.stringify({
      version: 1,
      apps: { [APP_KEY]: { name: 'Acme', url: '${SIREN_APP_URL}', features: { notify: { kind: 'postConversionAction', name: LONG } } } },
    });
    const h = harness([reply(200, appRecord())], { env: { SIREN_APP_URL: 'https://acme.example/siren' } });
    h.signedIn();
    h.write('siren.app.json', file);
    expect(await runCli(['apps', 'diff'], tty(h))).toBe(3);
    expect(strip(h.out())).toContain('adds feature notify');
    fits(h.out());
  });
});
