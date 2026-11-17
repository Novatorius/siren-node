import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, CLI_VERSION } from '../src/cli/run';

/*
 * Acceptance tests for the built `siren` command, packet cli-session.
 * Contract: docs/architecture/apps-cli.md, "The package".
 *
 * The build checks need `npm run build` first, as CI runs it. Outside CI a
 * run without a build skips them, as test/connect-build.test.ts does. The
 * child process gets an empty config folder and no SIREN_BASE_URL, and
 * `--help` and `--version` send nothing.
 *
 * Pending: the packet turns `describe.skip` into `describe`.
 */

const root = join(__dirname, '..');
const cli = join(root, 'dist', 'cli.js');

function siren(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, SIREN_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'siren-cli-build-')) };
  delete env.SIREN_BASE_URL;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

describe.skip('apps-cli: the siren command in the package', () => {
  it('names dist/cli.js as the siren bin', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin?: unknown; files?: string[] };
    expect(pkg.bin).toEqual({ siren: './dist/cli.js' });
    expect(pkg.files).toContain('dist');
  });

  it('is present when CI runs the tests', () => {
    if (process.env.CI) expect(existsSync(cli), 'run npm run build before npm test').toBe(true);
  });

  it.skipIf(!existsSync(cli))('starts with a node shebang and runs --help and --version', () => {
    expect(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);

    const help = siren(['--help']);
    expect(help.status, help.stderr).toBe(0);
    for (const command of COMMANDS) expect(help.stdout).toContain(command);

    const version = siren(['--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(CLI_VERSION);
  });

  it.skipIf(!existsSync(cli))('answers exit code 2 for an unknown command', () => {
    const run = siren(['deploy']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('deploy');
  });
});
