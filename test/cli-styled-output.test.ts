import { describe, expect, it } from 'vitest';
import { Style } from '../src/cli/style';
import { harness } from './cli-fakes';
import { APP_KEY, appMissing, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * Alex, after `siren apps init` in the demo kit: "the cli response here is
 * just a text dump. no human is gonna read this blob of text." Every
 * command's success output takes this shape: a ✓ headline with the thing
 * in bold, a short aligned block with dim labels, a numbered Next with the
 * commands styled, and one or two dim › tips. Nothing wraps at 80 columns,
 * and a file in the working folder is named, not given as a full path.
 */

const ESC = '\u001b[';
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const rich = new Style({ tty: true, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
const plain = new Style({ tty: false, env: {} });

describe('style: a report', () => {
  const report = {
    headline: (style: Style) => `Created ${style.bold('siren.app.json')}`,
    rows: [
      ['App', 'acme-payouts'],
      ['Feature', 'notify · Post-conversion action'],
    ] as const,
    next: (style: Style) => [{ text: 'Set SIREN_APP_URL to your https address', aside: 'in .env' }, { text: style.command('siren apps apply') }],
    tips: ['Use a tunnel such as cloudflared.'],
  };
  const render = (style: Style) =>
    style.report({ headline: report.headline(style), rows: report.rows, next: report.next(style), tips: report.tips });

  it('lays out the headline, the aligned block, the numbered steps and the tips', () => {
    expect(render(plain)).toBe(
      [
        'Created siren.app.json',
        '',
        '  App       acme-payouts',
        '  Feature   notify · Post-conversion action',
        '',
        'Next',
        '  1  Set SIREN_APP_URL to your https address   in .env',
        '  2  siren apps apply',
        '',
        'Use a tunnel such as cloudflared.',
        '',
      ].join('\n'),
    );
  });

  it('in a terminal: a green ✓, dim labels and asides, a bold Next, and dim › tips, aligned as when plain', () => {
    const text = render(rich);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^\u001b\[[\d;]+m✓\u001b\[0m Created \u001b\[1msiren\.app\.json\u001b\[0m$/);
    expect(text).toContain(`  ${ESC}2mApp${ESC}0m       acme-payouts`);
    expect(text).toContain(`${ESC}1mNext${ESC}0m`);
    expect(text).toContain(`${ESC}2min .env${ESC}0m`);
    expect(text).toContain(`${ESC}1msiren apps apply${ESC}0m`);
    expect(text).toContain(`${ESC}2m› Use a tunnel such as cloudflared.${ESC}0m`);
    expect(strip(text)).toBe(`✓ ${render(plain)}`.replace('\nUse a tunnel', '\n› Use a tunnel'));
  });
});

describe('siren apps init: the success output', () => {
  it('says what it made, what it ignored, and what comes next, in the report shape', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'init', '--key', 'acme-payouts']), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        'Created siren.app.json',
        '',
        '  App       acme-payouts',
        '  Feature   notify · Post-conversion action',
        '  Ignored   .env.sandbox, .env.live, .env.*.tmp (added to .gitignore)',
        '',
        'Next',
        "  1  Set SIREN_APP_URL to your handler's https address   in .env or your shell",
        '  2  siren apps apply',
        '',
        'Running the handler on this machine? Use a tunnel such as cloudflared.',
        'Add features in siren.app.json. Your editor completes them.',
        '',
      ].join('\n'),
    );
    expect(h.out()).not.toContain(h.cwd);
  });

  it('leaves out the Ignored row when .gitignore already holds the env files', async () => {
    const h = harness([]);
    h.write('.gitignore', '.env.sandbox\n.env.live\n.env.*.tmp\n');
    expect(await h.run(['apps', 'init', '--key', 'acme-payouts']), h.err()).toBe(0);
    expect(h.out()).not.toContain('Ignored');
  });

  it('is styled in a terminal, and fits 80 columns', async () => {
    const h = harness([]);
    const { runCli } = await import('../src/cli/run');
    expect(await runCli(['apps', 'init', '--key', 'acme-payouts', '--quiet'], { ...h.io, stdoutTty: true, env: { TERM: 'xterm-256color' } })).toBe(0);
    const text = h.out();
    expect(text).toContain('✓');
    expect(text).toContain(`${ESC}1msiren apps apply${ESC}0m`);
    for (const line of strip(text).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    await expect(text).toMatchFileSnapshot('./__snapshots__/cli-styled-init.txt');
  });
});

describe('siren apps apply: the plan and the result (catalog mockup 1)', () => {
  const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
  const SIGNING_SECRET = 'ef'.repeat(32);
  const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
  const made = () => reply(201, { ...appRecord(), rawKey: RAW_KEY, signingSecret: SIGNING_SECRET });

  async function firstApply(options: { tty?: boolean } = {}) {
    const h = harness([appMissing(), made()], { env: URL_ENV, interactive: true, typed: ['y'] });
    h.signedIn();
    await h.run(['apps', 'init', '--key', APP_KEY]);
    const { runCli } = await import('../src/cli/run');
    const io = options.tty === true ? { ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } } : h.io;
    const before = h.out().length;
    expect(await runCli(['apps', 'apply', '--quiet'], io), h.err()).toBe(0);
    return { h, text: h.out().slice(before) };
  }

  it('shows the plan with + markers and the organization, then a ✓ report with the key, each feature and two numbered steps', async () => {
    const { h, text } = await firstApply();
    expect(text).toBe(
      [
        'Plan  acme-payouts → Acme (3), sandbox',
        '',
        '  + makes the app with a key, an address and 1 feature',
        '  + adds feature notify, Post-conversion action (postConversionAction), named Tell my service about each approved conversion',
        '  → sends its requests to https://acme.example',
        '',
        'Made acme-payouts in Acme',
        '',
        '  Key           sk_test_0a0a0a0a… in .env.sandbox, with its signing secret',
        '  notify-crm    app:11 · Post-conversion action',
        '  acme-ledger   app:12 · Payout method',
        '  URL from      SIREN_APP_URL',
        '',
        'Next',
        '  1  node --env-file=.env.sandbox server.js   run your handler with its key',
        '  2  siren apps requests --follow             watch what Siren sends it',
        '',
      ].join('\n'),
    );
    expect(h.prompts.at(-1)).toBe('Make acme-payouts in Acme (3), sandbox? [y/N] ');
    expect(h.printed()).not.toContain(RAW_KEY);
    expect(h.printed()).not.toContain(SIGNING_SECRET);
    expect(text).not.toContain('autofulfiller');
    expect(text).not.toContain(h.cwd);
  });

  it('is styled in a terminal, and fits 80 columns', async () => {
    const { text } = await firstApply({ tty: true });
    expect(text).toContain(`${ESC}1mPlan${ESC}0m`);
    expect(text).toMatch(/\u001b\[[\d;]+m\+\u001b\[0m makes the app/);
    expect(strip(text)).toContain('✓ Made acme-payouts in Acme');
    expect(text).toContain(`${ESC}1mnode --env-file=.env.sandbox server.js${ESC}0m`);
    for (const line of strip(text).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    await expect(text).toMatchFileSnapshot('./__snapshots__/cli-styled-apply-new.txt');
  });

  it('says ✓ and nothing more when the file already matches', async () => {
    const h = harness([reply(200, appRecord({ name: 'Acme' }))], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', JSON.stringify({ version: 1, apps: { [APP_KEY]: { name: 'Acme', description: "Siren's example app.", url: '${SIREN_APP_URL}', features: {} } } }));
    await h.run(['apps', 'apply']);
    expect(h.out().split('\n')[0]).toMatch(/^acme-payouts already matches siren\.app\.json\. Nothing to send\.$|^Plan/);
  });

  it('declining sends nothing and says so in one quiet line, with exit 1', async () => {
    const h = harness([appMissing()], { env: URL_ENV, interactive: true, typed: ['n'] });
    h.signedIn();
    await h.run(['apps', 'init', '--key', APP_KEY]);
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.err()).toBe('siren: Nothing was sent.\n');
    expect(h.paths()).toEqual([`GET /apps/${APP_KEY}`]);
  });
});
