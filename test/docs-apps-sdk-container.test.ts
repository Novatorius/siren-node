import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppsResource } from '../src/resources/apps';
import { specServes } from './spec-routes';

/*
 * Slice C6: the architecture note names every app call the slice adds, and
 * the mutation list holds a caught break for each numbered item beside the
 * four controls the runner needs.
 */

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('apps-sdk-container: the note and the mutation list', () => {
  it('the note names each call on apps and apps.features, and the claims it closes', () => {
    const note = read('docs/architecture/apps-sdk-container.md');
    const calls = Object.getOwnPropertyNames(AppsResource.prototype).filter((name) => name !== 'constructor');
    for (const call of ['create', 'update', 'createKey', 'rotateKey', 'revokeKey', 'rotateSecret', 'test', 'deliveries', 'events', 'scopes', 'kinds']) {
      expect(calls, call).toContain(call);
      expect(note, call).toContain(`apps.${call}(`);
    }
    expect(note).toContain('apps.features.create');
    for (const section of ['Section 10', 'Section 14', 'Section 15']) expect(note, section).toContain(section);
    expect(note).not.toMatch(/[—;]/);
  });

  it('the mutation list holds the four controls and a caught break for every item', () => {
    const list = JSON.parse(read('scripts/mutations/apps-sdk-container.json')) as Array<{ id: string; expect: string; failing: string[] }>;
    expect(list.filter((entry) => entry.id.startsWith('control-')).map((entry) => entry.expect).sort()).toEqual([
      'caught',
      'refused',
      'survives',
      'wrong-reason',
    ]);
    const caught = list.filter((entry) => !entry.id.startsWith('control-'));
    expect(caught.length).toBeGreaterThanOrEqual(12);
    for (const entry of caught) {
      expect(entry.expect, entry.id).toBe('caught');
      expect(entry.failing.length, entry.id).toBeGreaterThan(0);
    }
    for (let item = 1; item <= 9; item += 1) {
      expect(caught.some((entry) => entry.id.startsWith(`item${item}-`)), `item ${item}`).toBe(true);
    }
    for (let fix = 1; fix <= 8; fix += 1) {
      expect(caught.some((entry) => entry.id.startsWith(`review${fix}-`)), `review fix ${fix}`).toBe(true);
    }
  });
});

/** The app routes that replaced the old key and webhook routes. */
const REPLACING_ROUTES: Array<[string, string]> = [
  ['get', '/apps'],
  ['post', '/apps'],
  ['get', '/apps/events'],
  ['get', '/apps/{key}'],
  ['patch', '/apps/{key}'],
  ['post', '/apps/{key}/test'],
  ['get', '/apps/{key}/deliveries'],
  ['post', '/apps/{key}/key'],
  ['get', '/apps/scopes'],
  ['delete', '/apps/{key}/key'],
];

describe("apps-sdk-container review fix 7: Siren's spec serves the app routes that replaced the old ones", () => {
  it.each(REPLACING_ROUTES)('openapi.json serves %s %s', (method, path) => {
    expect(specServes(method, path)).toBe(true);
  });

  it('openapi.json has no /api-keys list and no POST /webhooks, which Siren answers 404 and 405', () => {
    expect(specServes('get', '/api-keys')).toBe(false);
    expect(specServes('post', '/webhooks')).toBe(false);
  });
});
