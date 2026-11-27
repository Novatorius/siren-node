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

/** Each old key and webhook operation in openapi.yaml, and the app route that replaces it. */
const REPLACED_ROUTES: Array<[string, string]> = [
  ['listWebhookSubscriptions', 'GET /apps'],
  ['listWebhookEventTypes', 'GET /apps/events'],
  ['getWebhookSubscription', 'GET /apps/{key}'],
  ['updateWebhookSubscription', 'PATCH /apps/{key}'],
  ['deleteWebhookSubscription', 'PATCH /apps/{key}'],
  ['sendWebhookTest', 'POST /apps/{key}/test'],
  ['listWebhookDeliveries', 'GET /apps/{key}/deliveries'],
];

/** The text of one operation: from its operationId line to the next operation's. */
function operation(spec: string, id: string): string {
  const start = spec.indexOf(`operationId: ${id}\n`);
  expect(start, id).toBeGreaterThan(-1);
  const next = spec.indexOf('operationId: ', start + 12);
  return spec.slice(start, next === -1 ? undefined : next);
}

describe('apps-sdk-container review fix 7: openapi.yaml marks the old routes deprecated', () => {
  it.each(REPLACED_ROUTES)('%s is deprecated and names %s', (id, route) => {
    const text = operation(read('openapi.yaml'), id);
    expect(text).toMatch(/\n {6}deprecated: true\n/);
    expect(text.replace(/\s+/g, ' ')).toContain(`Deprecated: an app holds its ${id.includes('ApiKey') ? 'key' : 'address'} now. Use \`${route}\``);
  });

  it('marks no app route deprecated', () => {
    const spec = read('openapi.yaml');
    const apps = spec.slice(spec.indexOf('\n  /apps'));
    const ids = [...apps.matchAll(/operationId: (\w+)/g)].map((match) => match[1]!);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids.filter((name) => !REPLACED_ROUTES.some(([old]) => old === name))) {
      expect(operation(spec, id), id).not.toContain('deprecated: true');
    }
  });
});
