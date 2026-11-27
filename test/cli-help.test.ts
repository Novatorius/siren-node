import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/cli/run';
import { harness } from './cli-fakes';

/*
 * Help, modeled on gh's (Alex, 2026-11-24: "siren help is kinda messy,
 * too"). The top help is a one-line description, USAGE, the commands under
 * short headings with one aligned line each, the global FLAGS, EXAMPLES and
 * LEARN MORE with the docs link. A command's help has the same shape with
 * its own flags and one or two examples. Nothing wraps at 80 columns.
 */

const ESC = '\u001b[';

async function helpOf(argv: string[], tty = false): Promise<string> {
  const h = harness([]);
  const { runCli } = await import('../src/cli/run');
  const code = tty ? await runCli(argv, { ...h.io, stdoutTty: true, env: { TERM: 'xterm-256color' } }) : await h.run(argv);
  expect(code, argv.join(' ')).toBe(0);
  return h.out();
}

function sections(text: string): string[] {
  return text.split('\n').filter((line) => /^[A-Z][A-Z ]+$/.test(line));
}

describe('help: siren --help', () => {
  it('has the shape of gh help: description, usage, grouped commands, flags, examples and learn more', async () => {
    const text = await helpOf(['--help']);
    expect(text.split('\n')[0]).toMatch(/^[A-Z].+\.$/);
    expect(sections(text)).toEqual([
      'USAGE',
      'GETTING STARTED',
      'APPS',
      'REQUESTS',
      'DEVELOPER TOOLS',
      'SANDBOX',
      'RECIPES',
      'ACTIVITY',
      'NOTES',
      'CONDITION SETS',
      'ENROLLERS',
      'RECORDS',
      'ACCOUNT',
      'FLAGS',
      'ENVIRONMENT',
      'EXAMPLES',
      'LEARN MORE',
    ]);
    expect(text).toContain('https://github.com/Novatorius/siren-node#command-line-tool');
    await expect(text).toMatchFileSnapshot('./__snapshots__/cli-help-top.txt');
  });

  it('puts listen, trigger and logs under DEVELOPER TOOLS, and sandbox and seed under SANDBOX', async () => {
    const text = await helpOf(['--help']);
    const under = (heading: string): string[] => {
      const lines = text.split('\n');
      const start = lines.indexOf(heading);
      const end = lines.indexOf('', start);
      return lines.slice(start + 1, end).map((line) => line.trim().split(/ {2,}/)[0]!);
    };
    expect(under('DEVELOPER TOOLS')).toEqual(['listen', 'trigger', 'trigger ask', 'logs tail', 'simulate', 'fixtures', 'apps test']);
    expect(under('SANDBOX')).toEqual(['sandbox create', 'sandbox list', 'sandbox reset', 'sandbox inbox', 'seed']);
    expect(under('RECORDS')).toEqual(['<resource> <op>', 'get <path>', 'post <path>', 'resources', 'open']);
    expect(under('ACTIVITY')).toEqual(['activity', 'explain']);
  });

  it('lists every command once, on one line, with its name and a short summary aligned', async () => {
    const text = await helpOf(['--help']);
    const listed = text.split('\n').filter((line) => /^ {2}((apps|logs|trigger|sandbox|recipes|notes|condition-sets|enrollers) )?[a-z-]+ {2,}\S/.test(line) && !line.trimStart().startsWith('-'));
    const names = listed.map((line) => line.trim().split(/ {2,}/)[0]);
    // RECORDS adds `resources` beside its lines with arguments, which the pattern skips.
    expect([...names].sort()).toEqual([...COMMANDS, 'resources'].sort());
    expect(new Set(listed.map((line) => line.search(/ {2,}\S/) + line.slice(line.search(/ {2,}\S/)).search(/\S/))).size).toBe(1);
  });

  it('is the same text for siren help, and siren apps lists the app commands in the same shape', async () => {
    expect(await helpOf(['help'])).toBe(await helpOf(['--help']));
    const apps = await helpOf(['apps']);
    expect(sections(apps)).toEqual(['USAGE', 'APPS', 'REQUESTS', 'LEARN MORE']);
    expect(apps).not.toContain('  login');
    const recipes = await helpOf(['recipes']);
    expect(sections(recipes)).toEqual(['USAGE', 'RECIPES', 'LEARN MORE']);
    expect(recipes).toContain("an API key can't use recipes yet");
  });
});

describe('help: siren <command> --help', () => {
  it('has the same shape, with the command\'s own flags and one or two examples', async () => {
    for (const command of COMMANDS) {
      const text = await helpOf([...command.split(' '), '--help']);
      const own = sections(text);
      expect(own[0], command).toBe('USAGE');
      expect(own.slice(-3), command).toEqual(['GLOBAL FLAGS', 'EXAMPLES', 'LEARN MORE']);
      expect(text, command).toContain(`  siren ${command}`);
      const examples = text.slice(text.indexOf('EXAMPLES\n')).split('\n').filter((line) => line.startsWith('  $ siren '));
      expect(examples.length, command).toBeGreaterThanOrEqual(1);
      expect(examples.length, command).toBeLessThanOrEqual(2);
    }
  });

  it('snapshots login and apps apply', async () => {
    await expect(await helpOf(['login', '--help'])).toMatchFileSnapshot('./__snapshots__/cli-help-login.txt');
    await expect(await helpOf(['apps', 'apply', '--help'])).toMatchFileSnapshot('./__snapshots__/cli-help-apps-apply.txt');
  });
});

describe('help: fits 80 columns, and styles only a terminal', () => {
  it('keeps every line of every help within 80 columns', async () => {
    for (const argv of [['--help'], ['apps'], ...COMMANDS.map((command) => [...command.split(' '), '--help'])]) {
      for (const line of (await helpOf(argv)).split('\n')) expect([...line].length, `${argv.join(' ')}: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  it('bolds the headings and command names in a terminal, and prints no escape code when piped', async () => {
    expect(await helpOf(['--help'])).not.toContain(ESC);
    const styled = await helpOf(['--help'], true);
    expect(styled).toContain(`${ESC}1mUSAGE${ESC}0m`);
    expect(styled).toContain(`${ESC}1mapps apply${ESC}0m`);
    expect(styled.replace(/\u001b\[[\d;]*m/g, '')).toBe(await helpOf(['--help']));
  });
});
