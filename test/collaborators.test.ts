import { describe, expect, it } from 'vitest';
import {
  ApiError,
  BadRequestError,
  COLLABORATOR_BINDING_FIELDS,
  CollaboratorAliasesResource,
  CollaboratorBulkAction,
  CollaboratorsResource,
  CollaboratorStatus,
  ErrorCode,
  NotFoundError,
  PolicyError,
  ProgramEnrollmentsResource,
  SITE_UPDATABLE_COLLABORATOR_FIELDS,
  SirenError,
  UnexpectedResponseError,
  ValidationError,
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
 * Slice 3 acceptance tests for packet P3: CollaboratorsResource, the
 * `/collaborators` routes. Every method gets a fixture test from Cloud's own
 * answer (test/record-fakes.ts), and every write a send-once test.
 *
 * Integration shape, per "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568): the real CollaboratorsResource over the real
 * HttpTransport, with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P3 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, collaborators: new CollaboratorsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new CollaboratorsResource(transport);

describe('P3: collaborators surface', () => {
  it('names the bindings, the fields a site may update and the list filters', () => {
    expect(COLLABORATOR_BINDING_FIELDS).toEqual(['programs', 'distributors', 'groups']);
    expect(SITE_UPDATABLE_COLLABORATOR_FIELDS).toEqual(['fullName', 'nickname']);
    expect(CollaboratorsResource.LIST_FILTERS).toEqual([
      'id',
      'status',
      'fullName',
      'nickname',
      'email',
      's',
      'programId',
      'distributorId',
    ]);
    expect(CollaboratorsResource.ID_FILTERS).toEqual({ one: ['programId', 'distributorId'], many: ['id'] });
  });

  it('carries aliases and enrollments over the same transport', () => {
    const { collaborators } = over([reply(200, {})]);

    expect(collaborators.aliases).toBeInstanceOf(CollaboratorAliasesResource);
    expect(collaborators.enrollments).toBeInstanceOf(ProgramEnrollmentsResource);
  });
});

describe('P3: collaborators.list', () => {
  it.skip('reads GET /collaborators with filters, sorting and paging, and answers the page', async () => {
    const { http, collaborators } = over([reply(200, page([CollaboratorAnswers.listed], 31, 50, 50))]);

    const list = await collaborators.list({
      status: [CollaboratorStatus.Active, CollaboratorStatus.Pending],
      programId: 12,
      s: 'flo',
      fields: ['id', 'email'],
      orderBy: 'dateCreated',
      order: 'DESC',
      page: 2,
      perPage: 50,
    });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborators');
    expect(queryOf(http.requests[0])).toEqual({
      status: 'active,pending',
      programId: '12',
      s: 'flo',
      fields: 'id,email',
      orderBy: 'dateCreated',
      order: 'DESC',
      number: '50',
      offset: '50',
    });
    expect([...list]).toEqual([CollaboratorAnswers.listed]);
    expect(list.estimatedCount).toBe(31);
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([CollaboratorAnswers.listed])));
  });

  it.skip.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { programID: 12 }],
    ['an email with a comma', { email: 'ada@example.com,flo@example.com' }],
    ['a list of programs, which Cloud reads as one', { programId: [3, 4] }],
    ['a program id Cloud would cast to 3', { programId: '3abc' }],
    ['a distributor list, which Cloud reads as one', { distributorId: [3, 4] }],
    ['an empty id list', { id: [] }],
    ['an empty status list', { status: [] }],
  ])('refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, collaborators } = over([reply(200, page([CollaboratorAnswers.listed]))]);

    const error = await collaborators.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('throws UnexpectedResponseError for a 2xx that is not a list, never an empty page', async () => {
    const { collaborators } = over([reply(200, { error: 'Something went wrong.' })]);

    await expect(collaborators.list()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('P3: collaborators.retrieve', () => {
  it.skip('reads GET /collaborators/{id} with fields comma-separated and answers the record', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.record)]);

    expect(await collaborators.retrieve(4, { fields: ['id', 'referralCode'] })).toEqual(CollaboratorAnswers.record);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,referralCode' });
  });

  it.skip('sends include and propertyId the way every retrieve does', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.record)]);

    await collaborators.retrieve(4, { fields: 'id,email', include: 'extended', propertyId: 3 });

    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,email', include: 'extended', propertyId: '3' });
  });

  it.skip('throws UnexpectedResponseError for a 2xx that is not an object', async () => {
    const { collaborators } = over([reply(200, [CollaboratorAnswers.record])]);

    await expect(collaborators.retrieve(4)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('raises NotFoundError for the empty 404 Siren answers for an unknown id', async () => {
    const { collaborators } = over([reply(404)]);

    await expect(collaborators.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => resource(transport).retrieve(4), reply(200, CollaboratorAnswers.record));
  });
});

describe('P3: collaborators.create', () => {
  const params = {
    fullName: 'Ada Lovelace',
    nickname: 'ada',
    email: 'ada@example.com',
    status: CollaboratorStatus.Active,
    trackingId: 'ADA',
    programs: [2],
  };

  it.skip('posts the record to /collaborators and answers the created collaborator', async () => {
    const { http, collaborators } = over([reply(201, CollaboratorAnswers.created)]);

    expect(await collaborators.create(params)).toEqual(CollaboratorAnswers.created);
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/collaborators');
    expect(bodyOf(http.requests[0])).toEqual(params);
  });

  it.skip('raises the reserved address refusal as ValidationError with its code', async () => {
    const { collaborators } = over([reply(422, CollaboratorAnswers.reservedAddress)]);

    const error = await collaborators.create(params).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ErrorCode.ReservedAddress);
  });

  it.skip('raises a tracking code another collaborator holds as BadRequestError naming trackingId', async () => {
    const { http, collaborators } = over([reply(400, CollaboratorAnswers.trackingTaken)]);

    const error = await collaborators.create(params).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).code).toBe('VALIDATION_FAILED');
    expect((error as BadRequestError).fieldErrors.map((entry) => [entry.field, entry.type])).toEqual([
      ['trackingId', 'DUPLICATE_ENTRY'],
    ]);
    expect(http.requests).toHaveLength(1);
  });

  it.skip('is sent once', async () => {
    await expectSentOnce((transport) => resource(transport).create(params), reply(201, CollaboratorAnswers.created));
  });
});

describe('P3: collaborators.createPending', () => {
  const params = { fullName: 'Ada Lovelace', nickname: 'ada', email: 'ada@example.com' };

  it.skip('posts the details with status pending and answers the created collaborator', async () => {
    const { http, collaborators } = over([reply(201, CollaboratorAnswers.created)]);

    expect(await collaborators.createPending({ ...params, trackingId: 'ADA' })).toEqual(CollaboratorAnswers.created);
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/collaborators');
    expect(bodyOf(http.requests[0])).toEqual({ ...params, trackingId: 'ADA', status: 'pending' });
  });

  it.skip.each([
    ['programs', [2]],
    ['programs', []],
    ['distributors', [3]],
    ['groups', []],
    ['groups', undefined],
    ['status', 'pending'],
    ['status', 'active'],
  ])('refuses %s (%j) with SirenError naming it, and sends nothing', async (field, value) => {
    const { http, collaborators } = over([reply(201, CollaboratorAnswers.created)]);

    const error = await collaborators
      .createPending({ ...params, [field]: value } as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      `createPending cannot send "${field}". Siren sets a pending collaborator's status, and a site enrolls them with enrollments.add() afterwards.`,
    );
    expect(http.requests).toHaveLength(0);
  });

  it.skip('raises a site refusal as PolicyError', async () => {
    const { collaborators } = over([reply(403, CollaboratorAnswers.pendingStatusRequired)]);

    const error = await collaborators.createPending(params).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).param).toBe('status');
  });

  it.skip('is sent once', async () => {
    await expectSentOnce((transport) => resource(transport).createPending(params), reply(201, CollaboratorAnswers.created));
  });
});

describe('P3: collaborators.update', () => {
  it.skip('puts only the given fields to /collaborators/{id} and answers the record', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.updated)]);

    expect(await collaborators.update(4, { nickname: 'countess', programs: [] })).toEqual(CollaboratorAnswers.updated);
    expect(http.requests[0]!.method).toBe('PUT');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(bodyOf(http.requests[0])).toEqual({ nickname: 'countess', programs: [] });
  });

  it.skip('is sent once', async () => {
    await expectSentOnce((transport) => resource(transport).update(4, { nickname: 'x' }), reply(200, CollaboratorAnswers.updated));
  });
});

describe('P3: collaborators.updateDetails', () => {
  it.skip('puts only fullName and nickname and answers the record', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.updated)]);

    expect(await collaborators.updateDetails(4, { fullName: 'Flo', nickname: 'countess' })).toEqual(
      CollaboratorAnswers.updated,
    );
    expect(http.requests[0]!.method).toBe('PUT');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(bodyOf(http.requests[0])).toEqual({ fullName: 'Flo', nickname: 'countess' });
  });

  it.skip.each([
    ['status', 'active'],
    ['email', 'x@example.com'],
    ['trackingId', 'ADA2'],
    ['programs', []],
    ['distributors', [1]],
    ['groups', undefined],
    ['fields', ['id']],
    ['id', 4],
    ['payoutEmail', 'x@example.com'],
  ])('refuses %s (%j) with SirenError naming it, and sends nothing', async (field, value) => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.updated)]);

    const error = await collaborators
      .updateDetails(4, { nickname: 'countess', [field]: value } as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      `updateDetails cannot send "${field}". A connected site changes only fullName and nickname.`,
    );
    expect(http.requests).toHaveLength(0);
  });

  it.skip('raises a site refusal as PolicyError with the field Siren names', async () => {
    const { collaborators } = over([reply(403, CollaboratorAnswers.fieldNotAllowed)]);

    const error = await collaborators.updateDetails(4, { nickname: 'countess' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).param).toBe('trackingId');
  });

  it.skip('is sent once', async () => {
    await expectSentOnce(
      (transport) => resource(transport).updateDetails(4, { nickname: 'x' }),
      reply(200, CollaboratorAnswers.updated),
    );
  });
});

describe('P3: collaborators.delete', () => {
  it.skip('answers the record marked deleted, then null when Siren removes it', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.softDeleted), reply(204)]);

    expect(await collaborators.delete(4)).toEqual(CollaboratorAnswers.softDeleted);
    expect(await collaborators.delete(4)).toBeNull();
    expect(http.requests.map((request) => [request.method, pathOf(request), request.body])).toEqual([
      ['DELETE', '/collaborators/4', undefined],
      ['DELETE', '/collaborators/4', undefined],
    ]);
  });

  it.skip('answers null on the first call for an invited collaborator, which Siren removes for good', async () => {
    const { http, collaborators } = over([reply(204)]);

    expect(await collaborators.delete(7)).toBeNull();
    expect(http.requests).toHaveLength(1);
  });

  it.skip('throws UnexpectedResponseError for a 2xx that is neither empty nor an object', async () => {
    const { collaborators } = over([reply(200, [CollaboratorAnswers.softDeleted])]);

    await expect(collaborators.delete(4)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('is sent once, since a second delete removes the record', async () => {
    await expectSentOnce((transport) => resource(transport).delete(4), reply(204));
  });
});

describe('P3: collaborators.bulk', () => {
  it.skip('posts the action, ids and extras to /collaborators/bulk and answers the result', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.bulk)]);

    expect(await collaborators.bulk(CollaboratorBulkAction.AddToDistributor, [1, 2], { distributorId: 5 })).toEqual(
      CollaboratorAnswers.bulk,
    );
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/collaborators/bulk');
    expect(http.requests[0]!.body).toBe('{"action":"addToDistributor","ids":[1,2],"distributorId":5}');
  });

  it.skip('refuses an empty id list and sends nothing', async () => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.bulk)]);

    await expect(collaborators.bulk(CollaboratorBulkAction.Activate, [])).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each([
    ['programId', '5'],
    ['programId', 0],
    ['programId', 1.5],
    ['distributorId', -2],
    ['distributorId', null],
  ])('refuses extra.%s of %j with SirenError naming it, and sends nothing', async (field, value) => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.bulk)]);
    const action =
      field === 'programId' ? CollaboratorBulkAction.AddToProgram : CollaboratorBulkAction.AddToDistributor;

    const error = await collaborators.bulk(action, [1], { [field]: value }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(field);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('answers a partial result as Siren sends it, with affected lower than the ids sent', async () => {
    const { collaborators } = over([reply(200, { success: true, affected: 1 })]);

    expect(await collaborators.bulk(CollaboratorBulkAction.Activate, [1, 2])).toEqual({ success: true, affected: 1 });
  });

  it.skip('raises a signup email failure as ApiError with the sent and failed counts, after one send', async () => {
    const { http, collaborators } = over([reply(502, CollaboratorAnswers.signupEmailFailed), reply(200, CollaboratorAnswers.bulk)]);

    const error = await collaborators
      .bulk(CollaboratorBulkAction.SendSignupEmail, [1, 2, 3])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(502);
    expect((error as ApiError).code).toBe('signup_email_failed');
    expect((error as ApiError).data).toEqual({ type: 'signup_email_failed', sent: 2, failed: 1 });
    expect(http.requests).toHaveLength(1);
  });

  it.skip('is sent once', async () => {
    await expectSentOnce(
      (transport) => resource(transport).bulk(CollaboratorBulkAction.Deactivate, [1]),
      reply(200, CollaboratorAnswers.bulk),
    );
  });
});

describe('P3: collaborators vocabulary reads', () => {
  it.skip('reads the status types and a referral code from their routes', async () => {
    const { http, collaborators } = over([
      reply(200, CollaboratorAnswers.statusTypes),
      reply(200, CollaboratorAnswers.referralCode),
    ]);

    expect(await collaborators.statusTypes()).toEqual(CollaboratorAnswers.statusTypes);
    expect(await collaborators.generateReferralCode()).toEqual(CollaboratorAnswers.referralCode);
    expect(http.requests.map((request) => [request.method, pathOf(request)])).toEqual([
      ['GET', '/collaborators/status-types'],
      ['GET', '/collaborators/generate-referral-code'],
    ]);
  });

  it.skip.each([
    ['statusTypes', (c: CollaboratorsResource) => c.statusTypes()],
    ['generateReferralCode', (c: CollaboratorsResource) => c.generateReferralCode()],
  ])('%s throws UnexpectedResponseError for a 2xx that is not an object', async (_name, call) => {
    const { collaborators } = over([reply(200, ['BCDGHJK'])]);

    await expect(call(collaborators)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('retries both like reads', async () => {
    await expectRetried((transport) => resource(transport).statusTypes(), reply(200, CollaboratorAnswers.statusTypes));
    await expectRetried(
      (transport) => resource(transport).generateReferralCode(),
      reply(200, CollaboratorAnswers.referralCode),
    );
  });
});

describe('P3: collaborators ids', () => {
  const calls: Array<[string, (collaborators: CollaboratorsResource) => Promise<unknown>]> = [
    ['retrieve', (c) => c.retrieve(0)],
    ['update', (c) => c.update(-1, { nickname: 'x' })],
    ['updateDetails', (c) => c.updateDetails(1.5, { nickname: 'x' })],
    ['delete', (c) => c.delete(Number.NaN)],
    ['bulk', (c) => c.bulk(CollaboratorBulkAction.Activate, [1, 0])],
  ];

  it.skip.each(calls)('%s refuses a bad id with SirenError and sends nothing', async (_name, call) => {
    const { http, collaborators } = over([reply(200, CollaboratorAnswers.updated)]);

    await expect(call(collaborators)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
