import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  ConflictError,
  CustomCurrenciesResource,
  CustomCurrencyType,
  NotFoundError,
  PermissionError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, transportOver } from './record-fakes';
import { CustomCurrencyAnswers } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P4: CustomCurrenciesResource, the
 * `/currencies/custom` routes. Cases follow the Siren PHP SDK's
 * CustomCurrenciesTest (siren-php 0.3.0), with Cloud's answers from
 * test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 */

const CODE_MESSAGE = 'Send a currency code as letters, digits, underscores and hyphens, such as STORE_CREDIT.';

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, currencies: new CustomCurrenciesResource(built.transport) };
}

const resource = (transport: HttpTransport) => new CustomCurrenciesResource(transport);

const create = {
  code: 'STORE_CREDIT',
  name: 'Store credit',
  symbol: 'SC',
  type: CustomCurrencyType.Internal,
  symbolPosition: 'before' as const,
  exchangeRate: 1,
  scale: 0,
  propertyIds: [5],
};

describe('P4: custom currencies surface', () => {
  it('names the filters list sends', () => {
    expect(CustomCurrenciesResource.LIST_FILTERS).toEqual(['type', 'code']);
  });
});

describe('P4: custom currencies reads', () => {
  it('lists GET /currencies/custom with type, code and paging', async () => {
    const { http, currencies } = over([reply(200, page([CustomCurrencyAnswers.listed], 1, 20))]);

    const list = await currencies.list({ type: CustomCurrencyType.Internal, code: ['STORE_CREDIT', 'POINTS'], number: 20 });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/currencies/custom']);
    expect(queryOf(http.requests[0])).toEqual({ type: 'internal', code: 'STORE_CREDIT,POINTS', number: '20' });
    expect([...list]).toEqual([CustomCurrencyAnswers.listed]);
    expect(list.estimatedCount).toBe(1);
  });

  it('retrieves by code through the list route, number 1, and answers the first row', async () => {
    const { http, currencies } = over([reply(200, page([CustomCurrencyAnswers.listed], 1, 1))]);

    expect(await currencies.retrieve('STORE_CREDIT', { fields: 'code,name' })).toEqual(CustomCurrencyAnswers.listed);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/currencies/custom']);
    expect(queryOf(http.requests[0])).toEqual({ code: 'STORE_CREDIT', number: '1', fields: 'code,name' });
  });

  it('retrieve answers null when Siren holds no such code', async () => {
    expect(await over([reply(200, page([], 0, 1))]).currencies.retrieve('NOPE')).toBeNull();
  });

  it('retrieve keeps its own code and number over anything else in params', async () => {
    const { http, currencies } = over([reply(200, page([], 0, 1))]);

    await currencies.retrieve('STORE_CREDIT', { code: 'OTHER', number: 50 } as never);

    expect(queryOf(http.requests[0])).toMatchObject({ code: 'STORE_CREDIT', number: '1' });
  });

  it('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).retrieve('STORE_CREDIT'), reply(200, page([CustomCurrencyAnswers.listed])));
  });
});

describe('P4: custom currencies writes', () => {
  it('creates with POST /currencies/custom and answers the currency', async () => {
    const { http, currencies } = over([reply(201, CustomCurrencyAnswers.created)]);

    expect(await currencies.create(create)).toEqual(CustomCurrencyAnswers.created);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/currencies/custom']);
    expect(bodyOf(http.requests[0])).toEqual(create);
  });

  it('updates with PUT /currencies/custom/{code}, sending only the given fields', async () => {
    const { http, currencies } = over([reply(200, CustomCurrencyAnswers.updated)]);

    expect(await currencies.update('STORE_CREDIT', { name: 'Shop credit' })).toEqual(CustomCurrencyAnswers.updated);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/currencies/custom/STORE_CREDIT']);
    expect(bodyOf(http.requests[0])).toEqual({ name: 'Shop credit' });
  });

  it('deletes with DELETE /currencies/custom/{code} and answers the programs it deactivated', async () => {
    const { http, currencies } = over([reply(200, CustomCurrencyAnswers.deleted)]);

    expect(await currencies.delete('STORE_CREDIT')).toEqual(CustomCurrencyAnswers.deleted);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['DELETE', '/currencies/custom/STORE_CREDIT']);
    expect(queryOf(http.requests[0])).toEqual({});
    expect(http.requests[0]!.body).toBeUndefined();
  });

  it('sends wipeLedger=true only when asked', async () => {
    const { http, currencies } = over([reply(200, CustomCurrencyAnswers.deleted)]);

    await currencies.delete('STORE_CREDIT', true);

    expect(queryOf(http.requests[0])).toEqual({ wipeLedger: 'true' });
  });

  it('throws UnexpectedResponseError when a delete answers no object', async () => {
    await expect(over([reply(204)]).currencies.delete('STORE_CREDIT')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.each([
    ['a blocked delete as ConflictError', 409, CustomCurrencyAnswers.deleteBlocked, ConflictError],
    ['an unknown code as NotFoundError', 404, CustomCurrencyAnswers.notFound, NotFoundError],
  ] as const)('raises %s', async (_label, status, body, type) => {
    await expect(over([reply(status, body)]).currencies.delete('STORE_CREDIT')).rejects.toBeInstanceOf(type);
  });

  it('raises a refused scale change as BadRequestError', async () => {
    await expect(
      over([reply(400, CustomCurrencyAnswers.scaleLocked)]).currencies.update('STORE_CREDIT', { name: 'x', scale: 2 } as never),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('raises the Essentials gate as PermissionError with its code', async () => {
    const error = await over([reply(403, CustomCurrencyAnswers.planRequired)])
      .currencies.create(create)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).code).toBe('plan_required');
  });

  it('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(create), reply(201, CustomCurrencyAnswers.created));
    await expectSentOnce((transport) => resource(transport).update('STORE_CREDIT', { name: 'x' }), reply(200, CustomCurrencyAnswers.updated));
    await expectSentOnce((transport) => resource(transport).delete('STORE_CREDIT'), reply(200, CustomCurrencyAnswers.deleted));
  });
});

describe('P4: custom currency codes', () => {
  it.each([
    ['retrieve', (c: CustomCurrenciesResource, code: string) => c.retrieve(code)],
    ['create', (c: CustomCurrenciesResource, code: string) => c.create({ ...create, code })],
    ['update', (c: CustomCurrenciesResource, code: string) => c.update(code, { name: 'x' })],
    ['delete', (c: CustomCurrenciesResource, code: string) => c.delete(code)],
  ])('%s refuses a code that is empty, holds a slash, a comma or a space, or is not a string', async (_name, call) => {
    for (const code of ['', 'STORE/CREDIT', 'A,B', 'STORE CREDIT', '../x', 7 as unknown as string]) {
      const { http, currencies } = over([reply(200, CustomCurrencyAnswers.listed)]);

      const error = await call(currencies, code).catch((thrown: unknown) => thrown);

      expect(error, String(code)).toBeInstanceOf(SirenError);
      expect((error as SirenError).message).toBe(CODE_MESSAGE);
      expect(http.requests).toHaveLength(0);
    }
  });

  it('sends a code in its own case, so Siren decides what it accepts', async () => {
    const { http, currencies } = over([reply(200, CustomCurrencyAnswers.updated)]);

    await currencies.update('store-credit', { name: 'x' });

    expect(pathOf(http.requests[0])).toBe('/currencies/custom/store-credit');
  });

  it.each([
    ['propertyId', { propertyId: 5 }],
    ['a misspelt filter', { Code: 'X' }],
  ])('list refuses %s with SirenError naming the key, and sends nothing', async (_label, params) => {
    const { http, currencies } = over([reply(200, page([]))]);

    const error = await currencies.list(params as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(Object.keys(params)[0]!);
    expect(http.requests).toHaveLength(0);
  });

  it('list and retrieve throw UnexpectedResponseError for a 2xx that is not a list', async () => {
    await expect(over([reply(200, { error: 'x' })]).currencies.list()).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(over([reply(200, { error: 'x' })]).currencies.retrieve('STORE_CREDIT')).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
