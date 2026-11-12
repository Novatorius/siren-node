import { describe, expect, it } from 'vitest';
import {
  CollaboratorGroupMembersResource,
  CollaboratorGroupsResource,
  ErrorCode,
  NotFoundError,
  PermissionError,
  PolicyError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import {
  bodyOf,
  emptyNotFound,
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
 * Slice 3 acceptance tests for packet P6: CollaboratorGroupsResource, the
 * `/collaborator-groups` routes. Cases follow the Siren PHP SDK's
 * CollaboratorGroupsTest at 59383e6, with Cloud's answers from
 * test/record-fakes.ts.
 *
 * Integration shape, per "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, groups: new CollaboratorGroupsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new CollaboratorGroupsResource(transport);

describe('P6: collaboratorGroups surface', () => {
  it('carries the members resource', () => {
    expect(over([reply(200, {})]).groups.members).toBeInstanceOf(CollaboratorGroupMembersResource);
  });
});

describe('P6: collaboratorGroups reads', () => {
  it('lists GET /collaborator-groups with filters and answers the page', async () => {
    const { http, groups } = over([reply(200, page([GroupAnswers.listed], 1))]);

    const list = await groups.list({ structure: 'flat', s: 'vip', orderBy: 'name', order: 'ASC' });

    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborator-groups');
    expect(queryOf(http.requests[0])).toEqual({ structure: 'flat', s: 'vip', orderBy: 'name', order: 'ASC' });
    expect([...list]).toEqual([GroupAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it('retrieves GET /collaborator-groups/{id} with fields', async () => {
    const { http, groups } = over([reply(200, GroupAnswers.listed)]);

    expect(await groups.retrieve(7, { fields: ['id', 'memberCount'] })).toEqual(GroupAnswers.listed);
    expect(pathOf(http.requests[0])).toBe('/collaborator-groups/7');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,memberCount' });
  });

  it('raises NotFoundError for the empty 404 of an unknown group', async () => {
    await expect(over([emptyNotFound()]).groups.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads the structures', async () => {
    const { http, groups } = over([reply(200, GroupAnswers.structures)]);

    expect(await groups.structures()).toEqual(GroupAnswers.structures);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/collaborator-groups/structures']);
  });

  it('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve(7), reply(200, GroupAnswers.listed));
    await expectRetried((transport) => resource(transport).structures(), reply(200, GroupAnswers.structures));
  });
});

describe('P6: collaboratorGroups writes', () => {
  const create = { name: 'Sales Team', structure: 'flat', members: [{ collaboratorId: 8 }] };

  it('creates with POST /collaborator-groups and answers the group', async () => {
    const { http, groups } = over([reply(201, GroupAnswers.created)]);

    expect(await groups.create(create)).toEqual(GroupAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/collaborator-groups']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it('updates with PUT /collaborator-groups/{id} and answers the group', async () => {
    const { http, groups } = over([reply(200, GroupAnswers.updated)]);

    expect(await groups.update(7, { name: 'Sales Reps' })).toEqual(GroupAnswers.updated);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/collaborator-groups/7']);
    expect(bodyOf(http.requests[0])).toEqual({ name: 'Sales Reps' });
  });

  it('deletes with DELETE /collaborator-groups/{id} and answers null for the 204', async () => {
    const { http, groups } = over([reply(204)]);

    expect(await groups.delete(7)).toBeNull();
    expect([http.requests[0]!.method, pathOf(http.requests[0]), http.requests[0]!.body]).toEqual([
      'DELETE',
      '/collaborator-groups/7',
      undefined,
    ]);
  });

  it('raises the plan gate as a PermissionError that is not a PolicyError', async () => {
    const error = await over([reply(403, GroupAnswers.planRequired)])
      .groups.create(create)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PermissionError);
    expect(error).not.toBeInstanceOf(PolicyError);
    expect((error as PermissionError).code).toBe(ErrorCode.PlanRequired);
  });

  it('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, GroupAnswers.created));
    await expectSentOnce((transport) => resource(transport).update(7, { name: 'x' }), reply(200, GroupAnswers.updated));
    await expectSentOnce((transport) => resource(transport).delete(7), reply(204));
  });

  it.each([
    ['retrieve', (g: CollaboratorGroupsResource) => g.retrieve(0)],
    ['update', (g: CollaboratorGroupsResource) => g.update(-1, { name: 'x' })],
    ['delete', (g: CollaboratorGroupsResource) => g.delete(1.5)],
  ])('%s refuses a bad id with SirenError and sends nothing', async (_name, call) => {
    const { http, groups } = over([reply(200, GroupAnswers.listed)]);

    await expect(call(groups)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('P6: collaboratorGroups list and retrieve rules', () => {
  it('names the filters list sends', () => {
    expect(CollaboratorGroupsResource.LIST_FILTERS).toEqual(['structure', 's']);
  });

  it.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { programID: 2 }],
    ['an empty structure list', { structure: [] }],
  ])('list refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, groups } = over([reply(200, page([]))]);

    const error = await groups.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it('list throws UnexpectedResponseError for a 2xx that is not a list, never an empty page', async () => {
    const { groups } = over([reply(200, malformedSuccess)]);

    await expect(groups.list()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('retrieve sends include and propertyId the way every retrieve does', async () => {
    const { http, groups } = over([reply(200, GroupAnswers.listed)]);

    await groups.retrieve(7, { fields: 'id', include: 'extended', propertyId: 3 });

    expect(queryOf(http.requests[0])).toEqual({ fields: 'id', include: 'extended', propertyId: '3' });
  });

  it('retrieve throws UnexpectedResponseError for a 2xx that is not an object', async () => {
    const { groups } = over([reply(200, [GroupAnswers.listed])]);

    await expect(groups.retrieve(7)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
