import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, WebhookEventType } from '../src/index';
import { specServes } from './spec-routes';

/*
 * Slice 1 acceptance tests for packet P8: the reference docs describe every
 * wire change in this slice. Siren's generated openapi.json is the API
 * reference this repository ships, so each route the slice reads must be in
 * it, and the CHANGELOG and README must name each new public method and class.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

/** The text of the `## [Unreleased]` section. */
function unreleased(): string {
  const changelog = read('CHANGELOG.md');
  const start = changelog.indexOf('## [Unreleased]');
  const end = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, end < 0 ? undefined : end);
}

describe("P8: openapi.json, Siren's spec", () => {
  it('serves GET /webhooks/events and GET /apps/scopes, the two catalog reads', () => {
    expect(specServes('get', '/webhooks/events')).toBe(true);
    expect(specServes('get', '/apps/scopes')).toBe(true);
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

  it('say events.ingest and a sale with no externalId are sent once, and never that custom events retry', () => {
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
