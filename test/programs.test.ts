import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  ProgramBulkAction,
  ProgramStatus,
  ProgramsResource,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { ProgramAnswers, bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, transportOver } from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P8: ProgramsResource, the `/programs`
 * routes. Cases follow the Siren PHP SDK's ProgramsTest at 59383e6, with
 * Cloud's answers from test/record-fakes.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P8 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, programs: new ProgramsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new ProgramsResource(transport);

const create = {
  name: 'Affiliates',
  description: 'Ten percent of each sale',
  incentiveType: 'saleTransactionPercentage',
  incentiveResolverType: 'newestBindingWins',
  units: 'USD',
  status: ProgramStatus.Active,
  engagementTypes: { referredSiteVisit: { calculationType: 'fixed', calculationArgs: { value: 10 } } },
};

describe('P8: programs surface', () => {
  it('names the bulk actions as Siren does', () => {
    expect(ProgramBulkAction).toEqual({
      Activate: 'activate',
      Deactivate: 'deactivate',
      Restore: 'restore',
      Delete: 'delete',
      PermanentDelete: 'permanent_delete',
    });
  });
});

describe('P8: programs reads', () => {
  it.skip('lists GET /programs with filters, the group filter and paging', async () => {
    const { http, programs } = over([reply(200, page([ProgramAnswers.listed], 1, 50))]);

    const list = await programs.list({ status: ProgramStatus.Active, units: ['USD', 'PTS'], programGroupId: 2, number: 50 });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/programs']);
    expect(queryOf(http.requests[0])).toEqual({ status: 'active', units: 'USD,PTS', programGroupId: '2', number: '50' });
    expect([...list]).toEqual([ProgramAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it.skip('retrieves GET /programs/{id} with fields', async () => {
    const { http, programs } = over([reply(200, ProgramAnswers.listed)]);

    expect(await programs.retrieve(1, { fields: 'id,name' })).toEqual(ProgramAnswers.listed);
    expect(pathOf(http.requests[0])).toBe('/programs/1');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,name' });
  });

  it.skip('raises NotFoundError for an unknown program', async () => {
    await expect(over([reply(404, ProgramAnswers.notFound)]).programs.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip('reads the status types, incentive types and currency types from their routes', async () => {
    const { http, programs } = over([
      reply(200, ProgramAnswers.statusTypes),
      reply(200, ProgramAnswers.incentiveTypes),
      reply(200, ProgramAnswers.currencyTypes),
    ]);

    expect(await programs.statusTypes()).toEqual(ProgramAnswers.statusTypes);
    expect(await programs.incentiveTypes()).toEqual(ProgramAnswers.incentiveTypes);
    expect(await programs.currencyTypes()).toEqual(ProgramAnswers.currencyTypes);
    expect(http.requests.map((request) => [request.method, pathOf(request)])).toEqual([
      ['GET', '/programs/status-types'],
      ['GET', '/programs/incentive-types'],
      ['GET', '/programs/currency-types'],
    ]);
  });

  it.skip('refuses a currency answer that is not a list', async () => {
    await expect(over([reply(200, { USD: 'US Dollar' })]).programs.currencyTypes()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it.skip('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve(1), reply(200, ProgramAnswers.listed));
    await expectRetried((transport) => resource(transport).statusTypes(), reply(200, ProgramAnswers.statusTypes));
    await expectRetried((transport) => resource(transport).incentiveTypes(), reply(200, ProgramAnswers.incentiveTypes));
    await expectRetried((transport) => resource(transport).currencyTypes(), reply(200, ProgramAnswers.currencyTypes));
  });
});

describe('P8: programs writes', () => {
  it.skip('creates with POST /programs and answers the program', async () => {
    const { http, programs } = over([reply(201, ProgramAnswers.created)]);

    expect(await programs.create(create)).toEqual(ProgramAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/programs']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it.skip('updates with PUT /programs/{id}, sending only the given fields', async () => {
    const { http, programs } = over([reply(200, ProgramAnswers.updated)]);

    expect(await programs.update(1, { status: ProgramStatus.Inactive })).toEqual(ProgramAnswers.updated);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/programs/1']);
    expect(bodyOf(http.requests[0])).toEqual({ status: 'inactive' });
  });

  it.skip('deletes in two stages: the program marked deleted, then null', async () => {
    const { http, programs } = over([reply(200, ProgramAnswers.softDeleted), reply(204)]);

    expect(await programs.delete(1)).toEqual(ProgramAnswers.softDeleted);
    expect(await programs.delete(1)).toBeNull();
    expect(http.requests.map((request) => [request.method, pathOf(request)])).toEqual([
      ['DELETE', '/programs/1'],
      ['DELETE', '/programs/1'],
    ]);
  });

  it.skip('raises a blocked permanent delete as ConflictError', async () => {
    await expect(over([reply(409, ProgramAnswers.deleteBlocked)]).programs.delete(1)).rejects.toBeInstanceOf(ConflictError);
  });

  it.skip('runs a bulk action with POST /programs/bulk', async () => {
    const { http, programs } = over([reply(200, ProgramAnswers.bulk)]);

    expect(await programs.bulk(ProgramBulkAction.Deactivate, [1, 2])).toEqual(ProgramAnswers.bulk);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/programs/bulk']);
    expect(http.requests[0]!.body).toBe('{"action":"deactivate","ids":[1,2]}');
  });

  it.skip('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, ProgramAnswers.created));
    await expectSentOnce((transport) => resource(transport).update(1, { name: 'x' }), reply(200, ProgramAnswers.updated));
    await expectSentOnce((transport) => resource(transport).delete(1), reply(204));
    await expectSentOnce((transport) => resource(transport).bulk(ProgramBulkAction.Delete, [1]), reply(200, ProgramAnswers.bulk));
  });

  it.skip.each([
    ['retrieve', (p: ProgramsResource) => p.retrieve(0)],
    ['update', (p: ProgramsResource) => p.update(-1, { name: 'x' })],
    ['delete', (p: ProgramsResource) => p.delete(Number.NaN)],
    ['bulk, no ids', (p: ProgramsResource) => p.bulk(ProgramBulkAction.Delete, [])],
    ['bulk, a bad id', (p: ProgramsResource) => p.bulk(ProgramBulkAction.Delete, [0])],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, programs } = over([reply(200, ProgramAnswers.listed)]);

    await expect(call(programs)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
