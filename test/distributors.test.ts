import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DistributorBulkAction,
  DistributorStatus,
  DistributorsResource,
  NotFoundError,
  PermissionError,
  SirenError,
  UnexpectedResponseError,
  ValidationError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, transportOver } from './record-fakes';
import { DistributorAnswers, notFoundById } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P3: DistributorsResource, the
 * `/distributors` routes. Cases follow the Siren PHP SDK's
 * DistributorsTest (siren-php 0.3.0), with Cloud's answers from
 * test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, distributors: new DistributorsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new DistributorsResource(transport);

const create = {
  name: 'Quarterly pool',
  description: 'Shares two percent of revenue',
  distributionResolver: 'equalShare',
  distributionPoolResolver: 'revenuePercentage',
  status: DistributorStatus.Active,
  units: 'USD',
  revenuePercentage: 2,
  schedule: ['0 0 1 */3 *'],
};

describe('P3: distributors surface', () => {
  it('names the filters list sends', () => {
    expect(DistributorsResource.LIST_FILTERS).toEqual(['status', 's', 'metricType']);
  });

  it('names the bulk actions as Siren does', () => {
    expect(DistributorBulkAction).toEqual({
      Activate: 'activate',
      Deactivate: 'deactivate',
      Restore: 'restore',
      Delete: 'delete',
      PermanentDelete: 'permanent_delete',
    });
  });
});

describe('P3: distributors reads', () => {
  it('lists GET /distributors with status, search, metric type and paging', async () => {
    const { http, distributors } = over([reply(200, page([DistributorAnswers.listed], 1, 50))]);

    const list = await distributors.list({
      status: [DistributorStatus.Active, DistributorStatus.Inactive],
      s: 'pool, monthly',
      metricType: 'manual',
      number: 50,
      orderBy: 'name',
    });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/distributors']);
    expect(queryOf(http.requests[0])).toEqual({
      status: 'active,inactive',
      s: 'pool, monthly',
      metricType: 'manual',
      number: '50',
      orderBy: 'name',
    });
    expect([...list]).toEqual([DistributorAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it('retrieves GET /distributors/{id} with fields', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.listed)]);

    expect(await distributors.retrieve(7, { fields: 'id,name' })).toEqual(DistributorAnswers.listed);
    expect(pathOf(http.requests[0])).toBe('/distributors/7');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,name' });
  });

  it('raises NotFoundError for an unknown distributor', async () => {
    await expect(over([reply(404, notFoundById)]).distributors.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve(7), reply(200, DistributorAnswers.listed));
  });
});

describe('P3: distributors writes', () => {
  it('creates with POST /distributors and answers the distributor', async () => {
    const { http, distributors } = over([reply(201, DistributorAnswers.created)]);

    expect(await distributors.create(create)).toEqual(DistributorAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/distributors']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it('updates with PUT /distributors/{id}, sending only the given fields', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.updated)]);

    expect(await distributors.update(7, { status: DistributorStatus.Inactive })).toEqual(DistributorAnswers.updated);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/distributors/7']);
    expect(bodyOf(http.requests[0])).toEqual({ status: 'inactive' });
  });

  it('deletes in two stages: the distributor marked deleted, then null', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.softDeleted), reply(204)]);

    expect(await distributors.delete(7)).toEqual(DistributorAnswers.softDeleted);
    expect(await distributors.delete(7)).toBeNull();
    expect(http.requests.map((request) => [request.method, pathOf(request)])).toEqual([
      ['DELETE', '/distributors/7'],
      ['DELETE', '/distributors/7'],
    ]);
  });

  it('runs a bulk action with POST /distributors/bulk', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.bulk)]);

    expect(await distributors.bulk(DistributorBulkAction.Restore, [7, 8])).toEqual(DistributorAnswers.bulk);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/distributors/bulk']);
    expect(http.requests[0]!.body).toBe('{"action":"restore","ids":[7,8]}');
  });

  it('raises a blocked permanent delete as ConflictError', async () => {
    const error = await over([reply(409, DistributorAnswers.permanentDeleteBlocked)])
      .distributors.bulk(DistributorBulkAction.PermanentDelete, [7])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toBe(DistributorAnswers.permanentDeleteBlocked.error);
  });

  it('raises the Essentials gate as PermissionError with its code', async () => {
    const error = await over([reply(403, DistributorAnswers.planRequired)])
      .distributors.create(create)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).code).toBe('plan_required');
  });

  it('throws UnexpectedResponseError when create answers no object', async () => {
    await expect(over([reply(201, [DistributorAnswers.created])]).distributors.create(create)).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, DistributorAnswers.created));
    await expectSentOnce((transport) => resource(transport).update(7, { name: 'x' }), reply(200, DistributorAnswers.updated));
    await expectSentOnce((transport) => resource(transport).delete(7), reply(204));
    await expectSentOnce(
      (transport) => resource(transport).bulk(DistributorBulkAction.Delete, [7]),
      reply(200, DistributorAnswers.bulk),
    );
    await expectSentOnce((transport) => resource(transport).creditMetric(4, 10), reply(200, DistributorAnswers.credited));
  });
});

describe('P3: distributors creditMetric', () => {
  it('credits with POST /distributors/credit-metric and answers what was and was not credited', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.credited)]);

    expect(await distributors.creditMetric(4)).toEqual(DistributorAnswers.credited);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/distributors/credit-metric']);
    expect(http.requests[0]!.body).toBe('{"collaboratorId":4}');
  });

  it('sends points when they are given', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.credited)]);

    await distributors.creditMetric(4, 25);

    expect(http.requests[0]!.body).toBe('{"collaboratorId":4,"points":25}');
  });

  it('raises nothing credited as ValidationError, and an unknown collaborator as NotFoundError', async () => {
    await expect(over([reply(422, DistributorAnswers.nothingCredited)]).distributors.creditMetric(4)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(over([reply(404, DistributorAnswers.collaboratorNotFound)]).distributors.creditMetric(99)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it.each([
    ['a zero collaborator', (d: DistributorsResource) => d.creditMetric(0)],
    ['zero points', (d: DistributorsResource) => d.creditMetric(4, 0)],
    ['fractional points', (d: DistributorsResource) => d.creditMetric(4, 1.5)],
    ['points over the limit', (d: DistributorsResource) => d.creditMetric(4, 1_000_000_000_001)],
    ['points that are not a number', (d: DistributorsResource) => d.creditMetric(4, '10' as unknown as number)],
  ])('creditMetric refuses %s with SirenError before sending', async (_label, call) => {
    const { http, distributors } = over([reply(200, DistributorAnswers.credited)]);

    await expect(call(distributors)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it('accepts the largest points Siren takes', async () => {
    const { http, distributors } = over([reply(200, DistributorAnswers.credited)]);

    await distributors.creditMetric(4, 1_000_000_000_000);

    expect(bodyOf(http.requests[0])).toEqual({ collaboratorId: 4, points: 1_000_000_000_000 });
  });
});

describe('P3: distributors list and id rules', () => {
  it.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { metrictype: 'manual' }],
  ])('list refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, distributors } = over([reply(200, page([]))]);

    const error = await distributors.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it('list throws UnexpectedResponseError for a 2xx that is not a list', async () => {
    await expect(over([reply(200, { error: 'Something went wrong.' })]).distributors.list()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it.each([
    ['retrieve', (d: DistributorsResource) => d.retrieve(0)],
    ['update', (d: DistributorsResource) => d.update(-1, { name: 'x' })],
    ['delete', (d: DistributorsResource) => d.delete(Number.NaN)],
    ['bulk, no ids', (d: DistributorsResource) => d.bulk(DistributorBulkAction.Delete, [])],
    ['bulk, a bad id', (d: DistributorsResource) => d.bulk(DistributorBulkAction.Delete, [0])],
    ['bulk, 501 ids', (d: DistributorsResource) => d.bulk(DistributorBulkAction.Delete, Array.from({ length: 501 }, (_, i) => i + 1))],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, distributors } = over([reply(200, DistributorAnswers.listed)]);

    await expect(call(distributors)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
