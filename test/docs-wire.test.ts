import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, WebhookEventType } from '../src/index';

/*
 * Slice 1 acceptance tests for packet P8: the reference docs describe every
 * wire change in this slice. `openapi.yaml` is the API reference this
 * repository ships, so each new field, route, event and code must appear in
 * it, and the CHANGELOG and README must name each new public method and class.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to packet P8. Its
 * implementer turns `it.skip(` into `it(` and changes nothing else here.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

const openapi = read('openapi.yaml');

/** One schema under `components.schemas`, from its name to the next schema. */
function schema(name: string): string {
  const start = openapi.indexOf(`\n    ${name}:\n`);
  expect(start, `schema ${name}`).toBeGreaterThan(-1);
  const rest = openapi.slice(start + 1);
  const next = rest.slice(1).search(/\n {2,4}\S/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function hasProperty(block: string, property: string): boolean {
  return new RegExp(`^\\s+${property}:`, 'm').test(block);
}

/** The text of the `## [Unreleased]` section. */
function unreleased(): string {
  const changelog = read('CHANGELOG.md');
  const start = changelog.indexOf('## [Unreleased]');
  const end = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, end < 0 ? undefined : end);
}

describe('P8: openapi.yaml', () => {
  it.skip('SalePayload documents the test flag and LineItem documents lineId', () => {
    expect(hasProperty(schema('SalePayload'), 'test')).toBe(true);
    expect(hasProperty(schema('LineItem'), 'lineId')).toBe(true);
  });

  it.skip('RefundPayload documents amount, currency, lines, whole and kind, and RefundLine its four fields', () => {
    const refund = schema('RefundPayload');
    for (const property of ['refundId', 'amount', 'currency', 'lines', 'whole', 'kind']) {
      expect(hasProperty(refund, property), property).toBe(true);
    }
    const line = schema('RefundLine');
    for (const property of ['lineId', 'sku', 'quantity', 'amount']) {
      expect(hasProperty(line, property), property).toBe(true);
    }
  });

  it.skip('SiteVisitedPayload documents the tracking code form of collaboratorId', () => {
    expect(schema('SiteVisitedPayload')).toContain('tracking:');
  });

  it.skip('WebhookEventType lists every event this SDK knows', () => {
    const block = schema('WebhookEventType');
    for (const value of Object.values(WebhookEventType)) {
      const listed = block.includes(`- ${value}\n`) || block.includes(`- '${value}'\n`);
      expect(listed, value).toBe(true);
    }
  });

  it.skip('documents GET /webhooks/events and GET /api-keys/scopes', () => {
    expect(openapi).toMatch(/\n {2}\/webhooks\/events:\n {4}get:/);
    expect(openapi).toMatch(/\n {2}\/api-keys\/scopes:\n {4}get:/);
  });

  it.skip('names every error code Siren sends', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(openapi, code).toContain(code);
    }
  });
});

describe('P8: CHANGELOG and README', () => {
  it.skip('the Unreleased section names each new public method, class and field', () => {
    const section = unreleased();
    for (const name of [
      'subscriptions.events()',
      'apiKeys.scopes()',
      'SiteDisconnectedError',
      'PolicyError',
      'CodeConflictError',
      'HoldConflictError',
      'UnexpectedResponseError',
      'isKnownErrorCode',
      'RefundLine',
      'lineId',
      'TrackingCodeReference',
      'EventStatus',
      'EventReason',
    ]) {
      expect(section, name).toContain(name);
    }
  });

  it.skip('the README shows a test sale, a partial refund and both catalog reads', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/test:\s*true/);
    expect(readme).toMatch(/lines:\s*\[/);
    expect(readme).toContain('subscriptions.events()');
    expect(readme).toContain('apiKeys.scopes()');
  });
});
