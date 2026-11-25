import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliRefusal } from '../src/cli/targets';
import { Style, styleFor, unbroken, visibleLength } from '../src/cli/style';
import { harness } from './cli-fakes';

/*
 * The style module, Alex's ruling M108 (briefs/sdk-dx-loop.md, "CLI output
 * and errors, pulled forward"). Every line the tool prints goes through it.
 * Styled in a terminal, plain everywhere else, and --json never styled.
 */

const ESC = '\u001b[';
const TTY = { tty: true, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } };
const rich = new Style(TTY);
const plain = new Style({ tty: false, env: {} });

describe('style: when output is styled', () => {
  it('styles a terminal, and nothing else', () => {
    expect(rich.rich).toBe(true);
    for (const [name, options] of [
      ['not a terminal', { tty: false, env: {} }],
      ['NO_COLOR', { tty: true, env: { NO_COLOR: '1' } }],
      ['TERM=dumb', { tty: true, env: { TERM: 'dumb' } }],
      ['CI', { tty: true, env: { CI: 'true' } }],
      ['--json', { tty: true, env: {}, json: true }],
    ] as const) {
      expect(new Style(options).rich, name).toBe(false);
    }
    expect(new Style({ tty: true, env: { NO_COLOR: '' } }).rich).toBe(true);
    expect(new Style({ tty: true, env: { CI: 'false' } }).rich).toBe(true);
  });

  it('reads the terminal from the io, stream by stream', () => {
    const h = harness([]);
    expect(styleFor({ ...h.io, stdoutTty: true }, 'stdout', {}).rich).toBe(true);
    expect(styleFor({ ...h.io, stdoutTty: true }, 'stderr', {}).rich).toBe(false);
    expect(styleFor(h.io, 'stdout', {}).rich).toBe(false);
  });
});

describe('style: lines', () => {
  it('marks done, failed, a warning and a next step with a symbol in a terminal', () => {
    expect(rich.success('Applied acme-payouts.')).toMatch(/^\u001b\[[\d;]+m✓\u001b\[0m Applied acme-payouts\.$/);
    expect(rich.failure('Not logged in.')).toContain('✗');
    expect(rich.failure('Not logged in.')).toBe(`${ESC}31m${ESC}1m✗ Not logged in.${ESC}0m`);
    expect(rich.warning('The key is not saved.')).toContain('!');
    expect(rich.next('siren apps apply')).toContain('›');
  });

  it('prints the words alone, with no symbol and no escape code, when plain', () => {
    expect(plain.success('Applied acme-payouts.')).toBe('Applied acme-payouts.');
    expect(plain.failure('Not logged in.')).toBe('Not logged in.');
    expect(plain.warning('The key is not saved.')).toBe('The key is not saved.');
    expect(plain.next('siren apps apply')).toBe('siren apps apply');
    expect(plain.command('siren login') + plain.dim('app:12') + plain.bold('Acme') + plain.green('Siren')).toBe('siren loginapp:12AcmeSiren');
  });

  it('draws a command bold, and secondary detail dim', () => {
    expect(rich.command('siren login')).toBe(`${ESC}1msiren login${ESC}0m`);
    expect(rich.dim('app:12')).toBe(`${ESC}2mapp:12${ESC}0m`);
  });
});

describe('style: errors are three parts', () => {
  const refusal = new CliRefusal('Not logged in.', { why: 'No session.', fix: 'siren login', fixWords: 'to log in', detail: ['Siren: uat.example'] });

  it('gives the plain message on one line, as every error was before', () => {
    expect(refusal.message).toBe('Not logged in. No session. Run siren login to log in.');
    expect(plain.error(refusal, false)).toBe('siren: Not logged in. No session. Run siren login to log in.\n');
  });

  it('in a terminal: a red ✗ headline, the why, and the fix as a command to run', () => {
    const why = new CliRefusal('The file names no app.', { why: 'siren.app.json holds apps, and it is empty.', fix: 'siren apps init', fixWords: 'to start one' });
    const lines = rich.error(why, false).split('\n');
    expect(lines[0]).toContain('✗');
    expect(lines[0]).toContain('The file names no app.');
    expect(lines[1]).toBe('  siren.app.json holds apps, and it is empty.');
    expect(lines[2]).toContain('›');
    expect(lines[2]).toContain(`Run ${ESC}1msiren apps init${ESC}0m to start one.`);
    expect(lines).toHaveLength(4);
  });

  it('adds the detail, dim, only with --verbose or SIREN_DEBUG', () => {
    expect(rich.error(refusal, false)).not.toContain('uat.example');
    expect(rich.error(refusal, true)).toContain(`${ESC}2mSiren: uat.example`);
    expect(plain.error(refusal, true)).toBe('siren: Not logged in. No session. Run siren login to log in.\nSiren: uat.example\n');
  });

  it('always shows a dim line that is marked to show, such as a Siren that is not the default', () => {
    const elsewhere = new CliRefusal('Not logged in.', { why: 'No session.', fix: 'siren login', fixWords: 'to log in', note: 'Siren: uat.example' });
    expect(plain.error(elsewhere, false)).toBe('siren: Not logged in. No session. Run siren login to log in.\nSiren: uat.example\n');
    expect(rich.error(elsewhere, false)).toContain(`${ESC}2mSiren: uat.example`);
  });
});

describe('style: a report', () => {
  const tip = 'acme-payouts holds no key, so .env.sandbox has none. siren apps add-key acme-payouts makes one and saves it there.';

  it('wraps a long tip under itself so no line passes 80 columns, styled or plain', () => {
    for (const style of [rich, plain]) {
      const lines = style.report({ headline: 'Updated acme-payouts', tips: [tip] }).trimEnd().split('\n');
      for (const line of lines) expect(visibleLength(line), line).toBeLessThanOrEqual(80);
      const tipLines = lines.slice(2);
      expect(tipLines.length).toBeGreaterThan(1);
      expect(tipLines.map((line) => line.replace(/\u001b\[[\d;]*m/g, '')).join(' ').replace(/^› /, '').replace(/ {2,}/g, ' ')).toBe(tip);
    }
    expect(rich.report({ headline: 'x', tips: [tip] }).split('\n')[3]).toMatch(/^\u001b\[2m {2}\S/);
  });

  it('never breaks a command that unbroken() marks, and prints it with plain spaces', () => {
    const command = unbroken('siren apps rotate-key acme-payouts --base-url https://uat.example.com/siren/v1 --live');
    const text = plain.report({ headline: 'x', tips: [`.env.live holds no key for acme-payouts, which is fine. ${command} would save a new one.`] });
    expect(text).not.toContain('\u00a0');
    expect(text.split('\n').some((line) => line.includes('siren apps rotate-key acme-payouts --base-url https://uat.example.com/siren/v1 --live'))).toBe(true);
  });

  it('wraps a long row value under its own column', () => {
    const lines = plain.report({ headline: 'x', rows: [['Key', `${'sk_test_0a0a0a0a… and its signing secret, saved in '.repeat(2)}.env.sandbox`]] }).trimEnd().split('\n');
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(80);
    expect(lines[3]).toMatch(/^ {8}\S/);
  });
});

describe('style: tables', () => {
  const rows = [
    ['acme-payouts', 'on', 'Acme payouts and the long name that goes on'],
    ['signups', 'off', 'Signups'],
  ];

  it('aligns columns under a dim header in a terminal, and a plain header otherwise', () => {
    const styled = rich.table(['KEY', 'STATUS', 'NAME'], rows, 100);
    expect(styled[0]).toBe(`${ESC}2mKEY           STATUS  NAME${ESC}0m`);
    expect(styled[2]).toBe('signups       off     Signups');
    expect(plain.table(['KEY', 'STATUS', 'NAME'], rows, 100)[0]).toBe('KEY           STATUS  NAME');
  });

  it('fits the width by shortening the last column with an ellipsis', () => {
    const fitted = plain.table(['KEY', 'STATUS', 'NAME'], rows, 40);
    for (const line of fitted) expect([...line].length).toBeLessThanOrEqual(40);
    expect(fitted[1]).toMatch(/…$/);
  });
});

describe('style: a spinner for long work', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spins in a terminal, then leaves one ✓ line and the cursor back', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const spinner = rich.spinner('Waiting for approval', (text) => written.push(text));
    vi.advanceTimersByTime(400);
    spinner.stop(true, 'Logged in to Acme.');
    const text = written.join('');
    expect(text).toContain('Waiting for approval');
    expect(new Set(written.filter((write) => write.includes('Waiting')).map((write) => /[\u2800-\u28ff]/.exec(write)?.[0])).size).toBeGreaterThan(1);
    expect(text.endsWith(`\r${ESC}2K${rich.success('Logged in to Acme.')}\n${ESC}?25h`)).toBe(true);
    const after = written.length;
    vi.advanceTimersByTime(400);
    expect(written.length).toBe(after);
  });

  it('prints the words once, and the last line, when plain', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const spinner = plain.spinner('Waiting for approval', (text) => written.push(text));
    vi.advanceTimersByTime(400);
    spinner.stop(false, 'The code expired.');
    expect(written).toEqual(['Waiting for approval...\n', 'The code expired.\n']);
  });
});

describe('style: what runCli prints', () => {
  it('prints a refusal styled on a terminal, with the fix as a command', async () => {
    const h = harness([]);
    const { runCli } = await import('../src/cli/run');
    expect(await runCli(['whoami'], { ...h.io, stderrTty: true, env: { TERM: 'xterm-256color' } })).toBe(1);
    expect(h.err()).toContain('✗');
    expect(h.err()).toContain(`Run ${ESC}1msiren login${ESC}0m to log in.`);
  });

  it('keeps the error plain under NO_COLOR, and keeps --json output unstyled', async () => {
    const h = harness([]);
    const { runCli } = await import('../src/cli/run');
    expect(await runCli(['whoami'], { ...h.io, stderrTty: true, env: { NO_COLOR: '1' } })).toBe(1);
    expect(h.err()).toBe('siren: Not logged in. The tool keeps no session for sandbox.sirenaffiliates.com. Run siren login to log in.\n');
    const json = harness([]);
    json.signedIn();
    expect(await runCli(['whoami', '--json'], { ...json.io, stdoutTty: true, stderrTty: true, env: { TERM: 'xterm-256color' } })).toBe(0);
    expect(json.out()).not.toContain(ESC);
    expect(() => JSON.parse(json.out())).not.toThrow();
  });

  it('adds the detail with --verbose or SIREN_DEBUG=1, and the Siren beside a not-logged-in line when it is not the default', async () => {
    const h = harness([], { env: { SIREN_BASE_URL: 'https://uat.example/siren/v1' } });
    expect(await h.run(['whoami'])).toBe(1);
    expect(h.err()).toBe('siren: Not logged in. The tool keeps no session for uat.example. Run siren login to log in.\n');
    const verbose = harness([]);
    expect(await verbose.run(['whoami', '--verbose'])).toBe(1);
    expect(verbose.err()).toContain('Siren: sandbox.sirenaffiliates.com');
    const debug = harness([], { env: { SIREN_DEBUG: '1' } });
    expect(await debug.run(['whoami'])).toBe(1);
    expect(debug.err()).toContain('Siren: sandbox.sirenaffiliates.com');
  });
});

describe('style: a command line the tool cannot read', () => {
  it('in a terminal: the ✗ headline, where help is, and the guess as a command to run', async () => {
    const h = harness([]);
    const { runCli } = await import('../src/cli/run');
    expect(await runCli(['apps', 'aply'], { ...h.io, stderrTty: true, env: { TERM: 'xterm-256color' } })).toBe(2);
    const lines = h.err().split('\n');
    expect(lines[0]).toContain('✗');
    expect(lines[0]).toContain(`siren apps has no command ${ESC}1m"aply"${ESC}0m.`);
    expect(lines[1]).toBe('  siren apps --help lists the app commands.');
    expect(lines[2]).toContain(`Did you mean ${ESC}1msiren apps apply${ESC}0m?`);
    expect(lines[2]).toContain('›');
  });

  it('keeps the one-line form when plain', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'aply'])).toBe(2);
    expect(h.err()).toBe('siren: siren apps has no command "aply". Did you mean "apps apply"?\nsiren apps --help lists the app commands.\n');
  });
});
