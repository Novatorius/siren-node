import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * openapi.json is a byte copy of Siren's docs/api/openapi.json, which Siren
 * writes from its REST controllers (`composer openapi`). It replaced the
 * hand-written openapi.yaml, which had drifted from Siren. Contract:
 * contract/devtools-resources.md in the devtools run folder, section 3.
 *
 * openapi.source.json records the Siren commit and the SHA-256 of the bytes
 * scripts/copy-openapi.mjs copied. The hash check runs on every run, CI
 * included. With SIREN_OPENAPI set to Siren's file, the bytes are compared
 * with it too.
 */

const text = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');
const source = JSON.parse(readFileSync(new URL('../openapi.source.json', import.meta.url), 'utf8')) as { from: string; sirenCommit: string; sha256: string };
const spec = JSON.parse(text) as {
  openapi: string;
  info: { version: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, { operationId: string; tags: string[]; 'x-siren-editions': string[]; 'x-siren-platforms': string[] }>>;
  'x-siren-open-routes': { request: string[]; response: string[] };
};

describe("openapi.json, Siren's spec", () => {
  it('is byte for byte the copy openapi.source.json records, so a hand edit fails', () => {
    expect(source.from).toBe('docs/api/openapi.json');
    expect(source.sirenCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(createHash('sha256').update(text).digest('hex'), `openapi.json is not the copy of Siren ${source.sirenCommit} that openapi.source.json records. Run node scripts/copy-openapi.mjs <Siren checkout>.`).toBe(source.sha256);
  });

  it.runIf(Boolean(process.env.SIREN_OPENAPI))("is byte for byte Siren's file, when SIREN_OPENAPI names it", () => {
    const siren = process.env.SIREN_OPENAPI!;
    expect(text === readFileSync(siren, 'utf8'), `openapi.json differs from ${siren}. Run node scripts/copy-openapi.mjs <Siren checkout>.`).toBe(true);
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
        expect(operation['x-siren-platforms'].length).toBeGreaterThan(0);
      }
    }
  });

  it('holds the routes the hand-written spec got wrong as Siren serves them', () => {
    expect(spec.paths['/api-keys']).toBeUndefined();
    expect(spec.paths['/webhooks']?.post).toBeUndefined();
    expect(spec.paths['/programs']?.get).toBeDefined();
    expect(spec.paths['/apps/requests/{requestKey}/answer']?.post ?? spec.paths['/apps/requests/{key}/answer']?.post).toBeDefined();
  });

  it('holds no operator, demo or sandbox route, and names no Siren class', () => {
    for (const path of Object.keys(spec.paths)) expect(path).not.toMatch(/^\/(provisioning|demo-control|demo-login|demo|sandbox|generator)(\/|$)/);
    for (const word of ['adminPassword', 'x-siren-operator-only', 'x-siren-controller', 'x-siren-model', 'Siren\\\\']) expect(text).not.toContain(word);
  });

  it('lists the routes whose schemas Siren does not declare', () => {
    const operations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    for (const line of [...spec['x-siren-open-routes'].request, ...spec['x-siren-open-routes'].response]) expect(operations).toContain(line);
  });
});
