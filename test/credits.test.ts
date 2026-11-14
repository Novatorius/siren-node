import { describe, expect, it } from 'vitest';
import {
  CreditHoldStatus,
  CreditsResource,
  HoldConflictError,
  HoldConflictReason,
  NotFoundError,
  PolicyError,
  RateLimitError,
  SirenError,
  UnexpectedResponseError,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, rateLimited, transportOver } from './record-fakes';
import { CreditAnswers } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P5: CreditsResource, the store credit
 * routes (`/credits/adjust`, `/credit-balances`, `/credit-entries`,
 * `/credit-holds`) and the collaborator's `creditBalances` field. Cases
 * follow the Siren PHP SDK's CreditsTest (siren-php 0.3.0), with Cloud's
 * answers from test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 */

const ZERO_MESSAGE = 'A credit adjustment amount must not be zero.';
const ENTRIES_MESSAGE = 'Send at least one of: collaboratorId, idempotencyKey.';
const HOLDS_MESSAGE = 'Send at least one of: collaboratorId, reference, idempotencyKey.';
const EXCLUDE_MESSAGE = 'Send excludeReference as hold:{platform}:{token}. Build it with CreditsResource.holdReference().';
const CURRENCY_MESSAGE = 'Send a currency code as letters, digits, underscores and hyphens, such as STORE_CREDIT.';
const REFERENCE_MESSAGE = 'Send reference as hold:{platform}:{token}. Build it with CreditsResource.holdReference().';

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, credits: new CreditsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new CreditsResource(transport);

describe('P5: credits surface', () => {
  it('names the hold limits Siren applies', () => {
    expect([
      CreditsResource.HOLD_MIN_TTL,
      CreditsResource.HOLD_MAX_TTL,
      CreditsResource.HOLD_DEFAULT_TTL,
      CreditsResource.HOLD_PLATFORM_MAX_LENGTH,
      CreditsResource.HOLD_TOKEN_MAX_LENGTH,
    ]).toEqual([60, 3600, 1800, 60, 120]);
  });

  it('names the filters each list sends', () => {
    expect(CreditsResource.ENTRY_FILTERS).toEqual(['collaboratorId', 'currency', 'sourceType', 'sourceId', 'description', 'idempotencyKey']);
    expect(CreditsResource.HOLD_FILTERS).toEqual(['collaboratorId', 'currency', 'status', 'reference', 'idempotencyKey']);
    expect(CreditsResource.BALANCE_FILTERS).toEqual(['collaboratorId', 'currency', 'excludeReference']);
    expect(CreditsResource.ID_FILTERS).toEqual({ one: ['collaboratorId'] });
  });

  it('names the hold statuses as Siren does', () => {
    expect(CreditHoldStatus).toEqual({ Active: 'active', Settled: 'settled', Released: 'released', Expired: 'expired' });
  });
});

describe('P5: credits adjust', () => {
  it('adjusts with POST /credits/adjust and answers the ledger entry', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.adjusted)]);

    expect(await credits.adjust(4, 'STORE_CREDIT', -250, 'Goodwill')).toEqual(CreditAnswers.adjusted);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/credits/adjust']);
    expect(http.requests[0]!.body).toBe('{"collaboratorId":4,"currency":"STORE_CREDIT","amount":-250,"description":"Goodwill"}');
  });

  it('leaves description out when none is given', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.adjusted)]);

    await credits.adjust(4, 'STORE_CREDIT', 500);

    expect(bodyOf(http.requests[0])).toEqual({ collaboratorId: 4, currency: 'STORE_CREDIT', amount: 500 });
  });

  it('refuses a zero amount with its own message before sending', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.adjusted)]);

    const error = await credits.adjust(4, 'STORE_CREDIT', 0).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(ZERO_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['a zero collaborator', (c: CreditsResource) => c.adjust(0, 'STORE_CREDIT', 5)],
    ['an empty currency', (c: CreditsResource) => c.adjust(4, '', 5)],
    ['a fractional amount', (c: CreditsResource) => c.adjust(4, 'STORE_CREDIT', 2.5)],
    ['an unsafe amount', (c: CreditsResource) => c.adjust(4, 'STORE_CREDIT', 2 ** 53)],
    ['a description that is not a string', (c: CreditsResource) => c.adjust(4, 'STORE_CREDIT', 5, 7 as unknown as string)],
  ])('adjust refuses %s with SirenError before sending', async (_label, call) => {
    const { http, credits } = over([reply(200, CreditAnswers.adjusted)]);

    await expect(call(credits)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it('sends adjust once', async () => {
    await expectSentOnce((transport) => resource(transport).adjust(4, 'STORE_CREDIT', 5), reply(200, CreditAnswers.adjusted));
  });
});

describe('P5: credits balances', () => {
  it("reads a collaborator's creditBalances field", async () => {
    const { http, credits } = over([reply(200, CreditAnswers.balancesRecord)]);

    expect(await credits.balances(4)).toEqual(CreditAnswers.balancesRecord.creditBalances);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/collaborators/4']);
    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,creditBalances' });
  });

  it.each([
    ['no creditBalances field', { id: 4 }],
    ['a field that is not a list', { id: 4, creditBalances: {} }],
    ['an entry that is not an object', { id: 4, creditBalances: ['STORE_CREDIT'] }],
  ])('throws UnexpectedResponseError with the status for %s, never an empty answer', async (_label, body) => {
    const error = await over([reply(200, body)])
      .credits.balances(4)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
  });

  it("raises a connected site's refused field as PolicyError", async () => {
    await expect(over([reply(403, CreditAnswers.fieldNotAllowed)]).credits.balances(4)).rejects.toBeInstanceOf(PolicyError);
  });

  it('reads checkout balances from GET /credit-balances', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.checkoutBalances)]);

    const rows = await credits.checkoutBalances(4);

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/credit-balances']);
    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '4' });
    expect([...rows]).toEqual(CreditAnswers.checkoutBalances.items);
  });

  it('sends currency and a built excludeReference when they are given', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.checkoutBalances)]);

    await credits.checkoutBalances(4, 'STORE_CREDIT', CreditsResource.holdReference('woocommerce', 'cart-9f2'));

    expect(queryOf(http.requests[0])).toEqual({
      collaboratorId: '4',
      currency: 'STORE_CREDIT',
      excludeReference: 'hold:woocommerce:cart-9f2',
    });
  });

  it.each([
    ['a reference with no prefix', 'woocommerce:cart-9f2'],
    ['a reference with the Property Siren adds', 'hold:woocommerce@property:5:cart-9f2'],
    ['a reference with a third part', 'hold:woocommerce:cart:9f2'],
    ['a reference with a comma', 'hold:woocommerce:a,b'],
    ['an empty reference', ''],
  ])('checkoutBalances refuses %s with its own message before sending', async (_label, reference) => {
    const { http, credits } = over([reply(200, CreditAnswers.checkoutBalances)]);

    const error = await credits.checkoutBalances(4, undefined, reference).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(EXCLUDE_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it('checkoutBalances throws UnexpectedResponseError for a 2xx that is not a list, or a row that is not an object', async () => {
    await expect(over([reply(200, { error: 'x' })]).credits.checkoutBalances(4)).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(over([reply(200, { items: ['STORE_CREDIT'] })]).credits.checkoutBalances(4)).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it("answers one currency's checkout row, or null when Siren sends none", async () => {
    const { http, credits } = over([reply(200, CreditAnswers.checkoutBalances), reply(200, { items: [] })]);

    expect(await credits.checkoutBalance(4, 'POINTS')).toEqual(CreditAnswers.checkoutBalances.items[1]);
    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '4', currency: 'POINTS' });
    expect(await credits.checkoutBalance(4, 'GIFT')).toBeNull();
  });

  it('checkoutBalance throws UnexpectedResponseError for a 2xx that is not a list, never null', async () => {
    await expect(over([reply(200, { error: 'x' })]).credits.checkoutBalance(4, 'POINTS')).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it('retries every balance read', async () => {
    await expectRetried((transport) => resource(transport).balances(4), reply(200, CreditAnswers.balancesRecord));
    await expectRetried((transport) => resource(transport).checkoutBalances(4), reply(200, CreditAnswers.checkoutBalances));
    await expectRetried((transport) => resource(transport).checkoutBalance(4, 'POINTS'), reply(200, CreditAnswers.checkoutBalances));
  });

  it.each([
    ['balances', (c: CreditsResource) => c.balances(0)],
    ['checkoutBalances', (c: CreditsResource) => c.checkoutBalances(-4)],
    ['checkoutBalance', (c: CreditsResource) => c.checkoutBalance(1.5, 'POINTS')],
  ])('%s refuses an id that is not a positive whole number before sending', async (_name, call) => {
    const { http, credits } = over([reply(200, CreditAnswers.checkoutBalances)]);

    await expect(call(credits)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('P5: credits ledger and hold lists', () => {
  it('lists GET /credit-entries with the filters and paging', async () => {
    const { http, credits } = over([reply(200, page([CreditAnswers.entry], 1, 50))]);

    const list = await credits.entries({ collaboratorId: 4, currency: 'STORE_CREDIT', number: 50, orderBy: 'amount' });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/credit-entries']);
    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '4', currency: 'STORE_CREDIT', number: '50', orderBy: 'amount' });
    expect([...list]).toEqual([CreditAnswers.entry]);
    expect(list.estimatedCount).toBe(1);
  });

  it('lists entries by idempotencyKey alone', async () => {
    const { http, credits } = over([reply(200, page([CreditAnswers.entry]))]);

    await credits.entries({ idempotencyKey: 'order-91' });

    expect(queryOf(http.requests[0])).toEqual({ idempotencyKey: 'order-91' });
  });

  it.each([
    ['no filter', {}],
    ['only a currency', { currency: 'STORE_CREDIT' }],
    ['a blank idempotencyKey', { idempotencyKey: '  ' }],
    ['a zero collaborator', { collaboratorId: 0 }],
  ])('entries refuses %s with its own message before sending', async (_label, params) => {
    const { http, credits } = over([reply(200, page([]))]);

    const error = await credits.entries(params).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(ENTRIES_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it('lists GET /credit-holds by reference and status', async () => {
    const { http, credits } = over([reply(200, page([CreditAnswers.hold]))]);

    const list = await credits.holds({ reference: CreditsResource.holdReference('woocommerce', 'cart-9f2'), status: CreditHoldStatus.Active });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/credit-holds']);
    expect(queryOf(http.requests[0])).toEqual({ reference: 'hold:woocommerce:cart-9f2', status: 'active' });
    expect([...list]).toEqual([CreditAnswers.hold]);
  });

  it.each([
    ['no filter', {}],
    ['only a status', { status: CreditHoldStatus.Active }],
    ['a blank reference', { reference: '' }],
    ['a blank idempotencyKey', { idempotencyKey: ' ' }],
  ])('holds refuses %s with its own message before sending', async (_label, params) => {
    const { http, credits } = over([reply(200, page([]))]);

    const error = await credits.holds(params).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(HOLDS_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it('holds refuses a reference that holdReference would not build', async () => {
    const { http, credits } = over([reply(200, page([]))]);

    const error = await credits.holds({ reference: 'hold:woocommerce@property:5:cart-9f2' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(REFERENCE_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['entries', (c: CreditsResource) => c.entries({ collaboratorId: 4, sourceID: 'x' } as never), 'sourceID'],
    ['entries, a list of collaborators', (c: CreditsResource) => c.entries({ idempotencyKey: 'order-91', collaboratorId: [4, 5] } as never), 'collaboratorId'],
    ['entries, a zero collaborator beside a key', (c: CreditsResource) => c.entries({ idempotencyKey: 'order-91', collaboratorId: 0 }), 'collaboratorId'],
    ['holds, a zero collaborator beside a reference', (c: CreditsResource) => c.holds({ reference: 'hold:woocommerce:cart-9f2', collaboratorId: 0 }), 'collaboratorId'],
    ['holds, an empty status list', (c: CreditsResource) => c.holds({ collaboratorId: 4, status: [] }), 'status'],
    ['holds', (c: CreditsResource) => c.holds({ collaboratorId: 4, propertyId: 5 } as never), 'propertyId'],
  ])('%s refuses a key it does not send, naming it', async (_name, call, key) => {
    const { http, credits } = over([reply(200, page([]))]);

    const error = await call(credits).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(key);
    expect(http.requests).toHaveLength(0);
  });

  it('retries both lists', async () => {
    await expectRetried((transport) => resource(transport).entries({ collaboratorId: 4 }), reply(200, page([])));
    await expectRetried((transport) => resource(transport).holds({ collaboratorId: 4 }), reply(200, page([])));
  });
});

describe('P5: credits holds', () => {
  it('places a hold with POST /credit-holds and answers it', async () => {
    const { http, credits } = over([reply(201, CreditAnswers.hold)]);

    expect(await credits.placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce')).toEqual(CreditAnswers.hold);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/credit-holds']);
    expect(http.requests[0]!.body).toBe(
      '{"collaboratorId":4,"currency":"STORE_CREDIT","amount":250,"token":"cart-9f2","platformId":"woocommerce"}',
    );
  });

  it('sends ttl when it is given', async () => {
    const { http, credits } = over([reply(201, CreditAnswers.hold)]);

    await credits.placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce', 900);

    expect(bodyOf(http.requests[0])).toMatchObject({ ttl: 900 });
  });

  it.each([
    ['hold_no_credit', CreditAnswers.holdNoCredit, HoldConflictReason.NoCredit],
    ['hold_token_in_use', CreditAnswers.holdTokenInUse, HoldConflictReason.TokenInUse],
    ['hold_currency_not_at_store', CreditAnswers.holdCurrencyNotAtStore, null],
  ])('raises a 409 %s as HoldConflictError with its reason', async (code, body, reason) => {
    const error = await over([reply(409, body)])
      .credits.placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HoldConflictError);
    expect((error as HoldConflictError).code).toBe(code);
    expect((error as HoldConflictError).reason).toBe(reason);
    expect((error as HoldConflictError).message).toBe(body.error.message);
  });

  it('raises a 409 with no code as HoldConflictError, reading the reason from the wording', async () => {
    const error = await over([reply(409, { error: 'Another checkout already holds credit under that token.' })])
      .credits.placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HoldConflictError);
    expect((error as HoldConflictError).reason).toBe(HoldConflictReason.TokenInUse);
  });

  it('leaves a 429 as RateLimitError, sent once', async () => {
    const { http, credits } = over([reply(429, rateLimited, { 'Retry-After': '0' }), reply(201, CreditAnswers.hold)]);

    await expect(credits.placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce')).rejects.toBeInstanceOf(RateLimitError);
    expect(http.requests).toHaveLength(1);
  });

  it('accepts a token and a platform at their longest, and both ttl limits', async () => {
    const { http, credits } = over([reply(201, CreditAnswers.hold)]);

    await credits.placeHold(4, 'STORE_CREDIT', 1, 't'.repeat(120), 'p'.repeat(60), 60);
    await credits.placeHold(4, 'STORE_CREDIT', 1, 'cart-9f2', 'woocommerce', 3600);

    expect(http.requests).toHaveLength(2);
  });

  it.each([
    ['a zero collaborator', (c: CreditsResource) => c.placeHold(0, 'STORE_CREDIT', 250, 'cart', 'woocommerce')],
    ['an empty currency', (c: CreditsResource) => c.placeHold(4, '', 250, 'cart', 'woocommerce')],
    ['a zero amount', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 0, 'cart', 'woocommerce')],
    ['a negative amount', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', -5, 'cart', 'woocommerce')],
    ['a fractional amount', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 2.5, 'cart', 'woocommerce')],
    ['a token with a colon', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 'cart:9f2', 'woocommerce')],
    ['an empty token', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, '', 'woocommerce')],
    ['a token over 120', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 't'.repeat(121), 'woocommerce')],
    ['a qualified platform', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 'cart', 'woocommerce@property:5')],
    ['a platform over 60', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 'cart', 'p'.repeat(61))],
    ['a ttl under 60', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 'cart', 'woocommerce', 59)],
    ['a ttl over 3600', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 'cart', 'woocommerce', 3601)],
    ['a fractional ttl', (c: CreditsResource) => c.placeHold(4, 'STORE_CREDIT', 250, 'cart', 'woocommerce', 90.5)],
  ])('placeHold refuses %s with SirenError before sending', async (_label, call) => {
    const { http, credits } = over([reply(201, CreditAnswers.hold)]);

    await expect(call(credits)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it('releases a hold with DELETE /credit-holds/{id} and answers it as Siren now stores it', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.released)]);

    expect(await credits.releaseHold(51)).toEqual(CreditAnswers.released);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['DELETE', '/credit-holds/51']);
    expect(http.requests[0]!.body).toBeUndefined();
  });

  it('raises an unknown hold as NotFoundError, and a 2xx with no hold as UnexpectedResponseError', async () => {
    await expect(over([reply(404, CreditAnswers.holdNotFound)]).credits.releaseHold(99)).rejects.toBeInstanceOf(NotFoundError);
    await expect(over([reply(204)]).credits.releaseHold(51)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('releaseHold refuses an id that is not a positive whole number before sending', async () => {
    const { http, credits } = over([reply(200, CreditAnswers.released)]);

    await expect(credits.releaseHold(0)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it('sends placeHold and releaseHold once', async () => {
    await expectSentOnce(
      (transport) => resource(transport).placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce'),
      reply(201, CreditAnswers.hold),
    );
    await expectSentOnce((transport) => resource(transport).releaseHold(51), reply(200, CreditAnswers.released));
  });
});

describe('P5: credits holdReference', () => {
  it('builds hold:{platform}:{token}', () => {
    expect(CreditsResource.holdReference('woocommerce', 'cart-9f2')).toBe('hold:woocommerce:cart-9f2');
  });

  it.each([
    ['a platform with a colon', 'woo:commerce', 'cart'],
    ['a qualified platform', 'woocommerce@property:5', 'cart'],
    ['an empty token', 'woocommerce', ''],
    ['a token over 120', 'woocommerce', 't'.repeat(121)],
    ['a platform over 60', 'p'.repeat(61), 'cart'],
  ])('refuses %s with SirenError', (_label, platformId, token) => {
    expect(() => CreditsResource.holdReference(platformId, token)).toThrow(SirenError);
  });
});

describe('P5: credits currency codes', () => {
  it.each([
    ['adjust', (c: CreditsResource) => c.adjust(4, 'STORE:CREDIT', 5)],
    ['placeHold', (c: CreditsResource) => c.placeHold(4, 'a,b', 250, 'cart-9f2', 'woocommerce')],
    ['checkoutBalances', (c: CreditsResource) => c.checkoutBalances(4, 'STORE CREDIT')],
    ['checkoutBalance', (c: CreditsResource) => c.checkoutBalance(4, 'STORE/CREDIT')],
    ['entries', (c: CreditsResource) => c.entries({ collaboratorId: 4, currency: 'a:b' })],
    ['holds', (c: CreditsResource) => c.holds({ collaboratorId: 4, currency: '' })],
  ])('%s refuses a currency that is not a code, with its own message, before sending', async (_name, call) => {
    const { http, credits } = over([reply(200, page([]))]);

    const error = await call(credits).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(CURRENCY_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });
});

describe('P5: a checkout through one transport', () => {
  it("reads the balance, places a hold, finds it by reference and releases it, in Siren's order", async () => {
    const { http, credits } = over([
      reply(200, CreditAnswers.checkoutBalances),
      reply(201, CreditAnswers.hold),
      reply(200, page([CreditAnswers.hold])),
      reply(200, CreditAnswers.released),
    ]);
    const reference = CreditsResource.holdReference('woocommerce', 'cart-9f2');

    expect(await credits.checkoutBalance(4, 'STORE_CREDIT', reference)).not.toBeNull();
    const placed = await credits.placeHold(4, 'STORE_CREDIT', 250, 'cart-9f2', 'woocommerce');
    const [found] = [...(await credits.holds({ reference }))];
    const released = await credits.releaseHold(found!.id);

    expect(placed.id).toBe(found!.id);
    expect(released.status).toBe(CreditHoldStatus.Released);
    expect(http.requests.map((request) => [request.method, pathOf(request), queryOf(request)])).toEqual([
      ['GET', '/credit-balances', { collaboratorId: '4', currency: 'STORE_CREDIT', excludeReference: 'hold:woocommerce:cart-9f2' }],
      ['POST', '/credit-holds', {}],
      ['GET', '/credit-holds', { reference: 'hold:woocommerce:cart-9f2' }],
      ['DELETE', `/credit-holds/${CreditAnswers.hold.id}`, {}],
    ]);
  });
});
