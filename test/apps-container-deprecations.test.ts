import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { FakeHttpClient } from './http-fakes';

/*
 * Slice C6 item 2: the old key and webhook calls stay, each marked
 * deprecated in its doc comment with the app call that replaces it, since an
 * app holds its key and its address now (docs/architecture/apps-own-parts.md
 * on Siren's int/preview-apps). Siren removes the old routes in slice C5,
 * and these calls go with them.
 */

function source(file: string): string {
  return readFileSync(new URL(`../src/resources/${file}`, import.meta.url), 'utf8');
}

/** The doc comment right above `name(` in the class that starts at `className`. */
function docOf(text: string, className: string, name: string): string {
  const start = text.indexOf(`export class ${className}`);
  expect(start, className).toBeGreaterThan(-1);
  const body = text.slice(start);
  const at = body.search(new RegExp(`\\n  (async )?${name}\\(`));
  expect(at, `${className}.${name}`).toBeGreaterThan(-1);
  const before = body.slice(0, at);
  const open = before.lastIndexOf('/**');
  const close = before.lastIndexOf('*/');
  expect(close, `${className}.${name} has a doc comment`).toBeGreaterThan(open);
  expect(before.slice(close + 2).trim(), `${className}.${name}: the doc comment sits right above it`).toBe('');
  return before.slice(open, close + 2).replace(/\n\s*\* ?/g, ' ');
}

const REPLACED: Array<[string, string, string, string]> = [
  ['api-keys.ts', 'ApiKeysResource', 'create', 'apps.createKey()'],
  ['api-keys.ts', 'ApiKeysResource', 'list', 'apps.list()'],
  ['api-keys.ts', 'ApiKeysResource', 'scopes', 'apps.scopes()'],
  ['api-keys.ts', 'ApiKeysResource', 'revoke', 'apps.revokeKey()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'retrieve', 'apps.retrieve()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'update', 'apps.update()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'test', 'apps.test()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'deliveries', 'apps.deliveries()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'create', 'apps.create()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'events', 'apps.events()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'list', 'apps.list()'],
  ['webhooks.ts', 'WebhookSubscriptionsResource', 'delete', 'apps.update()'],
];

describe('apps-sdk-container: the old key and webhook calls', () => {
  it.each(REPLACED)('%s %s.%s is deprecated and names %s', (file, className, name, replacement) => {
    const doc = docOf(source(file), className, name);
    expect(doc).toMatch(/@deprecated /);
    const deprecation = doc.slice(doc.indexOf('@deprecated'));
    expect(deprecation).toContain(`\`${replacement}`);
    expect(deprecation).toMatch(/an app holds its (key|address)/i);
  });

  it('marks every public method of both old resources, so none is missed', () => {
    const siren = new Siren({ accessToken: 't', baseUrl: 'https://siren.invalid/siren/v1', httpClient: new FakeHttpClient([]) });
    const methods = (value: object) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(value)).filter((key) => key !== 'constructor').sort();
    expect(methods(siren.apiKeys)).toEqual(REPLACED.filter(([, c]) => c === 'ApiKeysResource').map(([, , n]) => n).sort());
    expect(methods(siren.webhooks.subscriptions)).toEqual(
      REPLACED.filter(([, c]) => c === 'WebhookSubscriptionsResource').map(([, , n]) => n).sort(),
    );
  });

  it('leaves the signature checks undeprecated, since an app address receives events signed the same way', () => {
    const text = source('webhooks.ts');
    for (const name of ['constructEvent', 'verifySignature']) {
      expect(docOf(text, 'WebhooksResource', name), name).not.toContain('@deprecated');
    }
  });

  it('the README says the old calls go when Siren removes their routes, and names the app calls', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const note = readme.slice(readme.indexOf('### The old key and webhook calls'));
    expect(note.length).toBeGreaterThan(40);
    const text = note.slice(0, note.indexOf(' #', 4) > 0 ? note.indexOf(' #', 4) : undefined);
    expect(text).toMatch(/deprecated/);
    expect(text).toMatch(/when Siren removes/);
    for (const call of ['siren.apiKeys', 'siren.webhooks.subscriptions', 'apps.createKey()', 'apps.update()', 'apps.deliveries()']) {
      expect(text, call).toContain(call);
    }
  });
});
