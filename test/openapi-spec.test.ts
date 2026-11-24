import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * openapi.json is a byte copy of Siren's docs/api/openapi.json, which Siren
 * writes from its REST controllers (`composer openapi`). It replaced the
 * hand-written openapi.yaml, which had drifted from Siren. Contract:
 * contract/devtools-resources.md in the devtools run folder, section 3.
 */

const text = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');
const spec = JSON.parse(text) as {
  openapi: string;
  info: { version: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, { operationId: string; tags: string[]; 'x-siren-editions': string[] }>>;
  'x-siren-open-routes': { request: string[]; response: string[] };
};

describe("openapi.json, Siren's spec", () => {
  it("is byte for byte the copy Siren wrote, when SIREN_OPENAPI names Siren's file", () => {
    const siren = process.env.SIREN_OPENAPI;
    if (siren === undefined || siren === '') {
      console.warn('Skipped the byte check: set SIREN_OPENAPI to the path of Siren\'s docs/api/openapi.json, or contract/openapi.json in the run folder.');
      return;
    }
    expect(text === readFileSync(siren, 'utf8'), `openapi.json differs from ${siren}. Copy Siren's file over it, then run node scripts/generate-cli-resources.mjs.`).toBe(true);
  });

  it('is OpenAPI 3.1 written the way Siren writes it, with one trailing newline', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe('v1');
    expect(spec.servers.map((server) => server.url)).toEqual(['https://api.sirenaffiliates.com/siren/v1', 'https://sandbox.sirenaffiliates.com/siren/v1']);
    expect(text).toBe(`${JSON.stringify(spec, null, 4)}\n`);
  });

  it('gives every operation one tag that the tag list names, a unique operationId and its editions', () => {
    const tags = new Set(spec.tags.map((tag) => tag.name));
    const ids = new Set<string>();
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation.tags).toHaveLength(1);
        expect(tags.has(operation.tags[0]!)).toBe(true);
        expect(ids.has(operation.operationId)).toBe(false);
        ids.add(operation.operationId);
        expect(operation['x-siren-editions'].length).toBeGreaterThan(0);
      }
    }
  });

  it('holds the routes the hand-written spec got wrong as Siren serves them', () => {
    expect(spec.paths['/api-keys']).toBeUndefined();
    expect(spec.paths['/webhooks']?.post).toBeUndefined();
    expect(spec.paths['/programs']?.get).toBeDefined();
    expect(spec.paths['/apps/requests/{requestKey}/answer']?.post ?? spec.paths['/apps/requests/{key}/answer']?.post).toBeDefined();
  });

  it('lists the routes whose schemas Siren does not declare', () => {
    const operations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    for (const line of [...spec['x-siren-open-routes'].request, ...spec['x-siren-open-routes'].response]) expect(operations).toContain(line);
  });
});
