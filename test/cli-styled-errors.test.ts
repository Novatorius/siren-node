import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { AuthAnswers, EMAIL, PASSWORD, harness } from './cli-fakes';

/*
 * Catalog mockups 4 and 5 (review/cli-dx/output-catalog.md in the run
 * folder): a refused login and an unknown command. In a terminal: a red
 * bold ✗ headline, the why indented two spaces, and the fix led by a
 * green ›, with the command bold. --verbose adds one dim line. Plain, the
 * one `siren:` line stays.
 */

const ESC = '\u001b[';
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const tty = (h: ReturnType<typeof harness>) => ({ ...h.io, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });

describe('mockup 4: a refused login', () => {
  const argv = ['login', '--email', EMAIL, '--password-stdin'];

  it('in a terminal: what failed, why, and what to do, in three lines', async () => {
    const h = harness([AuthAnswers.wrongPassword()], { stdin: PASSWORD });
    expect(await runCli(argv, tty(h))).toBe(1);
    expect(strip(h.err())).toBe(
      [
        "✗ Siren didn't accept that email and password.",
        '  Either is wrong, or this account has no password yet.',
        '› Check your inbox for the set-up email, or run siren login again.',
        '',
      ].join('\n'),
    );
    expect(h.err()).toContain(`${ESC}31m${ESC}1m✗ Siren didn't accept that email and password.${ESC}0m`);
    expect(h.err()).toMatch(/\n\u001b\[[\d;]+m›\u001b\[0m Check your inbox/);
    expect(h.err()).toContain(`${ESC}1msiren login${ESC}0m`);
  });

  it('plain: one siren: line', async () => {
    const h = harness([AuthAnswers.wrongPassword()], { stdin: PASSWORD });
    expect(await h.run(argv)).toBe(1);
    expect(h.err()).toBe(
      "siren: Siren didn't accept that email and password. Either is wrong, or this account has no password yet. Check your inbox for the set-up email, or run siren login again.\n",
    );
  });

  it('with --verbose: one dim line with the HTTP status and the Siren it asked', async () => {
    const h = harness([AuthAnswers.wrongPassword()], { stdin: PASSWORD });
    expect(await runCli([...argv, '--verbose'], tty(h))).toBe(1);
    const lines = h.err().trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(`${ESC}2mHTTP 401 · sandbox.sirenaffiliates.com${ESC}0m`);
  });
});

describe('mockup 5: an unknown command', () => {
  it('in a terminal: the word that is wrong in bold, the nearest command, and where help is, with no usage block', async () => {
    const h = harness([]);
    expect(await runCli(['apps', 'aply'], tty(h))).toBe(2);
    expect(strip(h.err())).toBe(['✗ siren apps has no command "aply".', '› Did you mean siren apps apply?', '  siren apps --help lists the app commands.', ''].join('\n'));
    expect(h.err()).toContain(`${ESC}1m"aply"${ESC}0m`);
    expect(h.err()).toContain(`${ESC}2m  siren apps --help lists the app commands.${ESC}0m`);
  });

  it('with no close match, leaves the guess out, and names the top help for a top-level word', async () => {
    const h = harness([]);
    expect(await runCli(['deploy'], tty(h))).toBe(2);
    expect(strip(h.err())).toBe(['✗ siren has no command "deploy".', '  siren --help lists them.', ''].join('\n'));
  });

  it('plain: one siren: line with the guess, and the help line', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'aply'])).toBe(2);
    expect(h.err()).toBe('siren: siren apps has no command "aply". Did you mean "apps apply"?\nsiren apps --help lists the app commands.\n');
  });
});
