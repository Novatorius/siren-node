import { describe, expect, it } from 'vitest';
import { ApiError, ConnectionError, SirenError, UnexpectedResponseError } from '../src/index';
import {
  LIST_CONTROL_KEYS,
  MAX_BULK_IDS,
  bulkRecords,
  deleteRecord,
  listRecords,
  readList,
  readObject,
  writeList,
  recordId,
  recordListQuery,
  writeRecord,
} from '../src/resources/record-requests';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, pathOf, queryOf, rateLimited, transportOver } from './record-fakes';

/*
 * Slice 3 acceptance tests for packet P1: the internal request helpers every
 * record resource sends through, so the id rule, the list query, the
 * send-once rule for writes and the answer checks hold for all of them.
 *
 * Integration shape (KB 568): the real HttpTransport over a FakeHttpClient
 * at the HttpClient seam. The list envelope is the one Cloud's
 * ListResponseWrapperInterceptor builds (lib/Core/Service/Interceptors at
 * b6f7140).
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P1 implementer turns each into `it` and deletes this
 * paragraph.
 */

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('P1: recordId', () => {
  it.skip.each([1, 7, Number.MAX_SAFE_INTEGER])('returns %j', (id) => {
    expect(recordId(id, 'retrieve')).toBe(id);
  });

  it.skip.each([
    [0, '0'],
    [-1, '-1'],
    [1.5, '1.5'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [2 ** 53, '9007199254740992'],
    ['3', '"3"'],
    [null, 'null'],
    [undefined, 'undefined'],
    [true, 'true'],
  ])('refuses %j with SirenError naming the method and the id', (id, shown) => {
    const error = caught(() => recordId(id, 'delete'));

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(`delete needs a positive whole number id, and got ${shown}.`);
  });

  it.skip('names the field it checks', () => {
    const error = caught(() => recordId(0, 'enroll', 'programId'));

    expect((error as SirenError).message).toBe('enroll needs a positive whole number programId, and got 0.');
  });
});

describe('P1: recordListQuery', () => {
  const filters = ['status', 'id', 'programId', 'email', 's', 'active', 'code', 'meta'];

  it.skip('pages with page and perPage the way toListQuery does', () => {
    expect(recordListQuery({ page: 3, perPage: 50 }, [])).toEqual({ number: 50, offset: 100 });
    expect(recordListQuery({ page: 2 }, [])).toEqual({ number: 10, offset: 10 });
    expect(recordListQuery({ perPage: 500, page: 2 }, [])).toEqual({ number: 200, offset: 200 });
    expect(recordListQuery({ number: 25, offset: 5, page: 9, perPage: 1 }, [])).toEqual({ number: 25, offset: 5 });
  });

  it.skip('sends a list comma-separated, filters and fields alike', () => {
    expect(
      recordListQuery({ status: ['active', 'pending'], id: [4, 9], fields: ['id', 'email'], programId: 12 }, filters),
    ).toEqual({ status: 'active,pending', id: '4,9', fields: 'id,email', programId: 12 });
  });

  it.skip('leaves out an empty list and undefined, and keeps a boolean, a string and a number as they are', () => {
    expect(
      recordListQuery({ status: [], s: undefined, fields: 'id,email', orderBy: 'id', active: false }, filters),
    ).toEqual({ fields: 'id,email', orderBy: 'id', active: false });
  });

  it.skip('allows a comma only in fields and in the search text', () => {
    expect(recordListQuery({ fields: 'id,email', s: 'flo, ada' }, filters)).toEqual({ fields: 'id,email', s: 'flo, ada' });
  });

  it.skip('takes the paging, sorting and fields keys whatever the filters', () => {
    expect(LIST_CONTROL_KEYS).toEqual(['page', 'perPage', 'number', 'offset', 'orderBy', 'order', 'fields']);
    expect(recordListQuery({ orderBy: 'id', order: 'DESC', fields: ['id'], number: 5, offset: 0 }, [])).toEqual({
      orderBy: 'id',
      order: 'DESC',
      fields: 'id',
      number: 5,
      offset: 0,
    });
  });

  it.skip.each([
    ['an object', { meta: { a: 1 } }],
    ['null', { status: null }],
    ['a list holding an object', { id: [1, { id: 2 }] }],
    ['a list holding a boolean', { id: [1, true] }],
    ['a list holding NaN', { id: [1, Number.NaN] }],
    ['a list member with a comma', { email: ['a@example.com', 'b,c@example.com'] }],
    ['a string filter with a comma', { code: 'SAVE10,VIP' }],
    ['a function', { s: () => 'x' }],
    ['a key the route does not read', { propertyId: 5 }],
    ['a misspelt filter', { programID: 5 }],
  ])('refuses %s with SirenError naming the key', (_label, params) => {
    const error = caught(() => recordListQuery(params, filters));

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
  });
});

describe('P1: listRecords', () => {
  const envelope = { items: [{ id: 4 }, { id: 9 }], total: 42, page: 1, perPage: 10, totalPages: 5 };

  it.skip('reads GET {path} with the list query and answers the items with estimatedCount', async () => {
    const { http, transport } = transportOver([reply(200, envelope)]);

    const list = await listRecords(transport, '/collaborator-programs', { programId: [2, 3], page: 2, perPage: 5 }, [
      'programId',
    ]);

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborator-programs');
    expect(queryOf(http.requests[0])).toEqual({ programId: '2,3', number: '5', offset: '5' });
    expect(bodyOf(http.requests[0])).toBeUndefined();
    expect([...list]).toEqual([{ id: 4 }, { id: 9 }]);
    expect(list.estimatedCount).toBe(42);
  });

  it.skip('sends a boolean filter as true or false', async () => {
    const { http, transport } = transportOver([reply(200, envelope)]);

    await listRecords(transport, '/programs', { test: true, live: false }, ['test', 'live']);

    expect(queryOf(http.requests[0])).toEqual({ test: 'true', live: 'false' });
  });

  it.skip('reads a bare array with the count header', async () => {
    const { transport } = transportOver([reply(200, [{ id: 1 }], { 'x-siren-estimated-count': '7' })]);

    const list = await listRecords(transport, '/programs', {}, []);

    expect([...list]).toEqual([{ id: 1 }]);
    expect(list.estimatedCount).toBe(7);
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => listRecords(transport, '/programs', {}, []), reply(200, envelope));
  });

  it.skip.each([
    ['a value it refuses', { id: [1, { id: 2 }] }],
    ['a key the route does not read', { propertyId: 5 }],
  ])('sends nothing for %s', async (_label, params) => {
    const { http, transport } = transportOver([reply(200, envelope)]);

    await expect(listRecords(transport, '/programs', params, ['id'])).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each([
    ['an error object', reply(200, { error: 'Something went wrong.' })],
    ['items that are not a list', reply(200, { items: { id: 1 }, total: 1 })],
    ['a JSON null', reply(200, null)],
    ['a string', reply(200, 'ok')],
    ['an empty body', reply(200)],
  ])('throws UnexpectedResponseError with the status for %s, never an empty page', async (_label, answer) => {
    const { transport } = transportOver([answer]);

    const error = await listRecords(transport, '/programs', {}, []).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
  });
});

describe('P1: readObject', () => {
  it.skip('reads GET {path} with the query and answers the object', async () => {
    const answer = { options: { active: 'Active' }, tones: { active: 'positive' } };
    const { http, transport } = transportOver([reply(200, answer)]);

    expect(await readObject(transport, '/collaborators/4', { fields: 'id,aliases' })).toEqual(answer);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/collaborators/4');
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,aliases' });
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => readObject(transport, '/programs/status-types'), reply(200, { options: {} }));
  });

  it.skip.each([
    ['an array', reply(200, [{ id: 1 }])],
    ['an empty body', reply(200)],
    ['a string', reply(200, 'ok')],
    ['null', reply(200, null)],
  ])('throws UnexpectedResponseError for %s', async (_label, answer) => {
    const { transport } = transportOver([answer]);

    const error = await readObject(transport, '/programs/status-types').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
  });
});

describe('P1: readList', () => {
  it.skip('reads GET {path} and answers the bare array', async () => {
    const answer = [{ id: 'USD', symbol: '$' }, { id: 'PTS', symbol: 'pts' }];
    const { http, transport } = transportOver([reply(200, answer)]);

    expect(await readList(transport, '/programs/currency-types')).toEqual(answer);
    expect(http.requests[0]!.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/programs/currency-types');
  });

  it.skip('retries like a read', async () => {
    await expectRetried((transport) => readList(transport, '/programs/currency-types'), reply(200, []));
  });

  it.skip.each([
    ['an object', reply(200, { items: [] })],
    ['an empty body', reply(200)],
    ['null', reply(200, null)],
  ])('throws UnexpectedResponseError for %s', async (_label, answer) => {
    const { transport } = transportOver([answer]);

    await expect(readList(transport, '/programs/currency-types')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('P1: writeList', () => {
  it.skip.each(['POST', 'PUT'] as const)('sends %s with a JSON body and answers the bare array', async (method) => {
    const answer = [{ id: 1, groupId: 5, collaboratorId: 42, metadata: {} }];
    const { http, transport } = transportOver([reply(200, answer)]);

    expect(await writeList(transport, method, '/collaborator-groups/5/members', { members: [{ collaboratorId: 42 }] })).toEqual(
      answer,
    );
    expect(http.requests[0]!.method).toBe(method);
    expect(http.requests[0]!.body).toBe('{"members":[{"collaboratorId":42}]}');
  });

  it.skip.each(['POST', 'PUT'] as const)('sends %s once on a 503 or a network failure', async (method) => {
    await expectSentOnce((transport) => writeList(transport, method, '/collaborator-groups/5/members', {}), reply(200, []));
  });

  it.skip.each([
    ['an object', reply(200, { id: 1 })],
    ['an empty body', reply(200)],
  ])('throws UnexpectedResponseError with the 2xx status for %s', async (_label, answer) => {
    const { transport } = transportOver([answer]);

    const error = await writeList(transport, 'POST', '/collaborator-groups/5/members', {}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
  });
});

describe('P1: writeRecord', () => {
  it.skip.each(['POST', 'PUT'] as const)('sends %s with a JSON body and answers the object', async (method) => {
    const answer = { id: 12, status: 'pending', dateCreated: '2026-10-16 12:00:00' };
    const { http, transport } = transportOver([reply(201, answer)]);

    expect(await writeRecord(transport, method, '/collaborators', { email: 'a@example.com' })).toEqual(answer);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe(method);
    expect(pathOf(http.requests[0])).toBe('/collaborators');
    expect(http.requests[0]!.body).toBe('{"email":"a@example.com"}');
    expect(http.requests[0]!.headers['Content-Type']).toBe('application/json');
  });

  it.skip.each(['POST', 'PUT'] as const)('sends %s once on a 503 or a network failure', async (method) => {
    await expectSentOnce((transport) => writeRecord(transport, method, '/programs', { name: 'P' }), reply(201, { id: 1 }));
  });

  it.skip('sends once on a 429', async () => {
    const { http, transport } = transportOver([
      reply(429, rateLimited, { 'Retry-After': '0' }),
      reply(201, { id: 1 }),
    ]);

    await expect(writeRecord(transport, 'POST', '/programs', {})).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(1);
  });

  it.skip.each([
    ['an array', reply(201, [{ id: 1 }])],
    ['an empty body', reply(201)],
    ['null', reply(201, null)],
  ])('throws UnexpectedResponseError with the 2xx status for %s', async (_label, answer) => {
    const { http, transport } = transportOver([answer, reply(201, { id: 1 })]);

    const error = await writeRecord(transport, 'POST', '/programs', {}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(201);
    expect(http.requests).toHaveLength(1);
  });
});

describe('P1: deleteRecord', () => {
  it.skip('sends DELETE with the query and no body, and answers the object', async () => {
    const { http, transport } = transportOver([reply(200, { deleted: true })]);

    expect(await deleteRecord(transport, '/collaborator-aliases', { code: 'SAVE10', type: 'coupon' })).toEqual({
      deleted: true,
    });
    expect(http.requests[0]!.method).toBe('DELETE');
    expect(pathOf(http.requests[0])).toBe('/collaborator-aliases');
    expect(queryOf(http.requests[0])).toEqual({ code: 'SAVE10', type: 'coupon' });
    expect(http.requests[0]!.body).toBeUndefined();
  });

  it.skip.each([
    ['a 204', reply(204)],
    ['a 200 with no body', reply(200)],
  ])('answers null for %s', async (_label, answer) => {
    const { transport } = transportOver([answer]);

    expect(await deleteRecord(transport, '/collaborators/9')).toBeNull();
  });

  it.skip.each([
    ['an array', reply(200, [1])],
    ['a string', reply(200, 'gone')],
    ['a JSON null', reply(200, null)],
    ['text that is not JSON', { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'gone' }],
  ])('throws UnexpectedResponseError for %s', async (_label, answer) => {
    const { transport } = transportOver([answer]);

    await expect(deleteRecord(transport, '/collaborators/9')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('sends once on a 503 or a network failure', async () => {
    await expectSentOnce((transport) => deleteRecord(transport, '/collaborators/9'), reply(204));
  });
});

describe('P1: bulkRecords', () => {
  const done = { success: true, affected: 2 };

  it.skip('posts {action, ids, ...extra} to {collection}/bulk and answers the object', async () => {
    const { http, transport } = transportOver([reply(200, done)]);

    expect(await bulkRecords(transport, '/collaborators', 'addToProgram', [1, 2], { programId: 5 })).toEqual(done);
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/collaborators/bulk');
    expect(http.requests[0]!.body).toBe('{"action":"addToProgram","ids":[1,2],"programId":5}');
  });

  it.skip('takes MAX_BULK_IDS ids', async () => {
    const ids = Array.from({ length: MAX_BULK_IDS }, (_, index) => index + 1);
    const { http, transport } = transportOver([reply(200, done)]);

    await bulkRecords(transport, '/programs', 'delete', ids);

    expect(MAX_BULK_IDS).toBe(500);
    expect((bodyOf(http.requests[0]) as { ids: number[] }).ids).toHaveLength(500);
  });

  it.skip.each([
    ['an empty action', '', [1], {}],
    ['no ids', 'delete', [], {}],
    ['ids that are not an array', 'delete', 4, {}],
    ['501 ids', 'delete', Array.from({ length: 501 }, (_, index) => index + 1), {}],
    ['an id of 0', 'delete', [1, 0], {}],
    ['a text id', 'delete', [1, '2'], {}],
    ['a fractional id', 'delete', [1.5], {}],
    ['an extra named action', 'delete', [1], { action: 'restore' }],
    ['an extra named ids', 'delete', [1], { ids: [2] }],
  ])('refuses %s with SirenError and sends nothing', async (_label, action, ids, extra) => {
    const { http, transport } = transportOver([reply(200, done)]);

    await expect(
      bulkRecords(transport, '/programs', action as string, ids as number[], extra as Record<string, unknown>),
    ).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('sends once on a 503 or a network failure', async () => {
    await expectSentOnce((transport) => bulkRecords(transport, '/programs', 'delete', [1]), reply(200, done));
  });

  it.skip.each([
    ['an array', reply(200, [done])],
    ['an empty body', reply(200)],
  ])('throws UnexpectedResponseError for %s, after one send', async (_label, answer) => {
    const { http, transport } = transportOver([answer, reply(200, done)]);

    const error = await bulkRecords(transport, '/programs', 'delete', [1]).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(http.requests).toHaveLength(1);
  });

  it.skip('raises the error Siren answers with, after one send', async () => {
    const { http, transport } = transportOver([reply(500, { error: 'Something went wrong.' }), reply(200, done)]);

    const error = await bulkRecords(transport, '/programs', 'delete', [1]).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect(http.requests).toHaveLength(1);
  });
});
