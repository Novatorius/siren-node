import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Pass 4 follow-up: the README stops teaching routes Siren no longer serves.
 *
 * Siren feat/apps, docs/api/api-keys.md: "Siren Cloud has no separate
 * `/api-keys` routes. `GET /api-keys`, `POST /api-keys`, `GET /api-keys/scopes`
 * and `DELETE /api-keys/{id}` answer `404`." docs/api/webhooks-api.md: "Siren
 * Cloud has no `POST /webhooks` route. It answers `405`." docs/api/auth-api-keys.md:
 * the `webhook-subscriptions:*` scopes are retired, and no API key may use any
 * `/webhooks` route or `/apps` route (401 `api_key_not_accepted`).
 *
 * The parity table keeps a row for each PHP method (docs-parity.test.ts), and
 * "The old key and webhook calls" says what happened to them. Nowhere else
 * names them.
 */

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The text under `heading`, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`README has no "${heading}"`);
  const level = heading.split(' ')[0]!.length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The README with the parity table and the old-calls section cut out. */
function outsideTheOldCalls(): string {
  let text = README;
  for (const heading of ['## Parity with the PHP SDK', '### The old key and webhook calls']) {
    text = text.replace(section(text, heading), '\n');
  }
  return text;
}

const DEAD_CALLS = ['apiKeys.', 'webhooks.subscriptions.create'];
const RETIRED_SCOPES = [
  'webhook-subscriptions:read',
  'webhook-subscriptions:manage',
  'WebhookSubscriptionsRead',
  'WebhookSubscriptionsManage',
  'WebhooksRead',
  'WebhooksManage',
];

describe('pass 4 follow-up: routes Siren no longer serves', () => {
  it('names the key calls and webhooks.subscriptions.create() only where it says they are gone', () => {
    const text = outsideTheOldCalls();
    for (const call of DEAD_CALLS) {
      expect(text.includes(call), `${call} outside the old-calls section`).toBe(false);
    }
  });

  it('names a retired webhook scope only in a paragraph that says it is retired', () => {
    const paragraphs = outsideTheOldCalls().split(/\n\s*\n/);
    for (const paragraph of paragraphs) {
      const named = RETIRED_SCOPES.filter((scope) => paragraph.includes(scope));
      if (named.length === 0) continue;
      expect(paragraph, `${named.join(', ')} in:\n${paragraph}`).toMatch(/retired/);
    }
  });

  it('says what Siren answers for the old calls, and what replaces them', () => {
    const old = section(README, '### The old key and webhook calls');
    expect(old).toContain('404');
    expect(old).toContain('405');
    for (const call of ['apps.create()', 'apps.update()', 'apps.createKey()', 'apps.rotateKey()', 'apps.revokeKey()', 'apps.scopes()']) {
      expect(old, call).toContain(`\`${call}\``);
    }
  });

  it('marks each dead call in the parity table with what Siren answers', () => {
    const table = section(README, '## Parity with the PHP SDK');
    const rows = table.split('\n').filter((line) => line.startsWith('| `$siren->apiKeys->') || line.startsWith('| `$siren->webhooks->subscriptions->create()`'));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row, row).toMatch(/\b40[45]\b/);
    }
  });

  it('gives an app its address through the apps calls, with a signed-in session', () => {
    const quickstart = section(README, '## Quickstart: verify a webhook');
    for (const name of ['apps.create(', 'apps.update(', 'apps.events()', 'apps.deliveries(', 'apps.test(', 'siren apps apply']) {
      expect(quickstart, name).toContain(name);
    }
    expect(quickstart).toMatch(/signed-in session/);
  });

  it('says the remaining subscription calls take a session and refuse an API key', () => {
    const check = section(README, '### Check and change a subscription');
    expect(check).toMatch(/signed-in session/);
    expect(check).toContain('ApiKeyNotAcceptedError');
  });
});
