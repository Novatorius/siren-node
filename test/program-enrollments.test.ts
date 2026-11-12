import { describe, expect, it } from 'vitest';
import {
  CollaboratorsResource,
  ErrorCode,
  PolicyError,
  ProgramEnrollmentsResource,
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
 * Slice 3 acceptance tests for packet P5: ProgramEnrollmentsResource, the
 * `/collaborator-programs` routes and the enrollment paths through the
 * collaborator record. Cases follow the Siren PHP SDK's EnrollmentRoutesTest
 * and ProgramEnrollmentsTest at 59383e6, with Cloud's answers from
 * test/record-fakes.ts.
 *
 * Integration shape, per "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568): the real resource, reached through a real
 * CollaboratorsResource, over the real HttpTransport, with a FakeHttpClient
 * at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P5 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, enrollments: new CollaboratorsResource(built.transport).enrollments };
}

const resource = (transport: HttpTransport) => new ProgramEnrollmentsResource(transport);

describe('P5: enrollments surface', () => {
  it('names the route', () => {
    expect(ProgramEnrollmentsResource.PATH).toBe('/collaborator-programs');
    expect(ProgramEnrollmentsResource.LIST_FILTERS).toEqual(['collaboratorId', 'programId']);
    expect(ProgramEnrollmentsResource.ID_FILTERS).toEqual({ many: ['collaboratorId', 'programId'] });
  });
});

describe('P5: enrollments.list', () => {
  it.skip('reads GET /collaborator-programs with any-of filters and paging, and answers the rows', async () => {
    const { http, enrollments } = over([reply(200, page([CollaboratorAnswers.enrolled], 1, 200))]);

    const list = await enrollments.list({ collaboratorId: 4, programId: [2, 3], perPage: 500, orderBy: 'programId' });

    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborator-programs');
    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '4', programId: '2,3', number: '200', orderBy: 'programId' });
    expect([...list]).toEqual([{ collaboratorId: 4, programId: 2 }]);
    expect(list.estimatedCount).toBe(1);
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
  });

  it.skip.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { programID: 2 }],
    ['an empty collaborator list', { collaboratorId: [] }],
    ['a text program id', { programId: '2' }],
  ])('refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, enrollments } = over([reply(200, page([]))]);

    const error = await enrollments.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('throws UnexpectedResponseError for a 2xx that is not a list', async () => {
    const { enrollments } = over([reply(200, { error: 'Something went wrong.' })]);

    await expect(enrollments.list()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('P5: enrollments.add and remove', () => {
  it.skip('posts one enrollment and answers it, the same for a repeat', async () => {
    const { http, enrollments } = over([reply(201, CollaboratorAnswers.enrolled)]);

    expect(await enrollments.add(4, 2)).toEqual({ collaboratorId: 4, programId: 2 });
    expect(await enrollments.add(4, 2)).toEqual({ collaboratorId: 4, programId: 2 });
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/collaborator-programs');
    expect(bodyOf(http.requests[0])).toEqual({ collaboratorId: 4, programId: 2 });
  });

  it.skip('deletes one enrollment by query, with no body', async () => {
    const { http, enrollments } = over([reply(200, CollaboratorAnswers.unenrolled)]);

    expect(await enrollments.remove(4, 2)).toEqual({ deleted: true });
    expect(http.requests[0]!.method).toBe('DELETE');
    expect(pathOf(http.requests[0])).toBe('/collaborator-programs');
    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '4', programId: '2' });
    expect(http.requests[0]!.body).toBeUndefined();
  });

  it.skip.each([
    ['add', (e: ProgramEnrollmentsResource) => e.add(4, 9)],
    ['remove', (e: ProgramEnrollmentsResource) => e.remove(4, 9)],
  ])('%s raises a program off the site as PolicyError', async (_name, call) => {
    const { enrollments } = over([reply(403, CollaboratorAnswers.programNotOnSite)]);

    const error = await call(enrollments).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe(ErrorCode.ProgramNotOnSite);
    expect((error as PolicyError).param).toBe('programId');
  });

  it.skip('sends add and remove once', async () => {
    await expectSentOnce((transport) => resource(transport).add(4, 2), reply(201, CollaboratorAnswers.enrolled));
    await expectSentOnce((transport) => resource(transport).remove(4, 2), reply(200, CollaboratorAnswers.unenrolled));
  });
});

describe('P5: enrollments through the collaborator record', () => {
  it.skip('reads the programs a collaborator is in', async () => {
    const { http, enrollments } = over([
      reply(200, { id: 4, programs: [{ id: 2, name: 'Partners' }, { id: 3, name: 'Creators' }] }),
    ]);

    expect(await enrollments.programsFor(4)).toEqual([
      { id: 2, name: 'Partners' },
      { id: 3, name: 'Creators' },
    ]);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,programs' });
  });

  it.skip('answers an empty list when the record has an empty programs field', async () => {
    const { enrollments } = over([reply(200, { id: 4, programs: [] })]);

    expect(await enrollments.programsFor(4)).toEqual([]);
  });

  it.skip.each([
    ['no programs field', { id: 4 }],
    ['a programs field that is not a list', { id: 4, programs: { id: 2 } }],
    ['an entry that is a number', { id: 4, programs: [{ id: 2, name: 'Partners' }, 7] }],
    ['an entry that is null', { id: 4, programs: [null] }],
  ])('programsFor throws UnexpectedResponseError for %s, never a shorter list', async (_label, body) => {
    const { enrollments } = over([reply(200, body)]);

    const error = await enrollments.programsFor(4).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect((error as UnexpectedResponseError).message).toContain('programs');
    expect((error as UnexpectedResponseError).message).toContain('4');
  });

  it.skip('collaboratorsIn refuses a key collaborators.list refuses, and sends nothing', async () => {
    const { http, enrollments } = over([reply(200, page([]))]);

    await expect(enrollments.collaboratorsIn(12, { propertyId: 5 } as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('collaboratorsIn refuses a programId in params rather than lose it to the argument, and sends nothing', async () => {
    const { http, enrollments } = over([reply(200, page([]))]);

    const error = await enrollments.collaboratorsIn(12, { programId: 99 } as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain('programId');
    expect(http.requests).toHaveLength(0);
  });

  it.skip('lists the collaborators in a program', async () => {
    const { http, enrollments } = over([reply(200, page([CollaboratorAnswers.listed], 1))]);

    const list = await enrollments.collaboratorsIn(12, { status: 'active', perPage: 20 });

    expect(pathOf(http.requests[0])).toBe('/collaborators');
    expect(queryOf(http.requests[0])).toEqual({ programId: '12', status: 'active', number: '20' });
    expect([...list]).toEqual([CollaboratorAnswers.listed]);
  });

  it.skip('enrolls and unenrolls through the bulk actions', async () => {
    const { http, enrollments } = over([reply(200, CollaboratorAnswers.bulk)]);

    expect(await enrollments.enroll(12, [4, 5])).toEqual(CollaboratorAnswers.bulk);
    expect(await enrollments.unenroll(12, [4])).toEqual(CollaboratorAnswers.bulk);
    expect(http.requests.map((request) => [request.method, pathOf(request), request.body])).toEqual([
      ['POST', '/collaborators/bulk', '{"action":"addToProgram","ids":[4,5],"programId":12}'],
      ['POST', '/collaborators/bulk', '{"action":"removeFromProgram","ids":[4],"programId":12}'],
    ]);
  });

  it.skip('replaces the enrollments with exactly these programs, an empty list included', async () => {
    const { http, enrollments } = over([reply(200, CollaboratorAnswers.updated)]);

    expect(await enrollments.replace(4, [12, 15])).toEqual(CollaboratorAnswers.updated);
    await enrollments.replace(4, []);
    expect(http.requests.map((request) => [request.method, pathOf(request), bodyOf(request)])).toEqual([
      ['PUT', '/collaborators/4', { programs: [12, 15] }],
      ['PUT', '/collaborators/4', { programs: [] }],
    ]);
  });

  it.skip('retries the reads and sends the writes once', async () => {
    await expectRetried((transport) => resource(transport).programsFor(4), reply(200, { id: 4, programs: [] }));
    await expectRetried((transport) => resource(transport).collaboratorsIn(12), reply(200, page([])));
    await expectSentOnce((transport) => resource(transport).enroll(12, [4]), reply(200, CollaboratorAnswers.bulk));
    await expectSentOnce((transport) => resource(transport).unenroll(12, [4]), reply(200, CollaboratorAnswers.bulk));
    await expectSentOnce((transport) => resource(transport).replace(4, [12]), reply(200, CollaboratorAnswers.updated));
  });
});

describe('P5: enrollments refuse bad ids before sending', () => {
  const calls: Array<[string, (e: ProgramEnrollmentsResource) => Promise<unknown>]> = [
    ['add, collaborator', (e) => e.add(0, 2)],
    ['add, program', (e) => e.add(4, 0)],
    ['remove, collaborator', (e) => e.remove(-1, 2)],
    ['remove, program', (e) => e.remove(4, 1.5)],
    ['programsFor', (e) => e.programsFor(0)],
    ['collaboratorsIn', (e) => e.collaboratorsIn(0)],
    ['enroll, program', (e) => e.enroll(0, [4])],
    ['enroll, no collaborators', (e) => e.enroll(12, [])],
    ['enroll, a bad collaborator', (e) => e.enroll(12, [4, 0])],
    ['unenroll, program', (e) => e.unenroll(0, [4])],
    ['unenroll, no collaborators', (e) => e.unenroll(12, [])],
    ['replace, collaborator', (e) => e.replace(0, [12])],
    ['replace, a bad program', (e) => e.replace(4, [12, 0])],
  ];

  it.skip.each(calls)('%s', async (_name, call) => {
    const { http, enrollments } = over([reply(200, {})]);

    await expect(call(enrollments)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
