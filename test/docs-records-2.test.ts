import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Slice 4 acceptance tests for packet P11: the reference docs describe the
 * slice 4 resources. Slice 5 edits README.md, CHANGELOG.md and openapi.yaml,
 * and slice 3's P11 adds its own section, so this P11 starts only after both
 * merge, and after slice 4's P10, since the README names the client fields
 * P10 adds. The parity table has its own tests in test/docs-parity.test.ts,
 * in the same packet.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P11 implementer turns each into `it` and deletes this
 * paragraph.
 */

const HEADING = '## Store credit, mappings and commerce records';

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

/** Sentences, split on a full stop followed by white space. */
function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').split(/(?<=\.)\s/);
}

/** One path block in openapi.yaml, from its key to the next path. */
function path(openapi: string, key: string): string {
  const start = openapi.indexOf(`\n  ${key}:\n`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = openapi.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\/|\n\S/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const ROUTES: Array<[string, string[]]> = [
  ['/conversions', ['get', 'post']],
  ['/conversions/{id}', ['get', 'put', 'delete']],
  ['/conversions/bulk', ['post']],
  ['/conversions/types', ['get']],
  ['/transactions', ['get', 'post']],
  ['/transactions/bulk', ['post']],
  ['/transactions/credit-collaborator', ['post']],
  ['/transactions/sources', ['get']],
  ['/opportunities', ['get']],
  ['/opportunities/{id}', ['get', 'put']],
  ['/engagements', ['get']],
  ['/engagements/{id}', ['get']],
  ['/engagements/types', ['get']],
  ['/engagements/calculations', ['get']],
  ['/distributors', ['get', 'post']],
  ['/distributors/{id}', ['get', 'put', 'delete']],
  ['/distributors/bulk', ['post']],
  ['/distributors/credit-metric', ['post']],
  ['/currencies/custom', ['get', 'post']],
  ['/currencies/custom/{code}', ['put', 'delete']],
  ['/credits/adjust', ['post']],
  ['/credit-balances', ['get']],
  ['/credit-entries', ['get']],
  ['/credit-holds', ['get', 'post']],
  ['/credit-holds/{id}', ['delete']],
  ['/mappings', ['get', 'post', 'delete']],
  ['/configs', ['get']],
];

describe('P11: README slice 4 section', () => {
  it.skip('names each client field and the hold helpers', () => {
    const records = section(read('README.md'), HEADING);

    for (const name of [
      'siren.opportunities',
      'siren.engagements',
      'siren.distributors',
      'siren.customCurrencies',
      'siren.credits',
      'siren.mappings',
      'siren.settings',
      'siren.conversions.create',
      'siren.transactions.create',
      'CreditsResource.holdReference',
      'HoldConflictError',
    ]) {
      expect(records, name).toContain(name);
    }
  });

  it.skip('says placing a hold again for the same checkout replaces it, so the caller may repeat it', () => {
    const all = sentences(section(read('README.md'), HEADING));

    expect(
      all.some((s) => /`placeHold`/.test(s) && /\b(?:replaces?|same token)\b/i.test(s)),
      'a sentence says a repeat placeHold replaces the hold',
    ).toBe(true);
  });

  it.skip('warns never to release the hold of a checkout that became an order', () => {
    const all = sentences(section(read('README.md'), HEADING));

    expect(
      all.some((s) => /`releaseHold`/.test(s) && /\bnever\b/i.test(s) && /\border\b/i.test(s)),
      'a sentence warns against releasing an order hold',
    ).toBe(true);
  });

  it.skip('says every write is sent once and reads retry', () => {
    const all = sentences(section(read('README.md'), HEADING));

    expect(all.some((s) => /\bwrites?\b/i.test(s) && /\bsent once\b/i.test(s))).toBe(true);
    expect(all.some((s) => /\breads?\b/i.test(s) && /\bretr(?:y|ies|ied)\b/i.test(s))).toBe(true);
  });
});

describe('P11: CHANGELOG', () => {
  it.skip('lists the slice 4 resources and taxonomies under Unreleased, Added', () => {
    const added = section(section(read('CHANGELOG.md'), '## [Unreleased]'), '### Added');

    for (const name of [
      'OpportunitiesResource',
      'EngagementsResource',
      'DistributorsResource',
      'CustomCurrenciesResource',
      'CreditsResource',
      'MappingsResource',
      'SettingsResource',
      'ConversionBulkAction',
      'TransactionBulkAction',
      'DistributorBulkAction',
      'CreditHoldStatus',
    ]) {
      expect(added, name).toContain(name);
    }
  });
});

describe('P11: openapi.yaml', () => {
  it.skip.each(ROUTES)('documents %s with each method the SDK sends', (key, methods) => {
    const block = path(read('openapi.yaml'), key);

    for (const method of methods) {
      expect(block, `${key} ${method}`).toMatch(new RegExp(`\\n {4}${method}:\\n`));
    }
  });
});
