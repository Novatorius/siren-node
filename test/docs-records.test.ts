import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Slice 3 acceptance tests for packet P11: the reference docs describe the
 * record resources. Slice 5 edits README.md, CHANGELOG.md and openapi.yaml,
 * so P11 starts only after slice 5 merges into feat/node-commerce-connectors,
 * and after P10, since the README names the client fields P10 adds.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P11 implementer turns each into `it` and deletes this
 * paragraph.
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
  ['/collaborators', ['get', 'post']],
  ['/collaborators/{id}', ['get', 'put', 'delete']],
  ['/collaborators/bulk', ['post']],
  ['/collaborators/status-types', ['get']],
  ['/collaborators/generate-referral-code', ['get']],
  ['/collaborator-aliases', ['get', 'post', 'delete']],
  ['/collaborator-programs', ['get', 'post', 'delete']],
  ['/collaborator-groups', ['get', 'post']],
  ['/collaborator-groups/structures', ['get']],
  ['/collaborator-groups/{id}', ['get', 'put', 'delete']],
  ['/collaborator-groups/{id}/members', ['get', 'post', 'put']],
  ['/collaborator-groups/{id}/members/{collaboratorId}', ['delete']],
  ['/programs', ['get', 'post']],
  ['/programs/{id}', ['get', 'put', 'delete']],
  ['/programs/bulk', ['post']],
  ['/programs/status-types', ['get']],
  ['/programs/incentive-types', ['get']],
  ['/programs/currency-types', ['get']],
  ['/program-groups', ['get', 'post']],
  ['/program-groups/{id}', ['get', 'put', 'delete']],
  ['/program-groups/bulk', ['post']],
];

describe('P11: README records section', () => {
  it.skip('names each client field and the nested resources', () => {
    const records = section(read('README.md'), '## Collaborators and programs');

    for (const name of [
      'siren.collaborators',
      'siren.collaborators.aliases',
      'siren.collaborators.enrollments',
      'siren.collaboratorGroups',
      'siren.collaboratorGroups.members',
      'siren.programs',
      'siren.programGroups',
      'PropertyQualifier',
      'CodeConflictError',
    ]) {
      expect(records, name).toContain(name);
    }
  });

  it.skip('says record writes are sent once and reads retry', () => {
    const all = sentences(section(read('README.md'), '## Collaborators and programs'));

    expect(
      all.some((s) => /\bwrites?\b/i.test(s) && /\bsent once\b/i.test(s)),
      'a sentence says a record write is sent once',
    ).toBe(true);
    expect(
      all.some((s) => /\breads?\b/i.test(s) && /\bretr(?:y|ies|ied)\b/i.test(s)),
      'a sentence says a record read retries',
    ).toBe(true);
  });

  it.skip('tells a caller with its own durable queue to build the client with maxRetries: 0', () => {
    const all = sentences(section(read('README.md'), '## Collaborators and programs'));

    expect(
      all.some((s) => /\bqueue\b/i.test(s) && /`maxRetries: 0`/.test(s)),
      'a sentence names the queue and maxRetries: 0',
    ).toBe(true);
  });

  it.skip('says a connected site may change only the name and nickname, with updateDetails', () => {
    const all = sentences(section(read('README.md'), '## Collaborators and programs'));

    expect(
      all.some((s) => /`updateDetails`/.test(s) && /`fullName`/.test(s) && /`nickname`/.test(s)),
      'a sentence names updateDetails and its two fields',
    ).toBe(true);
  });
});

describe('P11: README list rules', () => {
  it.skip('says a record list refuses a key Siren would ignore, before sending', () => {
    const all = sentences(section(read('README.md'), '## Collaborators and programs'));

    expect(
      all.some((s) => /\blists?\b/i.test(s) && /\bkeys?\b/i.test(s) && /`SirenError`/.test(s)),
      'a sentence says a list throws SirenError for a key it does not send',
    ).toBe(true);
  });

  it.skip('says an empty filter list throws rather than answer every record', () => {
    const all = sentences(section(read('README.md'), '## Collaborators and programs'));

    expect(
      all.some((s) => /\bempty\b/i.test(s) && /\blists?\b/i.test(s) && /`SirenError`/.test(s)),
      'a sentence says an empty filter list throws SirenError',
    ).toBe(true);
  });
});

describe('P11: CHANGELOG', () => {
  it.skip('lists the record resources under Unreleased, Added', () => {
    const added = section(section(read('CHANGELOG.md'), '## [Unreleased]'), '### Added');

    for (const name of [
      'CollaboratorsResource',
      'CollaboratorAliasesResource',
      'ProgramEnrollmentsResource',
      'CollaboratorGroupsResource',
      'CollaboratorGroupMembersResource',
      'ProgramsResource',
      'ProgramGroupsResource',
      'PropertyQualifier',
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
