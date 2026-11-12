import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  ConversionBulkAction,
  ConversionStatus,
  ConversionsResource,
  NotFoundError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { writeRecordOrNothing } from '../src/resources/record-writes';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, pathOf, transportOver } from './record-fakes';
import { ConversionAnswers, notFoundById } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P8: the conversion writes on
 * ConversionsResource and the internal writeRecordOrNothing helper in
 * src/resources/record-writes.ts. Cases follow the Siren PHP SDK's
 * ConversionsTest (siren-php 0.3.0), with Cloud's answers from
 * test/record-fakes-2.ts. The reads (list and retrieve) keep their slice 2
 * tests.
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
  return { ...built, conversions: new ConversionsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new ConversionsResource(transport);

const create = { engagementId: 31, transactionId: 71, type: 'sale', status: ConversionStatus.Pending };

/** A 2xx body that is not JSON, as a proxy in front of Siren might send. */
const textReply = { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok' };

describe('P8: conversion writes surface', () => {
  it('names the bulk actions as Siren does', () => {
    expect(ConversionBulkAction).toEqual({
      Approve: 'approve',
      Reject: 'reject',
      MarkPending: 'markPending',
      Delete: 'delete',
      PermanentDelete: 'permanent_delete',
    });
  });
});

describe('P8: writeRecordOrNothing', () => {
  it.skip('sends the body once and answers the JSON object', async () => {
    const { http, transport } = transportOver([reply(200, { id: 1 })]);

    expect(await writeRecordOrNothing(transport, 'PUT', '/conversions/1', { status: 'approved' })).toEqual({ id: 1 });
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/conversions/1']);
    expect(bodyOf(http.requests[0])).toEqual({ status: 'approved' });
  });

  it.skip('answers null for a 204 and for a 200 with an empty body', async () => {
    expect(await writeRecordOrNothing(transportOver([reply(204)]).transport, 'PUT', '/x', {})).toBeNull();
    expect(await writeRecordOrNothing(transportOver([reply(200)]).transport, 'PUT', '/x', {})).toBeNull();
  });

  it.skip.each([
    ['a JSON array', reply(200, [{ id: 1 }])],
    ['a JSON string', reply(200, 'done')],
    ['a body that is not JSON', textReply],
  ])('throws UnexpectedResponseError with the 2xx status for %s', async (_label, answer) => {
    const error = await writeRecordOrNothing(transportOver([answer]).transport, 'POST', '/x', {}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
  });

  it.skip('is sent once', async () => {
    await expectSentOnce((transport) => writeRecordOrNothing(transport, 'PUT', '/x', {}), reply(200));
  });
});

describe('P8: conversions create', () => {
  it.skip('creates with POST /conversions and answers the conversion', async () => {
    const { http, conversions } = over([reply(201, ConversionAnswers.created)]);

    expect(await conversions.create(create)).toEqual(ConversionAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/conversions']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it.skip('throws UnexpectedResponseError when create answers no object', async () => {
    await expect(over([reply(201)]).conversions.create(create)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip.each([
    ['a zero engagementId', { ...create, engagementId: 0 }],
    ['a missing engagementId', { type: 'sale', status: ConversionStatus.Pending }],
    ['a zero transactionId', { ...create, transactionId: 0 }],
    ['a fractional obligationId', { ...create, obligationId: 1.5 }],
  ])('create refuses %s with SirenError before sending', async (_label, params) => {
    const { http, conversions } = over([reply(201, ConversionAnswers.created)]);

    await expect(conversions.create(params as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('P8: conversions update', () => {
  it.skip("updates with PUT /conversions/{id} and answers null for Siren's empty 200", async () => {
    const { http, conversions } = over([reply(200)]);

    expect(await conversions.update(61, { status: ConversionStatus.Approved })).toBeNull();
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/conversions/61']);
    expect(bodyOf(http.requests[0])).toEqual({ status: 'approved' });
  });

  it.skip('answers the record when a later Siren sends one', async () => {
    expect(await over([reply(200, ConversionAnswers.created)]).conversions.update(61, { type: 'lead' })).toEqual(
      ConversionAnswers.created,
    );
  });

  it.skip('raises NotFoundError for an unknown conversion, and UnexpectedResponseError for a body that is not an object', async () => {
    await expect(over([reply(404, notFoundById)]).conversions.update(99, { type: 'lead' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(over([textReply]).conversions.update(61, { type: 'lead' })).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('P8: conversions delete, bulk and types', () => {
  it.skip('deletes in two stages: the conversion marked deleted, then null', async () => {
    const { http, conversions } = over([reply(200, ConversionAnswers.softDeleted), reply(204)]);

    expect(await conversions.delete(61)).toEqual(ConversionAnswers.softDeleted);
    expect(await conversions.delete(61)).toBeNull();
    expect(http.requests.map((request) => [request.method, pathOf(request)])).toEqual([
      ['DELETE', '/conversions/61'],
      ['DELETE', '/conversions/61'],
    ]);
  });

  it.skip('raises a blocked delete as ConflictError', async () => {
    await expect(over([reply(409, ConversionAnswers.deleteBlocked)]).conversions.delete(61)).rejects.toBeInstanceOf(ConflictError);
  });

  it.skip('runs a bulk action with POST /conversions/bulk', async () => {
    const { http, conversions } = over([reply(200, ConversionAnswers.bulk)]);

    expect(await conversions.bulk(ConversionBulkAction.MarkPending, [61, 62])).toEqual(ConversionAnswers.bulk);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/conversions/bulk']);
    expect(http.requests[0]!.body).toBe('{"action":"markPending","ids":[61,62]}');
  });

  it.skip('reads the conversion types from GET /conversions/types, and retries', async () => {
    const { http, conversions } = over([reply(200, ConversionAnswers.types)]);

    expect(await conversions.types()).toEqual(ConversionAnswers.types);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/conversions/types']);
    await expectRetried((transport) => resource(transport).types(), reply(200, ConversionAnswers.types));
  });

  it.skip('types throws UnexpectedResponseError for a 2xx that is not an object', async () => {
    await expect(over([reply(200, [{ id: 'sale' }])]).conversions.types()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, ConversionAnswers.created));
    await expectSentOnce((transport) => resource(transport).update(61, { type: 'lead' }), reply(200));
    await expectSentOnce((transport) => resource(transport).delete(61), reply(204));
    await expectSentOnce((transport) => resource(transport).bulk(ConversionBulkAction.Approve, [61]), reply(200, ConversionAnswers.bulk));
  });

  it.skip.each([
    ['update', (c: ConversionsResource) => c.update(0, { type: 'lead' })],
    ['delete', (c: ConversionsResource) => c.delete(-1)],
    ['bulk, no ids', (c: ConversionsResource) => c.bulk(ConversionBulkAction.Approve, [])],
    ['bulk, a bad id', (c: ConversionsResource) => c.bulk(ConversionBulkAction.Approve, [Number.NaN])],
    ['bulk, 501 ids', (c: ConversionsResource) => c.bulk(ConversionBulkAction.Approve, Array.from({ length: 501 }, (_, i) => i + 1))],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, conversions } = over([reply(200, ConversionAnswers.bulk)]);

    await expect(call(conversions)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
