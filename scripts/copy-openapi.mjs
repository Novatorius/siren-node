#!/usr/bin/env node
/**
 * Copies Siren's public spec over openapi.json, records where it came from in
 * openapi.source.json, and regenerates the CLI's resource commands.
 *
 * Usage: node scripts/copy-openapi.mjs <path to a Siren checkout>
 *
 * Siren writes docs/api/openapi.json from its REST controllers
 * (`composer openapi`). openapi.source.json holds the Siren commit and the
 * SHA-256 of the copied bytes. test/openapi-spec.test.ts checks openapi.json
 * against that hash on every run, so a hand edit fails in CI.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siren = process.argv[2];
if (siren === undefined) {
  process.stderr.write('Usage: node scripts/copy-openapi.mjs <path to a Siren checkout>\n');
  process.exit(2);
}

const bytes = readFileSync(resolve(siren, 'docs/api/openapi.json'));
const commit = execFileSync('git', ['-C', resolve(siren), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha256 = createHash('sha256').update(bytes).digest('hex');

writeFileSync(join(root, 'openapi.json'), bytes);
writeFileSync(join(root, 'openapi.source.json'), `${JSON.stringify({ from: 'docs/api/openapi.json', sirenCommit: commit, sha256 }, null, 2)}\n`);
execFileSync(process.execPath, [join(root, 'scripts', 'generate-cli-resources.mjs')], { stdio: 'inherit' });
process.stdout.write(`Copied Siren's spec at ${commit.slice(0, 10)} (sha256 ${sha256.slice(0, 12)}).\n`);
