import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppsResource } from '../src/resources/apps';

/*
 * Slice C6: the architecture note names every app call the slice adds, and
 * the mutation list holds a caught break for each numbered item beside the
 * four controls the runner needs.
 */

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('apps-sdk-container: the note and the mutation list', () => {
  it('the note names each call on apps and apps.items, and the claims it closes', () => {
    const note = read('docs/architecture/apps-sdk-container.md');
    const calls = Object.getOwnPropertyNames(AppsResource.prototype).filter((name) => name !== 'constructor');
    for (const call of ['create', 'update', 'createKey', 'rotateKey', 'revokeKey', 'rotateSecret', 'test', 'deliveries', 'events', 'scopes', 'kinds']) {
      expect(calls, call).toContain(call);
      expect(note, call).toContain(`apps.${call}(`);
    }
    expect(note).toContain('apps.items.create');
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
  });
});
