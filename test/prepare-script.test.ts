import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * scripts/prepare.mjs, which npm runs on install and on pack. npm 10 runs it
 * for `npm pack --dry-run --json --ignore-scripts` too, so a tsup banner on
 * standard output broke the JSON, and tsup's clean emptied dist while other
 * tests read it. Each test runs the script in a folder with a stand-in tsup
 * that prints a banner and leaves a mark.
 */
const script = join(__dirname, '..', 'scripts', 'prepare.mjs');
const folders: string[] = [];

function folder(withDist: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'siren-prepare-'));
  folders.push(dir);
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  const tsup = join(dir, 'node_modules', '.bin', 'tsup');
  writeFileSync(tsup, '#!/bin/sh\necho "CLI Building entry: src/index.ts"\ntouch built\n');
  chmodSync(tsup, 0o755);
  if (withDist) {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.js'), '');
  }
  return dir;
}

function prepare(dir: string, env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')));
  return spawnSync(process.execPath, [script], { cwd: dir, env: { ...clean, ...env }, encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('scripts/prepare.mjs', () => {
  it("builds with tsup and sends tsup's output to standard error, so npm pack --json stays JSON", () => {
    const dir = folder(false);
    const run = prepare(dir);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, 'built'))).toBe(true);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('CLI Building');
  });

  it('leaves a built dist alone on a dry run, which writes nothing, so a dry-run pack never empties dist', () => {
    const dir = folder(true);
    const run = prepare(dir, { npm_config_dry_run: 'true' });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, 'built'))).toBe(false);
    expect(run.stdout).toBe('');
  });

  it('still builds on a dry run when there is no dist yet', () => {
    const dir = folder(false);
    const run = prepare(dir, { npm_config_dry_run: 'true' });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, 'built'))).toBe(true);
  });
});
