import { describe, expect, it } from 'vitest';
import { EngagementsResource, NotFoundError, SirenError, UnexpectedResponseError } from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { expectRetried, page, pathOf, queryOf, transportOver } from './record-fakes';
import { EngagementAnswers, notFoundById } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P2: EngagementsResource, the
 * `/engagements` routes. Cases follow the Siren PHP SDK's EngagementsTest
 * (siren-php 0.3.0), with Cloud's answers from test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P2 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, engagements: new EngagementsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new EngagementsResource(transport);

describe('P2: engagements surface', () => {
  it('names the filters list sends', () => {
    expect(EngagementsResource.LIST_FILTERS).toEqual(['status', 'collaboratorId', 'programId', 'opportunityId', 'from', 'to']);
  });

  it('checks the three id filters, each one id or a list', () => {
    expect(EngagementsResource.ID_FILTERS).toEqual({ many: ['collaboratorId', 'programId', 'opportunityId'] });
  });

  it('only reads', () => {
    const engagements = new EngagementsResource(transportOver([reply(200, {})]).transport) as unknown as Record<string, unknown>;

    for (const write of ['create', 'update', 'delete', 'bulk']) expect(engagements[write], write).toBeUndefined();
  });
});

describe('P2: engagements reads', () => {
  it.skip('lists GET /engagements with every filter, a day range and paging', async () => {
    const { http, engagements } = over([reply(200, page([EngagementAnswers.listed], 1, 25))]);

    const list = await engagements.list({
      status: 'active',
      collaboratorId: [4, 5],
      programId: 2,
      opportunityId: 21,
      from: '2026-10-01',
      to: '2026-10-31',
      number: 25,
      orderBy: 'score',
    });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/engagements']);
    expect(queryOf(http.requests[0])).toEqual({
      status: 'active',
      collaboratorId: '4,5',
      programId: '2',
      opportunityId: '21',
      from: '2026-10-01',
      to: '2026-10-31',
      number: '25',
      orderBy: 'score',
    });
    expect([...list]).toEqual([EngagementAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it.skip('retrieves GET /engagements/{id} with fields', async () => {
    const { http, engagements } = over([reply(200, EngagementAnswers.listed)]);

    expect(await engagements.retrieve(31, { fields: 'id,score' })).toEqual(EngagementAnswers.listed);
    expect(pathOf(http.requests[0])).toBe('/engagements/31');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,score' });
  });

  it.skip('raises NotFoundError for an unknown engagement', async () => {
    await expect(over([reply(404, notFoundById)]).engagements.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip('reads the types and calculations from their routes', async () => {
    const { http, engagements } = over([reply(200, EngagementAnswers.types), reply(200, EngagementAnswers.calculations)]);

    expect(await engagements.types()).toEqual(EngagementAnswers.types);
    expect(await engagements.calculations()).toEqual(EngagementAnswers.calculations);
    expect(http.requests.map((request) => [request.method, pathOf(request)])).toEqual([
      ['GET', '/engagements/types'],
      ['GET', '/engagements/calculations'],
    ]);
  });

  it.skip.each([
    ['types', (e: EngagementsResource) => e.types()],
    ['calculations', (e: EngagementsResource) => e.calculations()],
  ])('%s throws UnexpectedResponseError for a 2xx that is not an object', async (_name, call) => {
    await expect(call(over([reply(200, [{ id: 'manual' }])]).engagements)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve(31), reply(200, EngagementAnswers.listed));
    await expectRetried((transport) => resource(transport).types(), reply(200, EngagementAnswers.types));
    await expectRetried((transport) => resource(transport).calculations(), reply(200, EngagementAnswers.calculations));
  });
});

describe('P2: engagements list and id rules', () => {
  it.skip.each([
    ['propertyId', { propertyId: 5 }],
    ['s, which this route does not search', { s: 'flo' }],
    ['a misspelt filter', { programID: 2 }],
    ['a programId that is not a whole number', { programId: '2' }],
    ['a list holding a zero opportunityId', { opportunityId: [21, 0] }],
  ])('list refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, engagements } = over([reply(200, page([]))]);

    const error = await engagements.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('list throws UnexpectedResponseError for a 2xx that is not a list', async () => {
    await expect(over([reply(200, { error: 'Something went wrong.' })]).engagements.list()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it.skip('retrieve refuses an id that is not a positive whole number before sending', async () => {
    const { http, engagements } = over([reply(200, EngagementAnswers.listed)]);

    await expect(engagements.retrieve(0)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
