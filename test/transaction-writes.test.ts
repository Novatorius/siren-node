import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  SirenError,
  TransactionBulkAction,
  TransactionsResource,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, pathOf, queryOf, transportOver } from './record-fakes';
import { TransactionAnswers } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P9: the transaction writes and reads
 * slice 2 left out of TransactionsResource (details, create, bulk,
 * creditCollaborator, sources). Cases follow the Siren PHP SDK's
 * TransactionsTest (siren-php 0.3.0), with Cloud's answers from
 * test/record-fakes-2.ts. The reads list and retrieve keep their slice 2
 * tests.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P9 implementer turns each into `it` and deletes this
 * paragraph.
 */

const DETAILS_MESSAGE = 'transactions.create() needs details: a list of 1 to 500 lines.';

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, transactions: new TransactionsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new TransactionsResource(transport);

const create = {
  details: [
    { name: 'Mug', value: 1200, quantity: 2, type: 'product' },
    { name: 'Wrap', value: 300, description: 'Gift wrap', type: 'fee' },
  ],
  bindingId: 'order-91',
  bindingDataType: 'crm_order',
};

describe('P9: transaction writes surface', () => {
  it('names the bulk actions as Siren does', () => {
    expect(TransactionBulkAction).toEqual({ Cancel: 'cancel', Refund: 'refund', Delete: 'delete' });
  });
});

describe('P9: transactions details', () => {
  it.skip("reads a transaction's lines from its details field", async () => {
    const { http, transactions } = over([reply(200, TransactionAnswers.detailsRecord)]);

    expect(await transactions.details(71)).toEqual(TransactionAnswers.detailsRecord.details);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/transactions/71']);
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,details' });
  });

  it.skip.each([
    ['no details field', { id: 71 }],
    ['a field that is not a list', { id: 71, details: null }],
    ['a line that is not an object', { id: 71, details: [7] }],
  ])('throws UnexpectedResponseError for %s, never an empty answer', async (_label, body) => {
    await expect(over([reply(200, body)]).transactions.details(71)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('retries, and refuses an id that is not a positive whole number before sending', async () => {
    await expectRetried((transport) => resource(transport).details(71), reply(200, TransactionAnswers.detailsRecord));

    const { http, transactions } = over([reply(200, TransactionAnswers.detailsRecord)]);
    await expect(transactions.details(0)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('P9: transactions create', () => {
  it.skip('records a transaction with POST /transactions and answers it', async () => {
    const { http, transactions } = over([reply(201, TransactionAnswers.created)]);

    expect(await transactions.create(create)).toEqual(TransactionAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/transactions']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it.skip('raises a second transaction for the same binding as ConflictError', async () => {
    await expect(over([reply(409, TransactionAnswers.bindingExists)]).transactions.create(create)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it.skip('accepts 500 lines', async () => {
    const { http, transactions } = over([reply(201, TransactionAnswers.created)]);

    await transactions.create({ details: Array.from({ length: 500 }, () => ({ name: 'x', value: 1 })) });

    expect(http.requests).toHaveLength(1);
  });

  it.skip.each([
    ['no details', {}],
    ['details that are not a list', { details: { name: 'x', value: 1 } }],
    ['no lines', { details: [] }],
    ['501 lines', { details: Array.from({ length: 501 }, () => ({ name: 'x', value: 1 })) }],
    ['a line that is not an object', { details: [{ name: 'x', value: 1 }, 'y'] }],
    ['a line that is null', { details: [null] }],
  ])('create refuses %s with its own message before sending', async (_label, params) => {
    const { http, transactions } = over([reply(201, TransactionAnswers.created)]);

    const error = await transactions.create(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(DETAILS_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('throws UnexpectedResponseError when create answers no object', async () => {
    await expect(over([reply(201)]).transactions.create(create)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('P9: transactions bulk, creditCollaborator and sources', () => {
  it.skip('runs a bulk action with POST /transactions/bulk', async () => {
    const { http, transactions } = over([reply(200, TransactionAnswers.bulk)]);

    expect(await transactions.bulk(TransactionBulkAction.Refund, [71, 72])).toEqual(TransactionAnswers.bulk);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/transactions/bulk']);
    expect(http.requests[0]!.body).toBe('{"action":"refund","ids":[71,72]}');
  });

  it.skip('credits transactions with POST /transactions/credit-collaborator', async () => {
    const { http, transactions } = over([reply(200, TransactionAnswers.credited)]);

    expect(await transactions.creditCollaborator([71, 72], 4)).toEqual(TransactionAnswers.credited);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/transactions/credit-collaborator']);
    expect(http.requests[0]!.body).toBe('{"transactionIds":[71,72],"collaboratorId":4}');
  });

  it.skip('sends type when it is given', async () => {
    const { http, transactions } = over([reply(200, TransactionAnswers.credited)]);

    await transactions.creditCollaborator([71], 4, 'lead');

    expect(bodyOf(http.requests[0])).toEqual({ transactionIds: [71], collaboratorId: 4, type: 'lead' });
  });

  it.skip('raises an unknown collaborator as NotFoundError', async () => {
    await expect(
      over([reply(404, TransactionAnswers.collaboratorNotFound)]).transactions.creditCollaborator([71], 99),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip('reads the transaction sources from GET /transactions/sources', async () => {
    const { http, transactions } = over([reply(200, TransactionAnswers.sources)]);

    expect(await transactions.sources()).toEqual(TransactionAnswers.sources);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/transactions/sources']);
    await expectRetried((transport) => resource(transport).sources(), reply(200, TransactionAnswers.sources));
  });

  it.skip('sources throws UnexpectedResponseError for a 2xx that is not an object', async () => {
    await expect(over([reply(200, [{ id: 'wc_order' }])]).transactions.sources()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, TransactionAnswers.created));
    await expectSentOnce((transport) => resource(transport).bulk(TransactionBulkAction.Cancel, [71]), reply(200, TransactionAnswers.bulk));
    await expectSentOnce((transport) => resource(transport).creditCollaborator([71], 4), reply(200, TransactionAnswers.credited));
  });

  it.skip.each([
    ['bulk, no ids', (t: TransactionsResource) => t.bulk(TransactionBulkAction.Cancel, [])],
    ['bulk, a bad id', (t: TransactionsResource) => t.bulk(TransactionBulkAction.Cancel, [0])],
    ['creditCollaborator, no ids', (t: TransactionsResource) => t.creditCollaborator([], 4)],
    ['creditCollaborator, a bad id', (t: TransactionsResource) => t.creditCollaborator([71, -2], 4)],
    ['creditCollaborator, 501 ids', (t: TransactionsResource) => t.creditCollaborator(Array.from({ length: 501 }, (_, i) => i + 1), 4)],
    ['creditCollaborator, ids that are not a list', (t: TransactionsResource) => t.creditCollaborator(71 as unknown as number[], 4)],
    ['creditCollaborator, a zero collaborator', (t: TransactionsResource) => t.creditCollaborator([71], 0)],
    ['creditCollaborator, an empty type', (t: TransactionsResource) => t.creditCollaborator([71], 4, '')],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, transactions } = over([reply(200, TransactionAnswers.bulk)]);

    await expect(call(transactions)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
