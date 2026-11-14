import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Proves the no-network guard's afterEach check (test/setup/no-network.ts)
 * fails a test that reached for a host off this machine, even when that
 * test caught the guard's throw. A test cannot watch its own afterEach fail,
 * so this one runs a fixture file in a child Vitest process with the
 * repository's real setup file and reads the child's JSON report.
 *
 * End-to-end shape (KB 569): the real Vitest binary, the real setup file and
 * the real report, with nothing mocked. The fixture's host is under
 * `.invalid`, so a guard broken open still sends nothing that could reach
 * Siren Cloud.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = join(ROOT, 'test', 'fixtures', 'no-network', 'vitest.config.ts');

interface AssertionResult {
  title: string;
  status: string;
  failureMessages: string[];
}

interface Report {
  numPassedTests: number;
  numFailedTests: number;
  testResults: Array<{ assertionResults: AssertionResult[] }>;
}

/** Runs the fixture in a child Vitest and answers its exit code and JSON report. */
function runFixture(): { status: number | null; report: Report; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'no-network-check-'));
  const outputFile = join(dir, 'report.json');
  // The child is a run of its own, so it inherits none of this run's Vitest state.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:__)?VITEST/.test(name)));
  try {
    const child = spawnSync(
      process.execPath,
      [VITEST, 'run', '--config', CONFIG, '--reporter=json', `--outputFile=${outputFile}`],
      { cwd: ROOT, encoding: 'utf8', env: { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 60_000 },
    );
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    let report: Report;
    try {
      report = JSON.parse(readFileSync(outputFile, 'utf8')) as Report;
    } catch {
      throw new Error(`the child Vitest wrote no JSON report. Its output:\n${output}`);
    }
    return { status: child.status, report, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('no-network guard check after each test', () => {
  it('fails a test that reached for a host off this machine and caught the throw, and passes one that sent nothing', () => {
    const { status, report } = runFixture();

    const results = report.testResults.flatMap((file) => file.assertionResults);
    const reached = results.find((result) => result.title === 'reaches the network and catches the refusal');
    const quiet = results.find((result) => result.title === 'sends nothing');

    expect(reached?.status, 'the test that reached the network').toBe('failed');
    const message = reached?.failureMessages.join('\n') ?? '';
    expect(message).toContain('hosts a test tried to reach through the global fetch');
    expect(message).toContain('escape.example.invalid');
    expect(quiet?.status, 'the test that sent nothing').toBe('passed');
    expect([report.numFailedTests, report.numPassedTests]).toEqual([1, 1]);
    expect(status).not.toBe(0);
  }, 60_000);
});
