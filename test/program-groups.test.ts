import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  NotFoundError,
  PermissionError,
  ProgramGroupBulkAction,
  ProgramGroupSorter,
  ProgramGroupsResource,
  SirenError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { ProgramGroupAnswers, bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, transportOver } from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P9: ProgramGroupsResource, the
 * `/program-groups` routes. Cases follow the Siren PHP SDK's
 * ProgramGroupsTest at 59383e6, with Cloud's answers from
 * test/record-fakes.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P9 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, groups: new ProgramGroupsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new ProgramGroupsResource(transport);

const create = {
  name: 'Partners',
  description: 'Partner programs',
  sorter: ProgramGroupSorter.NewestBindingWins,
  programs: [1, 2],
};

describe('P9: programGroups surface', () => {
  it('names the sorters and the bulk action as Siren does', () => {
    expect(ProgramGroupSorter).toEqual({ OldestBindingWins: 'oldestBindingWins', NewestBindingWins: 'newestBindingWins' });
    expect(ProgramGroupBulkAction).toEqual({ Delete: 'delete' });
  });
});

describe('P9: programGroups reads', () => {
  it.skip('lists GET /program-groups with filters and answers the page', async () => {
    const { http, groups } = over([reply(200, page([ProgramGroupAnswers.listed], 1))]);

    const list = await groups.list({ sorter: ProgramGroupSorter.NewestBindingWins, s: 'part', orderBy: 'name' });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/program-groups']);
    expect(queryOf(http.requests[0])).toEqual({ sorter: 'newestBindingWins', s: 'part', orderBy: 'name' });
    expect([...list]).toEqual([ProgramGroupAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it.skip('retrieves GET /program-groups/{id} with fields', async () => {
    const { http, groups } = over([reply(200, ProgramGroupAnswers.listed)]);

    expect(await groups.retrieve(3, { fields: ['id', 'programIds'] })).toEqual(ProgramGroupAnswers.listed);
    expect(pathOf(http.requests[0])).toBe('/program-groups/3');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,programIds' });
  });

  it.skip('raises NotFoundError for the empty 404 of an unknown group', async () => {
    await expect(over([reply(404)]).groups.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve(3), reply(200, ProgramGroupAnswers.listed));
  });
});

describe('P9: programGroups writes', () => {
  it.skip('creates with POST /program-groups and answers the group', async () => {
    const { http, groups } = over([reply(201, ProgramGroupAnswers.created)]);

    expect(await groups.create(create)).toEqual(ProgramGroupAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/program-groups']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it.skip('updates with PUT /program-groups/{id}', async () => {
    const { http, groups } = over([reply(200, ProgramGroupAnswers.updated)]);

    expect(await groups.update(3, { sorter: ProgramGroupSorter.OldestBindingWins })).toEqual(ProgramGroupAnswers.updated);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/program-groups/3']);
    expect(bodyOf(http.requests[0])).toEqual({ sorter: 'oldestBindingWins' });
  });

  it.skip('deletes with DELETE /program-groups/{id} and answers null for the 204', async () => {
    const { http, groups } = over([reply(204)]);

    expect(await groups.delete(3)).toBeNull();
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['DELETE', '/program-groups/3']);
  });

  it.skip('runs the delete bulk action with POST /program-groups/bulk', async () => {
    const { http, groups } = over([reply(200, ProgramGroupAnswers.bulk)]);

    expect(await groups.bulk(ProgramGroupBulkAction.Delete, [3])).toEqual(ProgramGroupAnswers.bulk);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/program-groups/bulk']);
    expect(http.requests[0]!.body).toBe('{"action":"delete","ids":[3]}');
  });

  it.skip('raises the plan gate as PermissionError with plan_required', async () => {
    const error = await over([reply(403, ProgramGroupAnswers.planRequired)])
      .groups.create(create)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).code).toBe(ErrorCode.PlanRequired);
  });

  it.skip('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, ProgramGroupAnswers.created));
    await expectSentOnce((transport) => resource(transport).update(3, { name: 'x' }), reply(200, ProgramGroupAnswers.updated));
    await expectSentOnce((transport) => resource(transport).delete(3), reply(204));
    await expectSentOnce(
      (transport) => resource(transport).bulk(ProgramGroupBulkAction.Delete, [3]),
      reply(200, ProgramGroupAnswers.bulk),
    );
  });

  it.skip.each([
    ['retrieve', (g: ProgramGroupsResource) => g.retrieve(0)],
    ['update', (g: ProgramGroupsResource) => g.update(-1, { name: 'x' })],
    ['delete', (g: ProgramGroupsResource) => g.delete(1.5)],
    ['bulk', (g: ProgramGroupsResource) => g.bulk(ProgramGroupBulkAction.Delete, [])],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, groups } = over([reply(200, ProgramGroupAnswers.listed)]);

    await expect(call(groups)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
