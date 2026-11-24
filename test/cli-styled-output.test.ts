import { describe, expect, it } from 'vitest';
import { Style } from '../src/cli/style';
import { harness } from './cli-fakes';

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
