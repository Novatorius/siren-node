// npm runs `prepare` after `npm install` in this checkout, and for an
// install from Git or from a local folder. It builds dist with tsup when the
// dev dependencies are there. An install from a folder runs it without them,
// so it keeps a dist that is already built, and otherwise says what to run.
//
// npm 10 runs it for `npm pack --dry-run --json --ignore-scripts` as well.
// A dry run writes nothing, so it keeps a built dist rather than rebuild it,
// since tsup empties dist first and a reader at that moment finds it bare.
// tsup's output goes to standard error, so `npm pack --json` stays JSON.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'tsup.cmd' : 'tsup');

const built = existsSync(join('dist', 'index.js'));

if (process.env.npm_config_dry_run === 'true' && built) {
  console.error('@novatorius/siren: a dry run writes nothing, so prepare keeps the dist that is built.');
  process.exit(0);
}
if (existsSync(bin)) {
  const run = spawnSync(bin, [], { stdio: ['inherit', process.stderr, 'inherit'], shell: process.platform === 'win32' });
  process.exit(run.status ?? 1);
}
if (built) {
  console.error('@novatorius/siren: tsup is not installed here and dist is already built, so prepare skips the build.');
  process.exit(0);
}
console.error(
  '@novatorius/siren: prepare needs tsup to build dist. Run npm ci in the siren-node folder, then npm run build, then install it again.',
);
process.exit(1);
