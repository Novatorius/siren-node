import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  OpportunitiesResource,
  OpportunityStatus,
  PolicyError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, transportOver } from './record-fakes';
import { OpportunityAnswers, notFoundById } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P1: OpportunitiesResource, the
 * `/opportunities` routes. Cases follow the Siren PHP SDK's
 * OpportunitiesTest (siren-php 0.3.0), with Cloud's answers from
 * test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P1 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, opportunities: new OpportunitiesResource(built.transport) };
}

const resource = (transport: HttpTransport) => new OpportunitiesResource(transport);

describe('P1: opportunities surface', () => {
  it('names the filters list sends', () => {
    expect(OpportunitiesResource.LIST_FILTERS).toEqual(['status', 'collaboratorId']);
  });

  it('takes one collaboratorId, as Siren reads only one', () => {
    expect(OpportunitiesResource.ID_FILTERS).toEqual({ one: ['collaboratorId'] });
  });

  it('has no create, delete or bulk call, since Siren opens opportunities itself', () => {
    const opportunities = new OpportunitiesResource(transportOver([reply(200, {})]).transport) as unknown as Record<string, unknown>;

    expect(opportunities.create).toBeUndefined();
    expect(opportunities.delete).toBeUndefined();
    expect(opportunities.bulk).toBeUndefined();
  });
});

describe('P1: opportunities reads', () => {
  it.skip('lists GET /opportunities with status, collaboratorId and paging', async () => {
    const { http, opportunities } = over([reply(200, page([OpportunityAnswers.listed], 1, 20))]);

    const list = await opportunities.list({
      status: [OpportunityStatus.Active, OpportunityStatus.Inactive],
      collaboratorId: 4,
      number: 20,
      orderBy: 'lastTriggered',
      order: 'DESC',
    });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/opportunities']);
    expect(queryOf(http.requests[0])).toEqual({
      status: 'active,inactive',
      collaboratorId: '4',
      number: '20',
      orderBy: 'lastTriggered',
      order: 'DESC',
    });
    expect([...list]).toEqual([OpportunityAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it.skip('retrieves GET /opportunities/{id} with fields', async () => {
    const { http, opportunities } = over([reply(200, OpportunityAnswers.listed)]);

    expect(await opportunities.retrieve(21, { fields: 'id,status' })).toEqual(OpportunityAnswers.listed);
    expect(pathOf(http.requests[0])).toBe('/opportunities/21');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,status' });
  });

  it.skip('raises NotFoundError for an unknown opportunity', async () => {
    await expect(over([reply(404, notFoundById)]).opportunities.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip("raises a connected site's unfiltered list as PolicyError", async () => {
    const error = await over([reply(403, OpportunityAnswers.siteFilterRequired)])
      .opportunities.list()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe('site_filter_required');
  });

  it.skip('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve(21), reply(200, OpportunityAnswers.listed));
  });
});

describe('P1: opportunities update', () => {
  it.skip('updates with PUT /opportunities/{id}, sending only the given fields, and answers the stored record', async () => {
    const { http, opportunities } = over([reply(200, OpportunityAnswers.updated)]);

    expect(await opportunities.update(21, { status: 'inactive' })).toEqual(OpportunityAnswers.updated);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/opportunities/21']);
    expect(bodyOf(http.requests[0])).toEqual({ status: 'inactive' });
  });

  it.skip('raises NotFoundError for an unknown opportunity on update', async () => {
    await expect(over([reply(404, notFoundById)]).opportunities.update(99, { status: 'active' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it.skip('sends update once', async () => {
    await expectSentOnce((transport) => resource(transport).update(21, { status: 'active' }), reply(200, OpportunityAnswers.updated));
  });

  it.skip('throws UnexpectedResponseError when an update answers no object', async () => {
    await expect(over([reply(200, [OpportunityAnswers.updated])]).opportunities.update(21, { status: 'active' })).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});

describe('P1: opportunities list and id rules', () => {
  it.skip.each([
    ['id, which Siren ignores for an organization', { id: 21 }],
    ['s, which Siren ignores for an organization', { s: 'flo' }],
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { collaboratorID: 4 }],
    ['a list of collaborators, which Siren would read as the first', { collaboratorId: [4, 5] }],
    ['a collaboratorId that is not a whole number', { collaboratorId: '4abc' }],
    ['an empty status list', { status: [] }],
  ])('list refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, opportunities } = over([reply(200, page([]))]);

    const error = await opportunities.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('list throws UnexpectedResponseError for a 2xx that is not a list, never an empty page', async () => {
    await expect(over([reply(200, { error: 'Something went wrong.' })]).opportunities.list()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it.skip.each([
    ['retrieve', (o: OpportunitiesResource) => o.retrieve(0)],
    ['update', (o: OpportunitiesResource) => o.update(-1, { status: 'active' })],
    ['update, a fraction', (o: OpportunitiesResource) => o.update(1.5, { status: 'active' })],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, opportunities } = over([reply(200, OpportunityAnswers.listed)]);

    await expect(call(opportunities)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
