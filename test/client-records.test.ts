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
import { CollaboratorAnswers, page, pathOf } from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P10: the Siren client carries the four
 * record resources. Slice 5 edits src/client.ts, so P10 starts only after
 * slice 5 merges into feat/node-commerce-connectors.
 *
 * Every client here gets a FakeHttpClient, and the global fetch fails the
 * test when called, so nothing leaves the machine.
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
  return new Siren({ apiKey: TEST_API_KEY, httpClient: http });
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

  it.skip('sends a record read through the client the caller gave, with its key', async () => {
    const http = new FakeHttpClient([reply(200, page([CollaboratorAnswers.listed]))]);
    const collaborators = Reflect.get(client(http), 'collaborators') as CollaboratorsResource;

    await collaborators.list();

    expect(http.requests).toHaveLength(1);
    expect(pathOf(http.requests[0])).toBe('/collaborators');
    expect(http.requests[0]!.headers['Authorization']).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it.skip('reaches aliases, enrollments and group members through their parents', () => {
    const siren = client(new FakeHttpClient([reply(200, {})]));
    const collaborators = Reflect.get(siren, 'collaborators') as CollaboratorsResource;
    const groups = Reflect.get(siren, 'collaboratorGroups') as CollaboratorGroupsResource;

    expect(collaborators.aliases).toBeDefined();
    expect(collaborators.enrollments).toBeDefined();
    expect(groups.members).toBeDefined();
  });
});
