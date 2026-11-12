import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CollaboratorGroupsResource,
  CollaboratorsResource,
  ProgramGroupsResource,
  ProgramsResource,
  Siren,
} from '../src/index';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';
import { BASE, CollaboratorAnswers, page, pathOf } from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P10: the Siren client carries the four
 * record resources. Slice 5 edits src/client.ts, so P10 starts only after
 * slice 5 merges into feat/node-commerce-connectors.
 *
 * Every client here gets a FakeHttpClient, the reserved base URL
 * https://example.invalid, and a global fetch that fails the test when
 * called, so nothing leaves the machine.
 *
 * The fields are read with Reflect.get so this file compiles before P10 adds
 * them to the Siren class.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P10 implementer turns each into `it` and deletes this
 * paragraph.
 */

beforeEach(failOnGlobalFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function client(http: FakeHttpClient): Siren {
  return new Siren({ apiKey: TEST_API_KEY, httpClient: http, baseUrl: BASE });
}

describe('P10: the Siren client carries the record resources', () => {
  it.skip.each([
    ['collaborators', 'CollaboratorsResource', CollaboratorsResource],
    ['collaboratorGroups', 'CollaboratorGroupsResource', CollaboratorGroupsResource],
    ['programs', 'ProgramsResource', ProgramsResource],
    ['programGroups', 'ProgramGroupsResource', ProgramGroupsResource],
  ] as const)('siren.%s is a %s', (field, _name, type) => {
    expect(Reflect.get(client(new FakeHttpClient([reply(200, {})])), field)).toBeInstanceOf(type);
  });

  it.skip('sends a read from every record resource, nested ones included, through the client the caller gave, with its key', async () => {
    const http = new FakeHttpClient([reply(200, page([]))]);
    const siren = client(http);
    const collaborators = Reflect.get(siren, 'collaborators') as CollaboratorsResource;
    const collaboratorGroups = Reflect.get(siren, 'collaboratorGroups') as CollaboratorGroupsResource;
    const programs = Reflect.get(siren, 'programs') as ProgramsResource;
    const programGroups = Reflect.get(siren, 'programGroups') as ProgramGroupsResource;

    await collaborators.list();
    await collaborators.aliases.query();
    await collaborators.enrollments.list();
    await collaboratorGroups.list();
    await collaboratorGroups.members.list(5);
    await programs.list();
    await programGroups.list();

    expect(http.requests.map((request) => pathOf(request))).toEqual([
      '/collaborators',
      '/collaborator-aliases',
      '/collaborator-programs',
      '/collaborator-groups',
      '/collaborator-groups/5/members',
      '/programs',
      '/program-groups',
    ]);
    for (const request of http.requests) {
      expect(new URL(request.url).origin).toBe(new URL(BASE).origin);
      expect(request.headers['Authorization']).toBe(`Bearer ${TEST_API_KEY}`);
    }
  });
});
