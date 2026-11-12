import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  CodeConflictError,
  CollaboratorAliasesResource,
  CollaboratorAliasType,
  CollaboratorsResource,
  ConflictError,
  ErrorCode,
  PolicyError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import {
  CollaboratorAnswers,
  bodyOf,
  expectRetried,
  expectSentOnce,
  page,
  pathOf,
  queryOf,
  transportOver,
} from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P4: CollaboratorAliasesResource, the
 * `/collaborator-aliases` routes and the collaborator record's own code
 * fields. Cases follow the Siren PHP SDK's CollaboratorAliasRoutesTest and
 * CollaboratorAliasesTest at 59383e6, with Cloud's answers from
 * test/record-fakes.ts.
 *
 * Integration shape, per "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568): the real resource, reached through a real
 * CollaboratorsResource, over the real HttpTransport, with a FakeHttpClient
 * at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P4 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, aliases: new CollaboratorsResource(built.transport).aliases };
}

const resource = (transport: HttpTransport) => new CollaboratorAliasesResource(transport);

describe('P4: aliases surface', () => {
  it('names the route and its filters', () => {
    expect(CollaboratorAliasesResource.PATH).toBe('/collaborator-aliases');
    expect(CollaboratorAliasesResource.QUERY_FILTERS).toEqual(['code', 'type', 'collaboratorId']);
    expect(CollaboratorAliasesResource.ID_FILTERS).toEqual({ many: ['collaboratorId'] });
  });
});

describe('P4: aliases.query', () => {
  it.skip('reads GET /collaborator-aliases with filters, sorting and paging, and answers plain records', async () => {
    const { http, aliases } = over([
      reply(200, page([CollaboratorAnswers.alias, CollaboratorAnswers.dashboardAlias], 2, 20, 20)),
    ]);

    const list = await aliases.query({
      code: 'SAVE10',
      type: ['coupon', 'tracking'],
      collaboratorId: 4,
      orderBy: 'code',
      order: 'ASC',
      page: 2,
      perPage: 20,
    });

    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborator-aliases');
    expect(queryOf(http.requests[0])).toEqual({
      code: 'SAVE10',
      type: 'coupon,tracking',
      collaboratorId: '4',
      orderBy: 'code',
      order: 'ASC',
      number: '20',
      offset: '20',
    });
    expect([...list]).toEqual([
      { code: 'SAVE10', type: 'coupon', collaboratorId: 4, dateIssued: '2026-10-16 12:00:00', propertyId: 5 },
      { code: 'FLO', type: 'tracking', collaboratorId: 4, dateIssued: '2026-01-15 10:30:00', propertyId: null },
    ]);
    expect(list.estimatedCount).toBe(2);
  });

  it.skip('trims each code it sends', async () => {
    const { http, aliases } = over([reply(200, page([]))]);

    await aliases.query({ code: [' SAVE10 ', 'VIP '] });

    expect(queryOf(http.requests[0])).toEqual({ code: 'SAVE10,VIP' });
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => resource(transport).query(), reply(200, page([CollaboratorAnswers.alias])));
  });

  it.skip('throws UnexpectedResponseError for a 2xx that is not a list', async () => {
    const { aliases } = over([reply(200, { error: 'Something went wrong.' })]);

    await expect(aliases.query()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('P4: aliases.findByCode and forCollaborator', () => {
  it.skip('asks for the newest holder of the code under the plain type', async () => {
    const { http, aliases } = over([reply(200, page([CollaboratorAnswers.alias], 1, 1))]);

    expect(await aliases.findByCode(' SAVE10 ', 'coupon')).toEqual({
      code: 'SAVE10',
      type: 'coupon',
      collaboratorId: 4,
      dateIssued: '2026-10-16 12:00:00',
      propertyId: 5,
    });
    expect(pathOf(http.requests[0])).toBe('/collaborator-aliases');
    expect(queryOf(http.requests[0])).toEqual({
      code: 'SAVE10',
      type: 'coupon',
      number: '1',
      orderBy: 'dateIssued',
      order: 'DESC',
    });
  });

  it.skip('asks for a collaborator newest code of one type', async () => {
    const { http, aliases } = over([reply(200, page([CollaboratorAnswers.dashboardAlias], 1, 1))]);

    expect(await aliases.forCollaborator(4, CollaboratorAliasType.Tracking)).toEqual({
      code: 'FLO',
      type: 'tracking',
      collaboratorId: 4,
      dateIssued: '2026-01-15 10:30:00',
      propertyId: null,
    });
    expect(queryOf(http.requests[0])).toEqual({
      collaboratorId: '4',
      type: 'tracking',
      number: '1',
      orderBy: 'dateIssued',
      order: 'DESC',
    });
  });

  it.skip('answers null when nobody holds the code', async () => {
    const { aliases } = over([reply(200, page([]))]);

    expect(await aliases.findByCode('NOPE', 'coupon')).toBeNull();
    expect(await aliases.forCollaborator(4, 'coupon')).toBeNull();
  });

  it.skip('reads an integration coupon type as given', async () => {
    const { http, aliases } = over([reply(200, page([]))]);

    expect(await aliases.findByCode('SAVE10', 'coupon@source:wc')).toBeNull();
    expect(queryOf(http.requests[0])).toMatchObject({ code: 'SAVE10', type: 'coupon@source:wc' });
  });

  it.skip('throws UnexpectedResponseError for a list answer of the wrong shape, never null', async () => {
    const { aliases } = over([reply(200, { items: { code: 'SAVE10' } })]);

    await expect(aliases.findByCode('SAVE10', 'coupon')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip.each([
    ['no type', { code: 'SAVE10', collaboratorId: 4, dateIssued: '2026-10-16 12:00:00' }],
    ['a numeric type', { code: 'SAVE10', type: 5, collaboratorId: 4, dateIssued: '2026-10-16 12:00:00' }],
  ])('findByCode and query throw UnexpectedResponseError for a code row with %s', async (_label, row) => {
    const { aliases } = over([reply(200, page([row], 1, 1))]);

    await expect(aliases.findByCode('SAVE10', 'coupon')).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(aliases.query()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('retries both like reads', async () => {
    await expectRetried((transport) => resource(transport).findByCode('SAVE10', 'coupon'), reply(200, page([])));
    await expectRetried((transport) => resource(transport).forCollaborator(4, 'coupon'), reply(200, page([])));
  });
});

describe('P4: aliases.create', () => {
  it.skip('posts the trimmed code and the plain type, and answers the plain record', async () => {
    const { http, aliases } = over([reply(201, CollaboratorAnswers.alias)]);

    expect(await aliases.create(' SAVE10 ', 'coupon', 4)).toEqual({
      code: 'SAVE10',
      type: 'coupon',
      collaboratorId: 4,
      dateIssued: '2026-10-16 12:00:00',
      propertyId: 5,
    });
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/collaborator-aliases');
    expect(bodyOf(http.requests[0])).toEqual({ code: 'SAVE10', type: 'coupon', collaboratorId: 4 });
  });

  it.skip('raises CodeConflictError from the 409 Siren answers for a held code, after one send', async () => {
    const { http, aliases } = over([reply(409, CollaboratorAnswers.codeHeld), reply(201, CollaboratorAnswers.alias)]);

    const error = await aliases.create(' SAVE10 ', 'coupon', 4).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CodeConflictError);
    expect(error).toBeInstanceOf(ConflictError);
    const conflict = error as CodeConflictError;
    expect(conflict.statusCode).toBe(409);
    expect(conflict.code).toBe(ErrorCode.CodeHeld);
    expect(conflict.message).toBe('That code is already held for this type.');
    expect(conflict.conflictingCode).toBe('SAVE10');
    expect(conflict.type).toBe('coupon');
    expect(conflict.cause).toBeInstanceOf(ConflictError);
    expect(conflict.cause).not.toBeInstanceOf(CodeConflictError);
    expect(http.requests).toHaveLength(1);
  });

  it.skip('passes a refusal that is not a conflict through unchanged', async () => {
    const { aliases } = over([reply(403, CollaboratorAnswers.programNotOnSite)]);

    const error = await aliases.create('SAVE10', 'coupon', 4).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect(error).not.toBeInstanceOf(CodeConflictError);
  });

  it.skip('is sent once', async () => {
    await expectSentOnce((transport) => resource(transport).create('SAVE10', 'coupon', 4), reply(201, CollaboratorAnswers.alias));
  });
});

describe('P4: aliases.free', () => {
  it.skip('deletes one code of one type by query, with no body', async () => {
    const { http, aliases } = over([reply(200, CollaboratorAnswers.freed)]);

    expect(await aliases.free(' SAVE10 ', 'coupon')).toEqual({ deleted: true });
    expect(http.requests[0]!.method).toBe('DELETE');
    expect(pathOf(http.requests[0])).toBe('/collaborator-aliases');
    expect(queryOf(http.requests[0])).toEqual({ code: 'SAVE10', type: 'coupon' });
    expect(http.requests[0]!.body).toBeUndefined();
  });

  it.skip('raises a site refusal as PolicyError', async () => {
    const { aliases } = over([reply(403, CollaboratorAnswers.userTypeNotAllowed)]);

    const error = await aliases.free('SAVE10', 'user').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).param).toBe('type');
  });

  it.skip('is sent once', async () => {
    await expectSentOnce((transport) => resource(transport).free('SAVE10', 'coupon'), reply(200, CollaboratorAnswers.freed));
  });
});

describe('P4: aliases on the collaborator record', () => {
  it.skip('lists the record aliases field', async () => {
    const entries = [
      { code: 'FLO', type: 'tracking', issuedDate: '2026-01-15T10:30:00+00:00' },
      { code: 'SAVE10', type: 'coupon', issuedDate: '2026-10-16T12:00:00+00:00' },
    ];
    const { http, aliases } = over([reply(200, { id: 4, aliases: entries })]);

    expect(await aliases.list(4)).toEqual(entries);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,aliases' });
  });

  it.skip('answers an empty list when the record has an empty aliases field', async () => {
    const { aliases } = over([reply(200, { id: 4, aliases: [] })]);

    expect(await aliases.list(4)).toEqual([]);
  });

  it.skip.each([
    ['no aliases field', { id: 4 }],
    ['an aliases field that is not a list', { id: 4, aliases: { code: 'FLO' } }],
    ['an entry that is a string', { id: 4, aliases: [{ code: 'FLO', type: 'tracking' }, 'junk'] }],
    ['an entry that is null', { id: 4, aliases: [null] }],
  ])('list throws UnexpectedResponseError for %s, never a shorter list', async (_label, body) => {
    const { aliases } = over([reply(200, body)]);

    const error = await aliases.list(4).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect((error as UnexpectedResponseError).message).toContain('aliases');
    expect((error as UnexpectedResponseError).message).toContain('4');
  });

  it.skip('reads the referral code, or null when it is null or empty', async () => {
    const { http, aliases } = over([
      reply(200, { id: 4, referralCode: 'FLO' }),
      reply(200, { id: 4, referralCode: null }),
      reply(200, { id: 4, referralCode: '' }),
    ]);

    expect(await aliases.trackingCode(4)).toBe('FLO');
    expect(await aliases.trackingCode(4)).toBeNull();
    expect(await aliases.trackingCode(4)).toBeNull();
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,referralCode' });
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
  });

  it.skip.each([
    ['no referralCode field', { id: 4 }],
    ['a numeric referralCode', { id: 4, referralCode: 5 }],
    ['a referralCode list', { id: 4, referralCode: ['FLO'] }],
  ])('trackingCode throws UnexpectedResponseError for %s, never null', async (_label, body) => {
    const { aliases } = over([reply(200, body)]);

    const error = await aliases.trackingCode(4).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect((error as UnexpectedResponseError).message).toContain('referralCode');
    expect((error as UnexpectedResponseError).message).toContain('4');
  });

  it.skip('puts the trimmed tracking code as trackingId and answers the collaborator', async () => {
    const { http, aliases } = over([reply(200, CollaboratorAnswers.updated)]);

    expect(await aliases.setTrackingCode(4, ' ADA2 ')).toEqual(CollaboratorAnswers.updated);
    expect(http.requests[0]!.method).toBe('PUT');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(bodyOf(http.requests[0])).toEqual({ trackingId: 'ADA2' });
  });

  it.skip('raises the 400 for a code another collaborator holds as BadRequestError', async () => {
    const { aliases } = over([reply(400, CollaboratorAnswers.trackingTaken)]);

    const error = await aliases.setTrackingCode(4, 'TAKEN').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).fieldErrors[0]?.field).toBe('trackingId');
  });

  it.skip('retries the reads and sends setTrackingCode once', async () => {
    await expectRetried((transport) => resource(transport).list(4), reply(200, { id: 4, aliases: [] }));
    await expectRetried((transport) => resource(transport).trackingCode(4), reply(200, { id: 4, referralCode: 'FLO' }));
    await expectSentOnce((transport) => resource(transport).setTrackingCode(4, 'ADA2'), reply(200, CollaboratorAnswers.updated));
  });
});

describe('P4: aliases refuse bad input before sending', () => {
  const malformed = ['', 'coupon@property:5', 'coupon,tracking', 'coupon ', 'coupon\n', 'cupón'];

  it.skip.each(malformed)('every method that takes a type refuses %j', async (type) => {
    const { http, aliases } = over([reply(200, page([]))]);
    const calls: Array<() => Promise<unknown>> = [
      () => aliases.findByCode('SAVE10', type),
      () => aliases.forCollaborator(4, type),
      () => aliases.query({ type }),
      () => aliases.query({ type: ['coupon', type] }),
      () => aliases.create('SAVE10', type, 4),
      () => aliases.free('SAVE10', type),
    ];

    for (const call of calls) {
      const error = await call().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it.skip('every method that takes a type accepts an integration coupon type', async () => {
    const { http, aliases } = over([reply(200, page([])), reply(200, page([])), reply(200, page([])), reply(201, CollaboratorAnswers.alias), reply(200, CollaboratorAnswers.freed)]);

    await aliases.findByCode('SAVE10', 'coupon@source:wc');
    await aliases.forCollaborator(4, 'coupon@source:wc');
    await aliases.query({ type: 'coupon@source:wc' });
    await aliases.create('SAVE10', 'coupon@source:wc', 4);
    await aliases.free('SAVE10', 'coupon@source:wc');

    expect(http.requests).toHaveLength(5);
    expect(bodyOf(http.requests[3])).toEqual({ code: 'SAVE10', type: 'coupon@source:wc', collaboratorId: 4 });
    expect(queryOf(http.requests[4])).toEqual({ code: 'SAVE10', type: 'coupon@source:wc' });
  });

  it.skip('refuses an empty type or code list and a type that is not a string', async () => {
    const { http, aliases } = over([reply(200, page([]))]);

    await expect(aliases.query({ type: [] })).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.query({ code: [] })).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.query({ type: 5 } as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { collaboratorID: 4 }],
    ['an empty collaborator list', { collaboratorId: [] }],
    ['a text collaborator id', { collaboratorId: '4' }],
  ])('query refuses %s with SirenError naming the key', async (_label, params) => {
    const { http, aliases } = over([reply(200, page([]))]);

    const error = await aliases.query(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('every method that takes a code refuses one with a comma', async () => {
    const { http, aliases } = over([reply(200, page([]))]);

    await expect(aliases.findByCode('SAVE10,VIP', 'coupon')).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.query({ code: 'SAVE10,VIP' })).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.query({ code: ['SAVE10', 'A,B'] })).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.create('SAVE10,VIP', 'coupon', 4)).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.free('SAVE10,VIP', 'coupon')).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.setTrackingCode(4, 'ADA,FLO')).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each([[0], [[4, 0]], [['4']], [[1.5]]])('query refuses collaboratorId %j', async (collaboratorId) => {
    const { http, aliases } = over([reply(200, page([]))]);

    await expect(aliases.query({ collaboratorId } as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each(['', '   '])('every method that takes a code refuses %j', async (code) => {
    const { http, aliases } = over([reply(200, page([]))]);

    await expect(aliases.findByCode(code, 'coupon')).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.create(code, 'coupon', 4)).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.free(code, 'coupon')).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.setTrackingCode(4, code)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('every method that takes a collaborator id refuses one below 1', async () => {
    const { http, aliases } = over([reply(200, page([]))]);

    await expect(aliases.list(0)).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.trackingCode(-1)).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.setTrackingCode(0, 'ADA')).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.forCollaborator(1.5, 'coupon')).rejects.toBeInstanceOf(SirenError);
    await expect(aliases.create('SAVE10', 'coupon', 0)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
