import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotFoundError,
  Siren,
  SirenError,
  UnexpectedResponseError,
  type RetrieveParams,
} from '../src/index';
import { CloudAnswers } from './http-fakes';
import { emptyResponse, jsonResponse, makeClient } from './helpers';

/*
 * Slice 2 acceptance tests for packet P7: conversions.retrieve and
 * transactions.retrieve. The two run the same cases, so a rule cannot be
 * applied to one and missed on the other.
 *
 * Integration shape (KB 568): the real client, with the global fetch mocked
 * by makeClient and answered with Siren's GetConversionById and
 * GetTransactionById bodies at bb49b7d.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else here.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

type Retrieve = (client: Siren, id: number, params?: RetrieveParams) => Promise<Record<string, unknown>>;

const RESOURCES: Array<[string, string, Retrieve, Record<string, unknown>]> = [
  ['conversions', '/conversions', (client, id, params) => client.conversions.retrieve(id, params), CloudAnswers.conversion],
  ['transactions', '/transactions', (client, id, params) => client.transactions.retrieve(id, params), CloudAnswers.transaction],
];

describe.each(RESOURCES)('P7: %s.retrieve', (_name, path, retrieve, record) => {
  it.skip('reads one record with GET {path}/{id} and answers the body', async () => {
    const ctx = makeClient([jsonResponse(200, record)]);

    const found = await retrieve(ctx.client, 7);

    expect(found).toEqual(record);
    expect(ctx.calls()).toHaveLength(1);
    expect(ctx.lastCall().method).toBe('GET');
    expect(ctx.lastCall().url).toBe(`https://api.sirenaffiliates.com/siren/v1${path}/7`);
    expect(ctx.lastCall().body).toBeUndefined();
  });

  it.skip('sends a fields list comma-separated, and include and propertyId as given', async () => {
    const ctx = makeClient([jsonResponse(200, record)]);

    await retrieve(ctx.client, 7, { fields: ['id', 'status'], include: 'extended', propertyId: 3 });
    const listed = new URL(ctx.lastCall().url);
    await retrieve(ctx.client, 7, { fields: 'id,dateCreated' });
    const joined = new URL(ctx.lastCall().url);

    expect(listed.pathname).toBe(`/siren/v1${path}/7`);
    expect(listed.searchParams.get('fields')).toBe('id,status');
    expect(listed.searchParams.get('include')).toBe('extended');
    expect(listed.searchParams.get('propertyId')).toBe('3');
    expect(joined.searchParams.get('fields')).toBe('id,dateCreated');
    expect(joined.searchParams.has('include')).toBe(false);
    expect(joined.searchParams.has('propertyId')).toBe(false);
  });

  it.skip('retries like a read on a 503', async () => {
    const ctx = makeClient([jsonResponse(503, {}), jsonResponse(200, record)], { maxRetries: 1 });

    expect(await retrieve(ctx.client, 7)).toEqual(record);
    expect(ctx.calls()).toHaveLength(2);
  });

  it.skip("raises Siren's 404 as NotFoundError with its message", async () => {
    const ctx = makeClient([jsonResponse(404, CloudAnswers.notFound)], { maxRetries: 2 });

    const error = await retrieve(ctx.client, 99).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('No record found with that ID.');
    expect(ctx.calls()).toHaveLength(1);
  });

  it.skip.each([
    ['zero', 0],
    ['a negative id', -4],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s with SirenError before sending', async (_label, id) => {
    const ctx = makeClient([jsonResponse(200, record)]);

    await expect(retrieve(ctx.client, id)).rejects.toBeInstanceOf(SirenError);
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it.skip.each([
    ['a list', () => jsonResponse(200, [record])],
    ['an empty body', () => emptyResponse(200)],
    ['a string', () => jsonResponse(200, 'ok')],
    ['null', () => jsonResponse(200, null)],
  ])('raises UnexpectedResponseError with the status and body when Siren answers %s', async (_label, answer) => {
    const response = answer();
    const sent = await response.clone().text();
    const ctx = makeClient([response]);

    const error = await retrieve(ctx.client, 7).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect((error as UnexpectedResponseError).data).toEqual(sent === '' ? undefined : JSON.parse(sent));
  });
});

describe('P7: the other ledger readers', () => {
  it('give obligations and payouts no retrieve, as the PHP SDK does', () => {
    const ctx = makeClient([jsonResponse(200, [])]);

    expect('retrieve' in ctx.client.obligations).toBe(false);
    expect('retrieve' in ctx.client.payouts).toBe(false);
  });
});
