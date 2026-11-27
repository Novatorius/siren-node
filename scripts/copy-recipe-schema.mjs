#!/usr/bin/env node
/**
 * Copies Siren's recipe schema over siren.recipe.schema.json, which the
 * package ships so an editor completes a recipe through `$schema`, and
 * records where it came from in siren.recipe.schema.source.json.
 *
 * Usage: node scripts/copy-recipe-schema.mjs <path to a Siren checkout> [git ref]
 *
 * The schema is lib/Recipes/Core/recipe.schema.json, which Siren validates
 * every recipe against. With a ref, such as origin/feat/apps, it is read with
 * `git show`, so a checkout on another branch serves without being touched.
 * test/recipe-schema.test.ts checks the copy against the recorded SHA-256 on
 * every run, so a hand edit fails in CI.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATH = 'lib/Recipes/Core/recipe.schema.json';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [siren, ref] = process.argv.slice(2);
if (siren === undefined) {
  process.stderr.write('Usage: node scripts/copy-recipe-schema.mjs <path to a Siren checkout> [git ref]\n');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-C', resolve(siren), ...args], { encoding: ref === undefined ? 'utf8' : 'buffer', maxBuffer: 1 << 26 });
const bytes = ref === undefined ? readFileSync(resolve(siren, PATH)) : git('show', `${ref}:${PATH}`);
const commit = String(execFileSync('git', ['-C', resolve(siren), 'rev-parse', ref ?? 'HEAD'], { encoding: 'utf8' })).trim();
JSON.parse(bytes.toString('utf8'));
const sha256 = createHash('sha256').update(bytes).digest('hex');

writeFileSync(join(root, 'siren.recipe.schema.json'), bytes);
writeFileSync(join(root, 'siren.recipe.schema.source.json'), `${JSON.stringify({ from: PATH, sirenCommit: commit, sha256 }, null, 2)}\n`);
process.stdout.write(`Copied Siren's recipe schema at ${commit.slice(0, 10)} (sha256 ${sha256.slice(0, 12)}).\n`);
