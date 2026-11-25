import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DELETE_ROUTES, RESOURCE_COMMANDS } from '../src/cli/resources.generated';

/*
 * src/cli/resources.generated.ts is built from openapi.json by
 * scripts/generate-cli-resources.mjs. The checked-in file must be what the
 * script writes today, so a spec change without a regenerated file fails here.
 */

const script = fileURLToPath(new URL('../scripts/generate-cli-resources.mjs', import.meta.url));
const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { 'x-siren-platforms': string[] }>>;
};

describe('generated resource commands', () => {
  it('regenerating from openapi.json changes nothing', () => {
    const out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(out).toContain('matches openapi.json');
  });

  it('names only routes the spec has on Siren Cloud', () => {
    expect(RESOURCE_COMMANDS.length).toBeGreaterThan(30);
    for (const command of RESOURCE_COMMANDS) {
      for (const [op, route] of Object.entries(command.ops)) {
        const operation = spec.paths[route.path]?.[route.method.toLowerCase()];
        expect(operation, `${command.name} ${op}`).toBeDefined();
        expect(operation?.['x-siren-platforms'], `${command.name} ${op}`).toContain('cloud');
      }
    }
  });

  it('leaves out WordPress-only resources such as settings', () => {
    expect(spec.paths['/settings']?.get?.['x-siren-platforms']).toEqual(['wordpress']);
    expect(RESOURCE_COMMANDS.find((command) => command.name === 'settings')).toBeUndefined();
  });

  it('lists each DELETE route with the parameter that names its record', () => {
    expect(DELETE_ROUTES).toContainEqual({ path: '/programs/{id}', param: 'id' });
    expect(DELETE_ROUTES).toContainEqual({ path: '/apps/{key}/key', param: 'key' });
    expect(DELETE_ROUTES).toContainEqual({ path: '/coupon-codes' });
    for (const route of DELETE_ROUTES) expect(spec.paths[route.path]?.delete, route.path).toBeDefined();
  });

  it('gives programs all five operations', () => {
    const programs = RESOURCE_COMMANDS.find((command) => command.name === 'programs');
    expect(Object.keys(programs?.ops ?? {}).sort()).toEqual(['create', 'delete', 'get', 'list', 'update']);
    expect(programs?.ops.list?.paginated).toBe(true);
  });
});
