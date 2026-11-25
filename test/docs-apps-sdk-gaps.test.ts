import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { specBodyFields, specQuery, specServes } from './spec-routes';

/*
 * apps-sdk-gaps docs: the README, the CHANGELOG and Siren's openapi.json describe
 * the calls the slice added, as each slice of the Node connectors work pins
 * its own docs (test/docs-records-2.test.ts, test/docs-connect.test.ts).
 * The parity table rows for these calls have their own tests in
 * test/docs-parity.test.ts.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

/** The text from a heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.split(' ')[0]!;
  const rest = markdown.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Each route the slice calls, the methods the SDK sends, and the scope an API key needs. */
const ROUTES: Array<[string, string, string]> = [
  ['/payouts/{id}', 'get', 'ledger:payouts:read'],
  ['/fulfillments', 'get', 'ledger:fulfillments:read'],
  ['/fulfillments/{id}', 'get', 'ledger:fulfillments:read'],
  ['/webhooks/{id}', 'get', 'webhook-subscriptions:read'],
  ['/webhooks/{id}', 'put', 'webhook-subscriptions:manage'],
  ['/webhooks/{id}/test', 'post', 'webhook-subscriptions:manage'],
  ['/webhooks/{id}/deliveries', 'get', 'webhook-subscriptions:read'],
];

describe("apps-sdk-gaps docs: openapi.json, Siren's spec", () => {
  it.each(ROUTES)('serves %s %s, which an API key reaches with %s', (key, method) => {
    expect(specServes(method, key), `${key} ${method}`).toBe(true);
  });

  it('names the fulfillment filters list() sends', () => {
    const query = specQuery('get', '/fulfillments');
    for (const filter of ['status', 'payoutStatus', 'currency', 'from', 'to', 'orderBy']) {
      expect(query, filter).toContain(filter);
    }
  });

  it('names the four fields PUT /webhooks/{id} reads', () => {
    expect(specBodyFields('put', '/webhooks/{id}').sort()).toEqual(['description', 'events', 'status', 'targetUrl']);
  });
});

describe('apps-sdk-gaps docs: CHANGELOG', () => {
  it('names each new call, resource, scope list and type under Unreleased, Added', () => {
    const added = section(section(read('CHANGELOG.md'), '## [Unreleased]'), '### Added');

    for (const name of [
      'payouts.retrieve',
      'PayoutsResource',
      'FulfillmentsResource',
      'webhooks.subscriptions.retrieve',
      'webhooks.subscriptions.update',
      'webhooks.subscriptions.test',
      'webhooks.subscriptions.deliveries',
      'ApiKeyRecordScope',
      'API_KEY_RECORD_SCOPES',
      'Payout',
      'Fulfillment',
      'FulfillmentPayout',
      'FulfillmentListParams',
      'UpdateWebhookSubscriptionParams',
      'WebhookTestResult',
      'WebhookDelivery',
    ]) {
      expect(added, name).toContain(`\`${name}\``);
    }
  });

  it('names each new route under Unreleased, Added', () => {
    const added = section(section(read('CHANGELOG.md'), '## [Unreleased]'), '### Added');

    for (const [key, method] of ROUTES) {
      expect(added, `${method} ${key}`).toContain(`${method.toUpperCase()} ${key}`);
    }
  });
});

describe('apps-sdk-gaps docs: README', () => {
  it('describes each new subscription call, and that it takes a session', () => {
    const webhooks = section(read('README.md'), '### Check and change a subscription');

    for (const name of ['retrieve(id)', 'deliveries(id)', 'update(id, params)', 'test(id)']) {
      expect(webhooks, name).toContain(`\`${name}\``);
    }
    // Siren retired the webhook scopes: every /webhooks route takes a session (pass 4 follow-ups).
    expect(webhooks).not.toContain('webhook-subscriptions:');
    expect(webhooks).toContain('ApiKeyNotAcceptedError');
    expect(webhooks).toMatch(/sent\s+once/);
  });

  it('names every record scope group and the new scopes in the API key section', () => {
    const scopes = section(read('README.md'), '## API key scopes');

    for (const name of ['ApiKeyRecordScope', 'API_KEY_RECORD_SCOPES', 'ledger:fulfillments:read']) {
      expect(scopes, name).toContain(name);
    }
  });
});
