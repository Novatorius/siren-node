import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ConversionStatus,
  ConversionsResource,
  NotFoundError,
  SirenError,
  TransactionsResource,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpRequest, HttpResponse } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, page, pathOf, queryOf, transportOver, unavailable } from './record-fakes';
import { ConversionAnswers, TransactionAnswers } from './record-fakes-2';

/*
 * Slice 4 contract fix, packet F1: the lost-answer check behind
 * `conversions.create` and `transactions.creditCollaborator`. After a write
 * loses its answer, `conversions.recoverCreate` and
 * `transactions.recoverCreditCollaborator` read the conversions Siren holds
 * and send the write again only on a well-formed answer that shows it did
 * not land. An answer the SDK cannot read raises and sends nothing, so
 * "broken" never reads as "send again", which would make a second
 * conversion.
 *
 * Each case starts the way a caller's queue meets it: the first write was
 * sent once and lost its answer to a 503. The recovery then runs on the same
 * transport, and the case counts every write the fake client was handed.
 *
 * The list rows are GetConversions.php's answer at b6f7140, with the fields
 * each recovery asks for, wrapped by ListResponseWrapperInterceptor
 * (`page`). A collaborator filter that matches no engagement answers a bare
 * `[]` (GetConversions.php, the empty-engagement branch).
 *
 * Integration shape (KB 568): the real resources over the real
 * HttpTransport, with a FakeHttpClient at the HttpClient seam, aimed at
 * example.invalid. Nothing here reaches the network.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * packet F1, named in its describe block. The F1 implementer deletes the
 * `.skip` from each of them, so `it.skip(` becomes `it(` and `it.skip.each(`
 * becomes `it.each(`, and deletes the one-line comment above each, and this
 * paragraph. Nothing else here changes. The tests with no `.skip` pass now.
 */

const create = { engagementId: 31, transactionId: 71, type: 'sale', status: ConversionStatus.Pending };

/** A conversion row as GET /conversions answers it for recoverCreate's fields. */
const found = { id: 61, engagementId: 31, transactionId: 71, type: 'sale', status: 'pending' };

/** A conversion row as GET /conversions answers it for recoverCreditCollaborator's fields. */
function credit(transactionId: number, overrides: Record<string, unknown> = {}) {
  return { id: 600 + transactionId, transactionId, collaboratorId: 42, type: 'sale', ...overrides };
}

/** A 2xx body that is not JSON, as a proxy in front of Siren might send. */
const textReply: HttpResponse = { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok' };

/** Every answer the check cannot read, with the reason it cannot. */
const UNREADABLE: Array<[string, HttpResponse]> = [
  ['a malformed 200 that is not JSON', textReply],
  ['a malformed 200 with no body', reply(200)],
  ['a 200 whose items key is missing', reply(200, { total: 0, page: 1, perPage: 10, totalPages: 1 })],
  ['a 200 whose items key is misspelt', reply(200, { itemz: [], total: 0 })],
  ['a 200 whose items is not an array', reply(200, { items: 'none', total: 0 })],
  ['a 200 whose items is an object', reply(200, { items: {}, total: 0 })],
  ['a 200 that is a JSON string, not an array', reply(200, 'none')],
  ['a 200 that is JSON null', reply(200, null)],
  ['a 200 whose row is not an object', reply(200, page([7]))],
];

function writes(requests: HttpRequest[]): HttpRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}

function reads(requests: HttpRequest[]): HttpRequest[] {
  return requests.filter((request) => request.method === 'GET');
}

/** The first create, lost to a 503, then `answers` for the recovery on the same transport. */
function afterLostCreate(answers: Array<HttpResponse | Error>) {
  const built = transportOver([unavailable(), ...answers]);
  return { ...built, conversions: new ConversionsResource(built.transport) };
}

/** The first credit, lost to a 503, then `answers` for the recovery on the same transport. */
function afterLostCredit(answers: Array<HttpResponse | Error>) {
  const built = transportOver([unavailable(), ...answers]);
  return { ...built, transactions: new TransactionsResource(built.transport) };
}

describe('4 fix F1: recovery surface', () => {
  it('names the filters the recovery reads send', () => {
    expect(ConversionsResource.RECOVERY_FILTERS).toEqual(['transactionId', 'engagementId', 'collaboratorId', 'type']);
  });

  it('checks the id filters by how Siren reads them', () => {
    expect(ConversionsResource.RECOVERY_ID_FILTERS).toEqual({ one: ['collaboratorId'], many: ['transactionId', 'engagementId'] });
  });
});

describe('4 fix F1: conversions.recoverCreate', () => {
  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each(UNREADABLE)('raises for %s and never sends the create again', async (_label, answer) => {
    const { http, conversions } = afterLostCreate([answer, reply(201, ConversionAnswers.created)]);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    const error = await conversions.recoverCreate(create).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect(writes(http.requests)).toHaveLength(1);
    expect(reads(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each([
    ['another transaction', { ...found, transactionId: 99 }],
    ['another engagement', { ...found, engagementId: 99 }],
    ['another type', { ...found, type: 'lead' }],
    ['no transactionId', { id: 61, engagementId: 31, type: 'sale' }],
  ])('raises for a row naming %s, since Siren did not read the filter, and never sends again', async (_label, row) => {
    const { http, conversions } = afterLostCreate([reply(200, page([row])), reply(201, ConversionAnswers.created)]);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    const error = await conversions.recoverCreate(create).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(writes(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('lets an error from the read through and never sends again', async () => {
    const { http, conversions } = afterLostCreate([reply(404, { error: 'No record found with that ID.' }), reply(201, ConversionAnswers.created)]);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    await expect(conversions.recoverCreate(create)).rejects.toBeInstanceOf(NotFoundError);
    expect(writes(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each([
    ['an empty items list', reply(200, page([]))],
    ['an empty JSON array', reply(200, [])],
  ])('sends the create once more on %s and answers the new conversion', async (_label, answer) => {
    const { http, conversions } = afterLostCreate([answer, reply(201, ConversionAnswers.created)]);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    expect(await conversions.recoverCreate(create)).toEqual({ conversion: ConversionAnswers.created, created: true });

    const sent = writes(http.requests);
    expect(sent).toHaveLength(2);
    expect([sent[1]!.method, pathOf(sent[1])]).toEqual(['POST', '/conversions']);
    expect(bodyOf(sent[1])).toEqual(create);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('answers the conversion the first send made and sends nothing', async () => {
    const { http, conversions } = afterLostCreate([reply(200, page([found])), reply(201, ConversionAnswers.created)]);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    expect(await conversions.recoverCreate(create)).toEqual({ conversion: found, created: false });
    expect(writes(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('reads GET /conversions by the create transaction, engagement and type, oldest first', async () => {
    const { http, conversions } = afterLostCreate([reply(200, page([found]))]);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    await conversions.recoverCreate(create);

    const read = reads(http.requests)[0];
    expect(pathOf(read)).toBe('/conversions');
    expect(queryOf(read)).toEqual({
      transactionId: '71',
      engagementId: '31',
      type: 'sale',
      fields: 'id,engagementId,transactionId,type,status',
      number: '1',
      orderBy: 'id',
      order: 'ASC',
    });
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('refuses a create with no transactionId before anything is sent', async () => {
    const { http, conversions } = afterLostCreate([reply(200, page([]))]);

    const error = await conversions
      .recoverCreate({ engagementId: 31, type: 'sale', status: ConversionStatus.Pending })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      'conversions.recoverCreate() needs a transactionId to find the first send. Without one, set the create aside.',
    );
    expect(http.requests).toHaveLength(0);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each([
    ['a zero engagementId', { ...create, engagementId: 0 }],
    ['a transactionId that is a string', { ...create, transactionId: '71' }],
    ['a fractional transactionId', { ...create, transactionId: 7.5 }],
  ])('refuses %s before anything is sent', async (_label, params) => {
    const { http, conversions } = afterLostCreate([reply(200, page([]))]);

    await expect(conversions.recoverCreate(params as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('4 fix F1: transactions.recoverCreditCollaborator', () => {
  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each(UNREADABLE)('raises for %s and never sends the credit again', async (_label, answer) => {
    const { http, transactions } = afterLostCredit([answer, reply(200, TransactionAnswers.credited)]);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    const error = await transactions.recoverCreditCollaborator([71, 72], 42).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect(writes(http.requests)).toHaveLength(1);
    expect(reads(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each([
    ['a transaction not asked', credit(99)],
    ['another collaborator', credit(71, { collaboratorId: 7 })],
    ['another type', credit(71, { type: 'lead' })],
    ['no collaboratorId', { id: 671, transactionId: 71, type: 'sale' }],
  ])('raises for a row naming %s, since Siren did not read the filter, and never sends again', async (_label, row) => {
    const { http, transactions } = afterLostCredit([reply(200, page([row])), reply(200, TransactionAnswers.credited)]);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    const error = await transactions.recoverCreditCollaborator([71, 72], 42).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(writes(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('lets an error from the read through and never sends again', async () => {
    const { http, transactions } = afterLostCredit([unavailable(), unavailable(), unavailable(), reply(200, TransactionAnswers.credited)]);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    await expect(transactions.recoverCreditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);
    expect(writes(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each([
    ['an empty items list', reply(200, page([]))],
    ['an empty JSON array, as Siren answers a collaborator with no engagement', reply(200, [])],
  ])('sends every transaction once more on %s', async (_label, answer) => {
    const { http, transactions } = afterLostCredit([answer, reply(200, TransactionAnswers.credited)]);
    await expect(transactions.creditCollaborator([71, 72], 42, 'lead')).rejects.toBeInstanceOf(ApiError);

    expect(await transactions.recoverCreditCollaborator([71, 72], 42, 'lead')).toEqual({
      alreadyCredited: [],
      credited: [71, 72],
      result: TransactionAnswers.credited,
    });

    const sent = writes(http.requests);
    expect(sent).toHaveLength(2);
    expect([sent[1]!.method, pathOf(sent[1])]).toEqual(['POST', '/transactions/credit-collaborator']);
    expect(bodyOf(sent[1])).toEqual({ transactionIds: [71, 72], collaboratorId: 42, type: 'lead' });
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('sends only the transactions this collaborator holds no conversion for, in the order asked', async () => {
    const { http, transactions } = afterLostCredit([reply(200, page([credit(72)])), reply(200, TransactionAnswers.credited)]);
    await expect(transactions.creditCollaborator([73, 72, 71], 42)).rejects.toBeInstanceOf(ApiError);

    expect(await transactions.recoverCreditCollaborator([73, 72, 71], 42)).toEqual({
      alreadyCredited: [72],
      credited: [73, 71],
      result: TransactionAnswers.credited,
    });
    expect(bodyOf(writes(http.requests)[1])).toEqual({ transactionIds: [73, 71], collaboratorId: 42 });
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('sends nothing when every transaction already holds its conversion', async () => {
    const { http, transactions } = afterLostCredit([reply(200, page([credit(71), credit(72)])), reply(200, TransactionAnswers.credited)]);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    expect(await transactions.recoverCreditCollaborator([71, 72], 42)).toEqual({
      alreadyCredited: [71, 72],
      credited: [],
      result: null,
    });
    expect(writes(http.requests)).toHaveLength(1);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('reads GET /conversions by the asked transactions, the collaborator and the type sale when none is given', async () => {
    const { http, transactions } = afterLostCredit([reply(200, page([credit(71), credit(72)]))]);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    await transactions.recoverCreditCollaborator([71, 72], 42);

    const read = reads(http.requests)[0];
    expect(pathOf(read)).toBe('/conversions');
    expect(queryOf(read)).toEqual({
      transactionId: '71,72',
      collaboratorId: '42',
      type: 'sale',
      fields: 'id,transactionId,collaboratorId,type',
      number: '200',
      offset: '0',
      orderBy: 'id',
      order: 'ASC',
    });
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip('reads every page before it decides, so a credit on page two is not sent again', async () => {
    const ids = Array.from({ length: 201 }, (_unused, index) => index + 1);
    const { http, transactions } = afterLostCredit([
      reply(200, page(ids.slice(0, 200).map((id) => credit(id)), 201, 200, 0)),
      reply(200, page([credit(201)], 201, 200, 200)),
      reply(200, TransactionAnswers.credited),
    ]);
    await expect(transactions.creditCollaborator(ids, 42)).rejects.toBeInstanceOf(ApiError);

    const recovered = await transactions.recoverCreditCollaborator(ids, 42);

    expect(recovered).toEqual({ alreadyCredited: ids, credited: [], result: null });
    expect(writes(http.requests)).toHaveLength(1);
    expect(reads(http.requests).map((read) => queryOf(read).offset)).toEqual(['0', '200']);
  });

  // Skipped until fix packet F1 (the lost-answer check) lands.
  it.skip.each([
    ['no transactions', [], 42, undefined],
    ['a transaction id of 0', [71, 0], 42, undefined],
    ['a collaborator id that is a string', [71], '42', undefined],
    ['an empty type', [71], 42, ''],
  ])('refuses %s before anything is sent', async (_label, ids, collaboratorId, type) => {
    const { http, transactions } = afterLostCredit([reply(200, page([]))]);

    await expect(
      transactions.recoverCreditCollaborator(ids as number[], collaboratorId as number, type as string | undefined),
    ).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
