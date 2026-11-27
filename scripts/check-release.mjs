// Runs before `npm publish`. Refuses to publish a version npm already holds, since npm
// takes each version once, and a package without the files `siren apps init` links to
// and `siren` runs, so the `$schema` link init writes resolves once this version is out
// (review round 1, C7).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const problems = [];

let published = [];
try {
  published = JSON.parse(execFileSync(npm, ['view', pkg.name, 'versions', '--json'], { encoding: 'utf8' }));
} catch (error) {
  if (!String(error.stdout ?? '').includes('E404')) throw error;
}
if ([].concat(published).includes(pkg.version)) {
  problems.push(`npm already holds ${pkg.name}@${pkg.version}. Raise the version in package.json and src/version.ts.`);
}

const [packed] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = new Set(packed.files.map((file) => file.path));
for (const needed of ['siren.app.schema.json', 'dist/cli.js']) {
  if (!files.has(needed)) problems.push(`The package leaves out ${needed}. Run npm run build, and keep it in "files".`);
}

const source = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
if (!source.includes(`'${pkg.version}'`)) problems.push(`src/version.ts doesn't say ${pkg.version}, so the $schema link apps init writes names another version.`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-release: ${problem}`);
  process.exit(1);
}
console.log(`check-release: ${pkg.name}@${pkg.version} is new on npm and ships siren.app.schema.json and dist/cli.js.`);
