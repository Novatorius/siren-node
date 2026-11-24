import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESOURCE_COMMANDS } from '../src/cli/resources.generated';

/*
 * src/cli/resources.generated.ts is built from openapi.json by
 * scripts/generate-cli-resources.mjs. The checked-in file must be what the
 * script writes today, so a spec change without a regenerated file fails here.
 */

const script = fileURLToPath(new URL('../scripts/generate-cli-resources.mjs', import.meta.url));
const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { 'x-siren-operator-only'?: boolean }>>;
};

describe('generated resource commands', () => {
  it('regenerating from openapi.json changes nothing', () => {
    const out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(out).toContain('matches openapi.json');
  });

  it('names each route the spec has, and no operator-only route', () => {
    expect(RESOURCE_COMMANDS.length).toBeGreaterThan(30);
    for (const command of RESOURCE_COMMANDS) {
      for (const [op, route] of Object.entries(command.ops)) {
        const operation = spec.paths[route.path]?.[route.method.toLowerCase()];
        expect(operation, `${command.name} ${op}`).toBeDefined();
        expect(operation?.['x-siren-operator-only'], `${command.name} ${op}`).toBeUndefined();
      }
    }
  });

  it('gives programs all five operations', () => {
    const programs = RESOURCE_COMMANDS.find((command) => command.name === 'programs');
    expect(Object.keys(programs?.ops ?? {}).sort()).toEqual(['create', 'delete', 'get', 'list', 'update']);
    expect(programs?.ops.list?.paginated).toBe(true);
  });
});
