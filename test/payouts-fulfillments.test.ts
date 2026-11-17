import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FulfillmentsResource,
  NotFoundError,
  PayoutsResource,
  Siren,
  SirenError,
  StoreKeyNotAllowedError,
  UnexpectedResponseError,
} from '../src/index';
import type { Fulfillment, Payout } from '../src/index';
import type { HttpTransport } from '../src/http';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';
import { BASE, expectRetried, page, pathOf, queryOf, transportOver } from './record-fakes';
import { notFoundById } from './record-fakes-2';
import { FulfillmentAnswers, PayoutAnswers } from './sdk-gaps-fakes';

/*
 * apps-sdk-gaps acceptance tests: payout and fulfillment reads.
 *
 * Siren Cloud serves these four routes to an API key, by
 * saas/Auth/ApiKeyRoutes.php at 20c47873d:
 *
 * - GET /payouts/{id}, with `ledger:payouts:read`, organization keys only.
 * - GET /fulfillments and GET /fulfillments/{id}, with
 *   `ledger:fulfillments:read`, organization keys only.
 *
 * `payouts.list()` was already in the SDK. The answers come from
 * test/sdk-gaps-fakes.ts, which cites the Cloud file behind each.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 */

beforeEach(failOnGlobalFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function payoutsOver(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, payouts: new PayoutsResource(built.transport) };
}

function fulfillmentsOver(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, fulfillments: new FulfillmentsResource(built.transport) };
}

describe('apps-sdk-gaps: the client carries both resources', () => {
  it('builds siren.payouts as a PayoutsResource and siren.fulfillments as a FulfillmentsResource', () => {
    const siren = new Siren({ apiKey: 'sk_live_x', httpClient: new FakeHttpClient([reply(200, {})]), baseUrl: BASE });

    expect(siren.payouts).toBeInstanceOf(PayoutsResource);
    expect(siren.fulfillments).toBeInstanceOf(FulfillmentsResource);
  });

  it('sends a read from both through the client the caller gave, with its key', async () => {
    const http = new FakeHttpClient([
      reply(200, PayoutAnswers.retrieved),
      reply(200, page([], 0)),
    ]);
    const siren = new Siren({ apiKey: 'sk_live_x', httpClient: http, baseUrl: BASE });

    await siren.payouts.retrieve(31);
    await siren.fulfillments.list();

    expect(http.requests.map((request) => pathOf(request))).toEqual(['/payouts/31', '/fulfillments']);
    for (const request of http.requests) {
      expect(new URL(request.url).origin).toBe(new URL(BASE).origin);
      expect(request.headers['Authorization']).toBe('Bearer sk_live_x');
    }
  });

  it('only reads, since Cloud keeps every payout and fulfillment write from an API key', () => {
    const { transport } = transportOver([reply(200, {})]);
    for (const resource of [new PayoutsResource(transport), new FulfillmentsResource(transport)]) {
      const methods = resource as unknown as Record<string, unknown>;
      for (const write of ['create', 'update', 'delete', 'bulk', 'markPaid', 'retry']) {
        expect(methods[write], write).toBeUndefined();
      }
    }
  });
});

describe('apps-sdk-gaps: payouts.retrieve', () => {
  it('reads GET /payouts/{id} and answers the default fields as Cloud sends them', async () => {
    const { http, payouts } = payoutsOver([reply(200, PayoutAnswers.retrieved)]);

    const payout: Payout = await payouts.retrieve(31);

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/payouts/31']);
    expect(queryOf(http.requests[0])).toEqual({});
    expect(payout).toEqual(PayoutAnswers.retrieved);
    expect(payout.waitingReason).toBe('stripe_account_missing');
  });

  it('sends fields comma-separated and include as given', async () => {
    const { http, payouts } = payoutsOver([reply(200, PayoutAnswers.extended)]);

    const payout = await payouts.retrieve(31, { fields: ['id', 'status', 'collaboratorEmail'], include: 'extended' });

    expect(queryOf(http.requests[0])).toEqual({ fields: 'id,status,collaboratorEmail', include: 'extended' });
    expect(payout.collaboratorEmail).toBe('ada@example.com');
  });

  it('throws NotFoundError for an id Cloud does not have', async () => {
    const { payouts } = payoutsOver([reply(404, notFoundById)]);

    await expect(payouts.retrieve(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  // saas/Auth/ApiKeyRecordMiddleware.php line 123.
  it('throws StoreKeyNotAllowedError for a key bound to one store', async () => {
    const { payouts } = payoutsOver([
      reply(403, {
        error: {
          message:
            'This API key is bound to one store, and these records are not kept by store. Use an organization-wide key.',
          code: 'store_key_not_allowed',
          context: { propertyId: 5 },
        },
      }),
    ]);

    await expect(payouts.retrieve(31)).rejects.toBeInstanceOf(StoreKeyNotAllowedError);
  });

  it('refuses an id that is not a positive whole number before sending', async () => {
    const { http, payouts } = payoutsOver([reply(200, PayoutAnswers.retrieved)]);

    for (const id of [0, -1, 1.5, Number.NaN, '31' as unknown as number]) {
      await expect(payouts.retrieve(id)).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it('throws UnexpectedResponseError when a 2xx body is not a JSON object', async () => {
    const { payouts } = payoutsOver([reply(200, [PayoutAnswers.retrieved])]);

    await expect(payouts.retrieve(31)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('retries, as a read', async () => {
    await expectRetried((transport: HttpTransport) => new PayoutsResource(transport).retrieve(31), reply(200, PayoutAnswers.retrieved));
  });

  it('keeps list() as it was, reading the list envelope', async () => {
    const { http, payouts } = payoutsOver([reply(200, page([PayoutAnswers.retrieved], 1))]);

    const list = await payouts.list({ status: 'unpaid' });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/payouts']);
    expect(queryOf(http.requests[0])).toEqual({ status: 'unpaid' });
    expect([...list]).toEqual([PayoutAnswers.retrieved]);
    expect(list.estimatedCount).toBe(1);
  });
});

describe('apps-sdk-gaps: fulfillments.list', () => {
  it('names the filters GET /fulfillments reads', () => {
    expect(FulfillmentsResource.LIST_FILTERS).toEqual(['status', 'payoutStatus', 'currency', 'from', 'to']);
  });

  it('lists GET /fulfillments with every filter and paging, and reads the envelope', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, page([FulfillmentAnswers.listed], 3, 25))]);

    const list = await fulfillments.list({
      status: 'pending',
      payoutStatus: 'failed',
      currency: 'USD',
      from: '2026-11-01',
      to: '2026-11-30',
      number: 25,
      orderBy: 'dateCreated',
      order: 'ASC',
    });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/fulfillments']);
    expect(queryOf(http.requests[0])).toEqual({
      status: 'pending',
      payoutStatus: 'failed',
      currency: 'USD',
      from: '2026-11-01',
      to: '2026-11-30',
      number: '25',
      orderBy: 'dateCreated',
      order: 'ASC',
    });
    expect([...list]).toEqual([FulfillmentAnswers.listed]);
    expect(list.estimatedCount).toBe(3);
  });

  it('turns page and perPage into number and offset', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, page([], 0))]);

    await fulfillments.list({ page: 3, perPage: 20 });

    expect(queryOf(http.requests[0])).toEqual({ number: '20', offset: '40' });
  });

  it('refuses a key the route does not read, propertyId included, before sending', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, page([], 0))]);

    for (const params of [{ propertyId: 5 }, { collaboratorId: 4 }, { s: 'x' }]) {
      await expect(fulfillments.list(params as never)).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a from or to that is not a real day, before sending', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, page([], 0))]);

    await expect(fulfillments.list({ from: '2026-02-30' })).rejects.toThrow(
      'fulfillments.list() needs from as a day, YYYY-MM-DD, and got "2026-02-30".',
    );
    await expect(fulfillments.list({ to: '11/30/2026' })).rejects.toThrow(
      'fulfillments.list() needs to as a day, YYYY-MM-DD, and got "11/30/2026".',
    );
    expect(http.requests).toHaveLength(0);
  });

  it.each(['payoutStatus', 'currency'] as const)(
    'refuses a %s of "", which Siren reads as no filter, before sending',
    async (key) => {
      const { http, fulfillments } = fulfillmentsOver([reply(200, page([], 0))]);

      await expect(fulfillments.list({ [key]: '' })).rejects.toThrow(
        `fulfillments.list() cannot send a ${key} of "", which Siren reads as no filter and answers every fulfillment.`,
      );
      expect(http.requests).toHaveLength(0);
    },
  );

  it.each(['payoutStatus', 'currency'] as const)(
    'refuses a %s that is not one string, a list included, before sending',
    async (key) => {
      const { http, fulfillments } = fulfillmentsOver([reply(200, page([], 0))]);

      for (const value of [['failed', 'paid'], 5, null]) {
        await expect(fulfillments.list({ [key]: value } as never)).rejects.toThrow(
          `fulfillments.list() takes one ${key} as a string, since Siren matches it as one value.`,
        );
      }
      expect(http.requests).toHaveLength(0);
    },
  );

  it('throws UnexpectedResponseError when a 2xx body is not a record list', async () => {
    const { fulfillments } = fulfillmentsOver([reply(200, { error: 'Something went wrong.' })]);

    await expect(fulfillments.list()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('retries, as a read', async () => {
    await expectRetried((transport: HttpTransport) => new FulfillmentsResource(transport).list(), reply(200, page([], 0)));
  });
});

describe('apps-sdk-gaps: fulfillments.retrieve', () => {
  it('reads GET /fulfillments/{id} and answers the default fields as Cloud sends them', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, FulfillmentAnswers.retrieved)]);

    const fulfillment: Fulfillment = await fulfillments.retrieve(7);

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/fulfillments/7']);
    expect(queryOf(http.requests[0])).toEqual({});
    expect(fulfillment).toEqual(FulfillmentAnswers.retrieved);
  });

  it('answers the extended fields with each payout when asked', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, FulfillmentAnswers.extended)]);

    const fulfillment = await fulfillments.retrieve(7, { include: 'extended' });

    expect(queryOf(http.requests[0])).toEqual({ include: 'extended' });
    expect(fulfillment).toEqual(FulfillmentAnswers.extended);
    expect(fulfillment.payouts?.map((payout) => payout.status)).toEqual(['paid', 'unpaid']);
  });

  it('throws NotFoundError for an id Cloud does not have', async () => {
    const { fulfillments } = fulfillmentsOver([reply(404, notFoundById)]);

    await expect(fulfillments.retrieve(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an id that is not a positive whole number before sending', async () => {
    const { http, fulfillments } = fulfillmentsOver([reply(200, FulfillmentAnswers.retrieved)]);

    await expect(fulfillments.retrieve(0)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it('retries, as a read', async () => {
    await expectRetried(
      (transport: HttpTransport) => new FulfillmentsResource(transport).retrieve(7),
      reply(200, FulfillmentAnswers.retrieved),
    );
  });
});
