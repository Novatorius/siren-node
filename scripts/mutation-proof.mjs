#!/usr/bin/env node
/*
 * Mutation proof for acceptance tests, per Proving a Test Is a Contract
 * (KB 730, https://navigator.novatori.us/r/kb/730).
 *
 * Usage: node scripts/mutation-proof.mjs <mutations.json>
 *
 * The file holds a list of mutations:
 *
 *   { "id": "drop-refund-kind", "file": "src/types.ts",
 *     "find": "exact text, present once", "replace": "the broken text",
 *     "expect": "caught" | "survives" | "refused",
 *     "failing": ["text the failure output must hold"],
 *     "offline": true }
 *
 * `offline` marks a mutation that weakens or removes the no-network guard
 * (test/setup/no-network.ts). A test it lets through could send a real
 * request, so the harness refuses to score it unless this process has no
 * network interface but loopback, as inside `unshare -rn` with `lo` up:
 *
 *   unshare -rn sh -c 'ip link set lo up && node scripts/mutation-proof.mjs <list>'
 *
 * For each one the harness applies the change, then:
 * 1. Refuses to score it when `find` is not in the file exactly once, or when
 *    `src` no longer compiles. A mutation that only breaks compilation runs
 *    no test, so it proves nothing about the tests.
 * 2. Otherwise runs this repository's verification, `npm test` and then
 *    `npm run typecheck` (navigator.yaml ci.test and ci.lint), and scores the
 *    mutation `caught` when either exits non-zero, else `survives`.
 * 3. For a caught mutation, checks that the failure lines hold every
 *    `failing` text, so a test that went red for another reason does not
 *    count. The failure lines are the ones that mark a failed test or a type
 *    error (`FAIL`, `×` or `error TS`), never the names of tests that passed.
 *    A text may name a test or the describe it sits in.
 * 4. Restores the file, whatever happened.
 *
 * Include four controls every run: one break the suite must catch, one
 * harmless change it must not, one malformed mutation it must refuse, and
 * one break whose `failing` text names a test that stays green, which must
 * score `wrong-reason`.
 * The run exits non-zero when any result differs from its `expect`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const root = process.cwd();
const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node scripts/mutation-proof.mjs <mutations.json>');
  process.exit(2);
}
const mutations = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
const gateConfig = resolve(root, '.mutation-gate.tsconfig.json');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  // Strip colour codes so a `failing` text matches however the tool styles it.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  return { status: result.status ?? 1, output };
}

function srcCompiles() {
  writeFileSync(gateConfig, JSON.stringify({ extends: './tsconfig.json', include: ['src'] }));
  try {
    return run('npx', ['tsc', '--noEmit', '-p', gateConfig]).status === 0;
  } finally {
    rmSync(gateConfig, { force: true });
  }
}

/** True when every network interface is loopback, so no request can leave this machine. */
function noRouteOut() {
  return Object.values(networkInterfaces())
    .flat()
    .every((entry) => entry === undefined || entry.internal);
}

function score(mutation) {
  if (mutation.offline === true && !noRouteOut()) {
    return { result: 'refused', why: 'an offline mutation needs a network namespace with no route out (unshare -rn)' };
  }
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(mutation.find).length - 1;
  if (count !== 1) return { result: 'refused', why: `find text occurs ${count} times` };

  writeFileSync(path, original.replace(mutation.find, mutation.replace));
  try {
    if (!srcCompiles()) return { result: 'refused', why: 'src does not compile' };
    const test = run('npm', ['test', '--silent']);
    const typecheck = test.status === 0 ? run('npm', ['run', 'typecheck', '--silent']) : { status: 0, output: '' };
    const output = test.output + typecheck.output;
    if (test.status === 0 && typecheck.status === 0) return { result: 'survives', why: 'verification passed' };
    const failures = output
      .split('\n')
      .filter((line) => /FAIL|error TS|×/.test(line))
      .map((line) => line.trim());
    const missing = (mutation.failing ?? []).filter((text) => !failures.some((line) => line.includes(text)));
    if (missing.length > 0) {
      return { result: 'wrong-reason', why: `failure lines lack: ${missing.join(' | ')}`, output };
    }
    const failed = failures.slice(0, 6);
    return { result: 'caught', why: failed.join(' / ') };
  } finally {
    writeFileSync(path, original);
  }
}

let mismatches = 0;
for (const mutation of mutations) {
  const outcome = score(mutation);
  const ok = outcome.result === mutation.expect;
  if (!ok) mismatches += 1;
  console.log(`${ok ? 'OK  ' : 'MISS'} ${mutation.id}: ${outcome.result} (expected ${mutation.expect})`);
  console.log(`     ${outcome.why}`);
  if (!ok && outcome.output) console.log(outcome.output.split('\n').slice(-40).join('\n'));
}
console.log(`\n${mutations.length - mismatches} of ${mutations.length} mutations scored as expected.`);
process.exit(mismatches === 0 ? 0 : 1);
