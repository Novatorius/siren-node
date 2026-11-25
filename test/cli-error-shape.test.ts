import { describe, expect, it } from 'vitest';
import { Style } from '../src/cli/style';
import { CliRefusal } from '../src/cli/targets';

import { readFileSync } from 'node:fs';
import { runCli } from '../src/cli/run';
import { AuthAnswers, EMAIL, PASSWORD, harness, session } from './cli-fakes';
import { APP_KEY, AppAnswers, PartAnswers, appMissing, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';
import { SANDBOX_BASE_URL } from '../src/http';
/*
 * CLI pass 3, must-fix 2 (review/cli-dx/pass-3-review.md): most errors were
 * one long red sentence, and 28 of 81 terminal screens wrapped mid-word.
 * Every error now has three parts, a ✗ headline, the why on its own line,
 * and a › fix, and the style module wraps each part at a word boundary
 * within 80 columns. The type of a refusal's parts requires the why and the
 * fix, so tsc holds every refusal site to the shape.
 */

const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const rich = new Style({ tty: true, env: { TERM: 'xterm-256color' } });
const plain = new Style({ tty: false, env: {} });
const long = 'the quick brown fox jumps over the lazy dog and keeps running across the field until evening';

describe('style: an error in a terminal', () => {
  it('wraps the headline, the why and the fix at word boundaries within 80 columns, with a hanging indent', () => {
    const refusal = new CliRefusal(`Headline ${long}`, { why: `Why ${long} ${long}`, fix: 'siren apps apply --live', fixWords: `to ${long}` });
    const lines = strip(rich.error(refusal, false)).trimEnd().split('\n');
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
    expect(lines[0]).toMatch(/^✗ Headline /);
    expect(lines[1]).toMatch(/^ {2}\S/);
    const fixAt = lines.findIndex((line) => line.startsWith('›'));
    expect(fixAt).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line, line).toMatch(/^( {2}\S|› )/);
    // No word is split: every word of the input appears whole.
    const words = new Set(lines.join(' ').split(/\s+/));
    for (const word of long.split(' ')) expect(words.has(word) || words.has(`${word}.`), word).toBe(true);
    // A command that fits a line stays on one line.
    expect(lines.some((line) => line.includes('siren apps apply --live'))).toBe(true);
  });

  it('prints a fix in words, with no command, after the ›', () => {
    const refusal = new CliRefusal('filter can\'t change kind.', { why: 'A kind locks once Siren makes the feature.', fixText: 'Give the Post-allocation action its own key in siren.app.json.' });
    expect(strip(rich.error(refusal, false))).toBe(
      "✗ filter can't change kind.\n  A kind locks once Siren makes the feature.\n› Give the Post-allocation action its own key in siren.app.json.\n",
    );
    expect(plain.error(refusal, false)).toBe(
      "siren: filter can't change kind. A kind locks once Siren makes the feature. Give the Post-allocation action its own key in siren.app.json.\n",
    );
  });

  it('keeps one line per part when piped, so a script greps one line', () => {
    const refusal = new CliRefusal(`Headline ${long}`, { why: `Why ${long}`, fix: 'siren login' });
    expect(plain.error(refusal, false).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('wraps success, warning and tip lines too, with a hanging indent', () => {
    for (const line of [rich.success(long + long), rich.warning(long + long), rich.next(long + long)]) {
      const lines = strip(line).split('\n');
      expect(lines.length).toBeGreaterThan(1);
      for (const one of lines) expect([...one].length, one).toBeLessThanOrEqual(80);
      for (const one of lines.slice(1)) expect(one).toMatch(/^ {2}\S/);
    }
  });
});

/* ---- Every error a person meets, as a terminal shows it ---- */


const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const UAT = 'https://uat.example.com/siren/v1';
const withKind = (kind: string) => exampleFile.replace('"postConversionAction"', JSON.stringify(kind));

type H = ReturnType<typeof harness>;
interface Screen {
  name: string;
  argv: string[];
  replies?: Parameters<typeof harness>[0];
  options?: Parameters<typeof harness>[1];
  setup?: (h: H) => void | Promise<void>;
  /** Part of the ✗ headline. */
  headline: string;
}

const signedLive = (h: H) => h.signedIn({ [UAT]: session({ edition: 'production', baseUrl: UAT }) });
const usesOf = (uses: number) => {
  const [notify, ledger] = appRecord().features;
  return appRecord({ features: [{ ...notify!, uses, openRequests: 0, usedBy: [] }, { ...ledger!, uses: 0, openRequests: 0, usedBy: [] }] });
};

const SCREENS: Screen[] = [
  { name: 'whoami signed out', argv: ['whoami'], headline: 'Not logged in.' },
  {
    name: 'a write on a live Siren without --live',
    argv: ['apps', 'off', APP_KEY, '--base-url', UAT],
    options: { edition: 'production' },
    setup: signedLive,
    headline: 'uat.example.com is a live Siren.',
  },
  { name: 'apply with no file', argv: ['apps', 'apply'], setup: (h) => h.signedIn(), headline: "There's no siren.app.json here." },
  {
    name: 'apply with the url variable unset',
    argv: ['apps', 'apply'],
    setup: (h) => {
      h.signedIn();
      h.write('siren.app.json', exampleFile);
    },
    headline: 'siren.app.json has a problem.',
  },
  {
    name: 'apply with an unknown kind',
    argv: ['apps', 'apply'],
    options: { env: URL_ENV },
    setup: (h) => {
      h.signedIn();
      h.write('siren.app.json', withKind('postAllocation'));
    },
    headline: 'siren.app.json has a problem.',
  },
  {
    name: 'apply with a kind change',
    argv: ['apps', 'apply', '--yes'],
    replies: [reply(200, usesOf(2))],
    options: { env: URL_ENV },
    setup: (h) => {
      h.signedIn();
      h.write('siren.app.json', withKind('postAllocationAction'));
    },
    headline: "notify-crm can't change kind.",
  },
  { name: 'show an app the organization lacks', argv: ['apps', 'show', 'nope-app'], replies: [appMissing()], setup: (h) => h.signedIn(), headline: 'This organization has no app nope-app.' },
  { name: 'add-key on an app with a key', argv: ['apps', 'add-key', APP_KEY, '--app-file', 'siren.app.json'], replies: [PartAnswers.keyExists()], setup: (h) => (h.signedIn(), h.write('siren.app.json', exampleFile)), headline: 'already has a key.' },
  { name: 'an organization the person is not in', argv: ['apps', 'list', '--org', 'nope'], replies: [AuthAnswers.memberships()], setup: (h) => h.signedIn(), headline: "You're not in an organization named nope." },
  { name: 'delete with no terminal and no --yes', argv: ['apps', 'delete', APP_KEY], setup: (h) => h.signedIn(), headline: 'Nothing deleted' },
  { name: 'rotate with no known env file', argv: ['apps', 'rotate-key', APP_KEY, '--yes'], setup: (h) => h.signedIn(), headline: "The tool doesn't know where" },
  { name: 'a delete records still use', argv: ['apps', 'delete', APP_KEY, '--yes'], replies: [AppAnswers.inUse(), reply(200, appRecord())], setup: (h) => h.signedIn(), headline: 'is still in use' },
  { name: 'sign-up without the terms', argv: ['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin'], options: { stdin: PASSWORD }, headline: "You need to accept Siren's terms" },
  { name: 'a request id that is no id', argv: ['apps', 'requests', '8'], setup: (h) => h.signedIn(), headline: "isn't a request id." },
  { name: 'an answer that is not JSON', argv: ['apps', 'answer', 'apr_0123456789abcdef0123456789abcdef', '--body', '{outcome:1}'], setup: (h) => h.signedIn(), headline: "The answer isn't JSON." },
  { name: 'an unknown command', argv: ['apps', 'aply'], headline: 'siren apps has no command' },
  { name: 'an unknown flag', argv: ['login', '--emial', EMAIL], headline: 'There is no option --emial' },
];

const tty = (h: H) => ({ ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });

describe('cli pass 3, must-fix 2: every error a person meets has three parts and fits 80 columns in a terminal', () => {
  for (const screen of SCREENS) {
    it(screen.name, async () => {
      const h = harness(screen.replies ?? [reply(500, {})], screen.options);
      await screen.setup?.(h);
      expect(await runCli(screen.argv, tty(h))).not.toBe(0);
      const lines = strip(h.err()).trimEnd().split('\n');
      expect(lines[0], h.err()).toMatch(/^✗ /);
      expect(lines.join('\n')).toContain(screen.headline);
      for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
      const fix = lines.findIndex((line) => line.startsWith('› '));
      expect(fix, lines.join('\n')).toBeGreaterThan(0);
      // The why sits between the headline and the fix, on lines of its own.
      expect(lines.slice(1, fix).some((line) => /^ {2}\S/.test(line)), lines.join('\n')).toBe(true);
    });
  }
});

describe('cli pass 3, must-fix 3: problems in siren.app.json print under the ✗ headline', () => {
  it('prints the headline first, then each place dim with its message under it, then the fix', async () => {
    const h = harness([]);
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await runCli(['apps', 'apply'], tty(h))).toBe(1);
    const lines = strip(h.err()).trimEnd().split('\n');
    expect(lines[0]).toBe('✗ siren.app.json has a problem.');
    expect(lines[1]).toBe('  The tool checks the file before it sends anything, so nothing was sent.');
    expect(lines[2]).toMatch(/^ {2}siren\.app\.json:\d+:\d+$/);
    expect(lines[3]).toMatch(/^ {4}apps\.acme-payouts\.url needs the environment variable SIREN_APP_URL/);
    // Pass 3 re-check, should-fix 9: the one problem is a variable that isn't set, so the fix names .env.
    expect(lines.at(-1)).toBe('› Set SIREN_APP_URL in .env, then run siren apps apply again.');
    expect(h.err()).toMatch(/\u001b\[2msiren\.app\.json:\d+:\d+\u001b\[0m/);
    expect(h.out()).toBe('');
  });

  it('keeps one file:line:col line per problem when piped, for an editor or a script', async () => {
    const h = harness([]);
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.err()).toMatch(/^siren: siren\.app\.json has a problem\. .*\nsiren\.app\.json:\d+:\d+: apps\.acme-payouts\.url needs the environment variable SIREN_APP_URL/);
  });
});

describe('cli pass 3, must-fix 4: browser login against a Siren without browser sign-in', () => {
  it('says the Siren offers no browser login yet, and names siren login --password, in place of "Not found."', async () => {
    const h = harness([reply(404, { error: { message: 'Not found.', context: [] } })], { interactive: true });
    expect(await h.run(['login'])).toBe(1);
    expect(h.paths()).toEqual(['POST /auth/cli/code']);
    expect(h.err()).toContain("siren: sandbox.sirenaffiliates.com doesn't offer browser login yet.");
    expect(h.err()).toContain('Run siren login --password.');
    expect(h.err()).not.toMatch(/^siren: Not found\./m);
  });

  it('keeps the flags that reach a live Siren in the fix', async () => {
    const h = harness([reply(404, { error: { message: 'Not found.', context: [] } })], { interactive: true, edition: 'production' });
    expect(await h.run(['login', '--base-url', UAT, '--live'])).toBe(1);
    expect(h.err()).toContain(`Run siren login --password --base-url ${UAT} --live.`);
  });
});

describe('cli pass 3, should-fix 6: siren app list', () => {
  it('offers siren apps list, not every apps command', async () => {
    const h = harness([]);
    expect(await h.run(['app', 'list'])).toBe(2);
    expect(h.err()).toContain('Did you mean "apps list"?');
    expect(h.err()).not.toContain('apps apply');
  });
});

/* ---- Pass 3 re-check, must-fix 2: the plain screens that wrapped mid-word ---- */

describe('pass 3 re-check, must-fix 2: signup, the empty list, the follow header and the delete question fit 80 columns', () => {
  const LONG_KEY = 'cli-dx-recheck-3c-with-a-much-longer-app-key';
  const longOrg = () => session({ orgName: 'UAT Organization for the Recheck', orgSlug: 'uat-org-recheck' });
  const screens: Array<{ name: string; argv: string[]; replies: Parameters<typeof harness>[0]; options?: Parameters<typeof harness>[1]; signed?: boolean; first: RegExp; stream: 'out' | 'err' }> = [
    {
      name: 'signup success',
      argv: ['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms'],
      replies: [AuthAnswers.registered()],
      options: { stdin: `${PASSWORD}\n` },
      signed: false,
      first: /^✓ Made Acme \(acme\)$/,
      stream: 'out',
    },
    { name: 'the empty apps list', argv: ['apps', 'list'], replies: [reply(200, [])], first: /^No apps in UAT Organization for the Recheck \(uat-org-recheck\), sandbox yet\.$/, stream: 'out' },
    {
      name: 'the --follow header',
      argv: ['apps', 'requests', '--app', LONG_KEY, '--follow'],
      replies: [reply(200, [appRecord({ key: LONG_KEY })]), reply(200, { requests: [] })],
      options: { onSleep: (_count, abort) => abort() },
      first: /^Watching cli-dx-recheck-3c-with-a-much-longer-app-key in UAT Organization for$/,
      stream: 'err',
    },
    {
      name: 'the delete question',
      argv: ['apps', 'delete', LONG_KEY],
      replies: [reply(200, { success: true })],
      options: { interactive: true, typed: [LONG_KEY] },
      first: /^! Deleting cli-dx-recheck-3c-with-a-much-longer-app-key from UAT Organization$/,
      stream: 'out',
    },
  ];
  for (const screen of screens) {
    it(screen.name, async () => {
      const h = harness(screen.replies, screen.options);
      if (screen.signed !== false) h.signedIn({ [SANDBOX_BASE_URL]: longOrg() });
      const code = await runCli(screen.argv, tty(h));
      expect([0, 130], h.err()).toContain(code);
      const text = strip(screen.stream === 'out' ? h.out() : h.err()).trimEnd();
      expect(text.split('\n')[0], text).toMatch(screen.first);
      for (const line of [...text.split('\n'), ...h.prompts.map((prompt) => `${prompt}${LONG_KEY}`)]) expect([...line].length, line).toBeLessThanOrEqual(80);
    });
  }
});
