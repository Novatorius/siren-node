import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, WebhookEventType } from '../src/index';

/*
 * Slice 1 acceptance tests for packet P8: the reference docs describe every
 * wire change in this slice. `openapi.yaml` is the API reference this
 * repository ships, so each new field, route, event and code must appear in
 * it, and the CHANGELOG and README must name each new public method and class.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else here.
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
  // Up to and including the newline before the next schema or section.
  const next = rest.slice(1).search(/\n {2,4}\S/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

/**
 * One property of a schema, from its key to the next key at the same depth.
 * Properties sit 8 spaces in, under the schema's `properties:`, so a word in a
 * description or an example never counts as the property.
 */
function property(block: string, name: string): string | null {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`        ${name}:`));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^ {0,8}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function hasProperty(block: string, name: string): boolean {
  return property(block, name) !== null;
}

/** The text of the `## [Unreleased]` section. */
function unreleased(): string {
  const changelog = read('CHANGELOG.md');
  const start = changelog.indexOf('## [Unreleased]');
  const end = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, end < 0 ? undefined : end);
}

describe('P8: openapi.yaml', () => {
  it('SalePayload documents the test flag and LineItem documents lineId', () => {
    expect(hasProperty(schema('SalePayload'), 'test')).toBe(true);
    expect(hasProperty(schema('LineItem'), 'lineId')).toBe(true);
  });

  it('RefundPayload documents amount, currency, lines, whole and kind, and RefundLine its four fields', () => {
    const refund = schema('RefundPayload');
    for (const property of ['refundId', 'amount', 'currency', 'lines', 'whole', 'kind']) {
      expect(hasProperty(refund, property), property).toBe(true);
    }
    const line = schema('RefundLine');
    for (const property of ['lineId', 'sku', 'quantity', 'amount']) {
      expect(hasProperty(line, property), property).toBe(true);
    }
  });

  it('SiteVisitedPayload documents the tracking code form of collaboratorId', () => {
    expect(property(schema('SiteVisitedPayload'), 'collaboratorId')).toContain('tracking:');
  });

  it('WebhookEventType lists every event this SDK knows', () => {
    const block = schema('WebhookEventType');
    for (const value of Object.values(WebhookEventType)) {
      const listed = block.includes(`- ${value}\n`) || block.includes(`- '${value}'\n`);
      expect(listed, value).toBe(true);
    }
  });

  it('documents GET /webhooks/events and GET /api-keys/scopes', () => {
    expect(openapi).toMatch(/\n {2}\/webhooks\/events:\n {4}get:/);
    expect(openapi).toMatch(/\n {2}\/api-keys\/scopes:\n {4}get:/);
  });

  it('lists every error code Siren sends in an ErrorCode schema', () => {
    const block = schema('ErrorCode');
    for (const code of Object.values(ErrorCode)) {
      expect(block.includes(`- ${code}\n`), code).toBe(true);
    }
  });
});

describe('P8: CHANGELOG and README', () => {
  it('the Unreleased section names each new public method, class and field', () => {
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

  it('the README shows a test sale, a partial refund and both catalog reads', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/test:\s*true/);
    expect(readme).toMatch(/lines:\s*\[/);
    expect(readme).toContain('subscriptions.events()');
    expect(readme).toContain('apiKeys.scopes()');
  });
});

describe('P10: CHANGELOG and README', () => {
  /** A document's sentences, with line breaks and indents folded to one space. */
  function sentences(text: string): string[] {
    return text.replace(/\s+/g, ' ').split(/(?<=\.) /);
  }

  /** A sentence that says custom events, event ingestion or events.ingest retry, with no negation. */
  function claimsIngestRetries(sentence: string): boolean {
    const retries = /(\bcustom events?\b|\bevent ingestion\b|`events\.ingest`)[^.]*\b(auto-?)?retr(y|ies|ied|ying)\b/i;
    return retries.test(sentence) && !/\b(never|not|no longer)\b/i.test(sentence);
  }

  it.skip('say events.ingest and a sale with no externalId are sent once, and never that custom events retry', () => {
    for (const [name, text] of [
      ['README.md', read('README.md')],
      ['CHANGELOG Unreleased', unreleased()],
    ] as const) {
      const all = sentences(text);
      for (const sentence of all) {
        expect(claimsIngestRetries(sentence), `${name}: ${sentence}`).toBe(false);
      }
      expect(
        all.some((s) => /`events\.ingest`[^.]*\bsent once\b/.test(s)),
        `${name} says events.ingest is sent once`,
      ).toBe(true);
      expect(
        all.some((s) => /\bsale\b[^.]*\b(with no|without an?)\s+`externalId`[^.]*\bsent once\b/i.test(s)),
        `${name} says a sale with no externalId is sent once`,
      ).toBe(true);
    }
  });
});
