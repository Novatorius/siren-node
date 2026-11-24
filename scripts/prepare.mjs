// npm runs `prepare` after `npm install` in this checkout, and for an
// install from Git or from a local folder. It builds dist with tsup when the
// dev dependencies are there. An install from a folder runs it without them,
// so it keeps a dist that is already built, and otherwise says what to run.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'tsup.cmd' : 'tsup');

if (existsSync(bin)) {
  const run = spawnSync(bin, [], { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(run.status ?? 1);
}
if (existsSync(join('dist', 'index.js'))) {
  console.log('@novatorius/siren: tsup is not installed here and dist is already built, so prepare skips the build.');
  process.exit(0);
}
console.error(
  '@novatorius/siren: prepare needs tsup to build dist. Run npm ci in the siren-node folder, then npm run build, then install it again.',
);
process.exit(1);
