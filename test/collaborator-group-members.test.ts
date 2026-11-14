import { describe, expect, it } from 'vitest';
import {
  CollaboratorGroupMembersResource,
  CollaboratorGroupsResource,
  NotFoundError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import {
  bodyOf,
  expectRetried,
  expectSentOnce,
  GroupAnswers,
  malformedSuccess,
  page,
  pathOf,
  queryOf,
  transportOver,
} from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P7: CollaboratorGroupMembersResource,
 * the `/collaborator-groups/{id}/members` routes. Cases follow the Siren PHP
 * SDK's CollaboratorGroupsTest::testMemberRoutes at 59383e6, with Cloud's
 * answers from test/record-fakes.ts.
 *
 * Integration shape, per "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568): the real resource, reached through a real
 * CollaboratorGroupsResource, over the real HttpTransport, with a
 * FakeHttpClient at the HttpClient seam.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, members: new CollaboratorGroupsResource(built.transport).members };
}

const resource = (transport: HttpTransport) => new CollaboratorGroupMembersResource(transport);

describe('P7: members.list', () => {
  it('reads GET /collaborator-groups/{id}/members with filters and paging, and answers the page', async () => {
    const { http, members } = over([reply(200, page([GroupAnswers.member], 1, 100))]);

    const list = await members.list(5, { collaboratorId: 42, perPage: 100 });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/collaborator-groups/5/members']);
    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '42', number: '100' });
    expect([...list]).toEqual([GroupAnswers.member]);
    expect(list.estimatedCount).toBe(1);
  });

  it('retries like a read', async () => {
    await expectRetried((transport) => resource(transport).list(5), reply(200, page([])));
  });
});

describe('P7: members writes', () => {
  const input = [{ collaboratorId: 42, metadata: { level: 'L1' } }];

  it('adds with POST and answers the rows Siren added', async () => {
    const { http, members } = over([reply(200, [GroupAnswers.member])]);

    expect(await members.add(5, input)).toEqual([GroupAnswers.member]);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/collaborator-groups/5/members']);
    expect(bodyOf(http.requests[0])).toEqual({ members: input });
  });

  it('answers an empty list when nobody was new', async () => {
    expect(await over([reply(200, [])]).members.add(5, input)).toEqual([]);
  });

  it('sets with PUT, an empty list included, and answers the whole set', async () => {
    const { http, members } = over([reply(200, [GroupAnswers.member]), reply(200, [])]);

    expect(await members.set(5, input)).toEqual([GroupAnswers.member]);
    expect(await members.set(5, [])).toEqual([]);
    expect(http.requests.map((request) => [request.method, pathOf(request), bodyOf(request)])).toEqual([
      ['PUT', '/collaborator-groups/5/members', { members: input }],
      ['PUT', '/collaborator-groups/5/members', { members: [] }],
    ]);
  });

  it('removes one member with DELETE and answers null for the 204', async () => {
    const { http, members } = over([reply(204)]);

    expect(await members.remove(5, 42)).toBeNull();
    expect([http.requests[0]!.method, pathOf(http.requests[0]), http.requests[0]!.body]).toEqual([
      'DELETE',
      '/collaborator-groups/5/members/42',
      undefined,
    ]);
  });

  it('raises the 404 for a collaborator who is not a member as NotFoundError', async () => {
    await expect(over([reply(404, GroupAnswers.memberNotFound)]).members.remove(5, 43)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).add(5, input), reply(200, [GroupAnswers.member]));
    await expectSentOnce((transport) => resource(transport).set(5, input), reply(200, [GroupAnswers.member]));
    await expectSentOnce((transport) => resource(transport).remove(5, 42), reply(204));
  });

  it.each([
    ['list, group', (m: CollaboratorGroupMembersResource) => m.list(0)],
    ['add, group', (m: CollaboratorGroupMembersResource) => m.add(0, input)],
    ['add, no members', (m: CollaboratorGroupMembersResource) => m.add(5, [])],
    ['add, a bad collaborator', (m: CollaboratorGroupMembersResource) => m.add(5, [{ collaboratorId: 0 }])],
    ['add, a member that is not an object', (m: CollaboratorGroupMembersResource) => m.add(5, [42 as never])],
    ['add, a null member', (m: CollaboratorGroupMembersResource) => m.add(5, [null as never])],
    ['set, group', (m: CollaboratorGroupMembersResource) => m.set(-1, [])],
    ['set, a bad collaborator', (m: CollaboratorGroupMembersResource) => m.set(5, [{ collaboratorId: 1.5 }])],
    ['set, members that are not a list', (m: CollaboratorGroupMembersResource) => m.set(5, {} as never)],
    ['remove, group', (m: CollaboratorGroupMembersResource) => m.remove(0, 42)],
    ['remove, collaborator', (m: CollaboratorGroupMembersResource) => m.remove(5, 0)],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, members } = over([reply(200, [])]);

    await expect(call(members)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('P7: members list and retrieve rules', () => {
  it('names the filters list sends', () => {
    expect(CollaboratorGroupMembersResource.LIST_FILTERS).toEqual(['collaboratorId']);
    expect(CollaboratorGroupMembersResource.ID_FILTERS).toEqual({ many: ['collaboratorId'] });
  });

  it.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { programID: 2 }],
    ['an empty collaborator list', { collaboratorId: [] }],
    ['a collaborator id of 0', { collaboratorId: 0 }],
  ])('list refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, members } = over([reply(200, page([]))]);

    const error = await members.list(5, params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it('list throws UnexpectedResponseError for a 2xx that is not a list, never an empty page', async () => {
    const { members } = over([reply(200, malformedSuccess)]);

    await expect(members.list(5)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
