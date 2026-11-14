import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ConversionStatus,
  ConversionsResource,
  CreditsResource,
  DistributorsResource,
  SirenError,
  TransactionsResource,
  UnexpectedResponseError,
} from '../src/index';
import type { CreateConversionParams } from '../src/index';
import type { HttpRequest } from '../src/http';
import { reply } from './http-fakes';
import { page, queryOf, transportOver, unavailable } from './record-fakes';
import { ConversionAnswers, CreditAnswers, DistributorAnswers, TransactionAnswers } from './record-fakes-2';

/*
 * Slice 4 polish, after the re-review of PR 56. Each case closes a gap the
 * slice 4 review or its re-review left open:
 *
 * - A binding field that JSON cannot carry. `JSON.stringify` writes NaN,
 *   Infinity and -Infinity as null, and Siren reads a null binding field as
 *   no binding (TransactionCreateService.php line 107 at b6f7140), so a
 *   resend records a second transaction. Ruling O6.
 * - An empty page whose total says rows exist. GetConversions.php reads the
 *   rows with `where` and the total with `countWhere`, two queries, and
 *   `where` answers [] when a row cannot be loaded. A write that lands
 *   between the two, or a row that fails to load, gives an empty page with
 *   a total above 0. That page does not show the first send failed.
 * - Credits reads that threw a raw TypeError, checked a filter the request
 *   did not carry, or sent with no collaborator.
 * - conversions.update sending ids create refuses, and distributors.list
 *   sending a metricType of "", which GetDistributors.php reads as no filter.
 *
 * Integration shape (KB 568): the real resources over the real
 * HttpTransport, with a FakeHttpClient at the HttpClient seam, aimed at
 * example.invalid. Nothing here reaches the network.
 */

const details = [{ name: 'Mug', value: 1200, quantity: 2 }];

const create = { engagementId: 31, transactionId: 71, type: 'sale', status: ConversionStatus.Pending };

/** A conversion row as GET /conversions answers it for recoverCreditCollaborator's fields. */
function credit(transactionId: number) {
  return { id: 600 + transactionId, transactionId, collaboratorId: 42, type: 'sale' };
}

function writes(requests: HttpRequest[]): HttpRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}

/** An object whose prototype holds `inherited`, with `own` as its own keys. */
function inheriting<T extends object>(inherited: object, own: T): T {
  return Object.assign(Object.create(inherited) as object, own) as T;
}

/** An object whose `key` getter answers `first`, then `later` on every read after. */
function shifting(own: object, key: string, first: unknown, later: unknown): object {
  let reads = 0;
  return Object.defineProperty({ ...own }, key, {
    enumerable: true,
    get: () => (reads++ === 0 ? first : later),
  });
}

describe('4 polish: transactions.create refuses a binding JSON cannot carry', () => {
  it.each([
    ['bindingId', Number.NaN, 'NaN'],
    ['bindingId', Number.POSITIVE_INFINITY, 'Infinity'],
    ['bindingId', Number.NEGATIVE_INFINITY, '-Infinity'],
    ['bindingDataType', Number.NaN, 'NaN'],
  ])('refuses a %s of %s before sending, with its own message', async (key, value, shown) => {
    const built = transportOver([reply(201, TransactionAnswers.created)]);
    const transactions = new TransactionsResource(built.transport);
    const binding = { bindingId: 'order-91', bindingDataType: 'crm_order', [key]: value };

    const error = await transactions.create({ details, ...binding } as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      `transactions.create() cannot send ${key} ${shown}, which JSON writes as null and Siren reads as no binding.`,
    );
    expect(built.http.requests).toHaveLength(0);
  });

  it('sends a large finite numeric bindingId as given', async () => {
    const built = transportOver([reply(201, TransactionAnswers.created)]);
    const transactions = new TransactionsResource(built.transport);

    await transactions.create({ details, bindingId: 2 ** 53, bindingDataType: 'crm_order' });

    expect(built.http.requests).toHaveLength(1);
  });
});

describe('4 polish: recovery refuses an empty page whose total says rows exist', () => {
  it.each([
    ['an empty items list with a total of 1', reply(200, page([], 1))],
    ['an empty JSON array whose count header says 1', reply(200, [], { 'x-siren-estimated-count': '1' })],
  ])('conversions.recoverCreate raises with the status for %s and never sends again', async (_label, answer) => {
    const built = transportOver([unavailable(), answer, reply(201, ConversionAnswers.created)]);
    const conversions = new ConversionsResource(built.transport);
    await expect(conversions.create(create)).rejects.toBeInstanceOf(ApiError);

    const error = await conversions.recoverCreate(create).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect(writes(built.http.requests)).toHaveLength(1);
  });

  it('transactions.recoverCreditCollaborator raises with the status for an empty first page with a total of 2, and never sends again', async () => {
    const built = transportOver([unavailable(), reply(200, page([], 2, 200, 0)), reply(200, TransactionAnswers.credited)]);
    const transactions = new TransactionsResource(built.transport);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    const error = await transactions.recoverCreditCollaborator([71, 72], 42).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect(writes(built.http.requests)).toHaveLength(1);
  });

  it('transactions.recoverCreditCollaborator raises for an empty later page whose total is above the rows read, and never sends again', async () => {
    const built = transportOver([
      unavailable(),
      reply(200, page([credit(71)], 3, 200, 0)),
      reply(200, page([], 3, 200, 1)),
      reply(200, TransactionAnswers.credited),
    ]);
    const transactions = new TransactionsResource(built.transport);
    await expect(transactions.creditCollaborator([71, 72, 73], 42)).rejects.toBeInstanceOf(ApiError);

    const error = await transactions.recoverCreditCollaborator([71, 72, 73], 42).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect(writes(built.http.requests)).toHaveLength(1);
  });

  it('transactions.recoverCreditCollaborator ends on an empty page whose total equals the rows read', async () => {
    const built = transportOver([
      unavailable(),
      reply(200, page([credit(71)], 1, 200, 0)),
      reply(200, page([], 1, 200, 1)),
      reply(200, TransactionAnswers.credited),
    ]);
    const transactions = new TransactionsResource(built.transport);
    await expect(transactions.creditCollaborator([71, 72], 42)).rejects.toBeInstanceOf(ApiError);

    expect(await transactions.recoverCreditCollaborator([71, 72], 42)).toEqual({
      alreadyCredited: [71],
      credited: [72],
      result: TransactionAnswers.credited,
    });
  });
});

describe('4 polish: credits reads refuse before sending', () => {
  function credits() {
    const built = transportOver([reply(200, page([CreditAnswers.entry])), reply(200, CreditAnswers.checkoutBalances)]);
    return { http: built.http, credits: new CreditsResource(built.transport) };
  }

  it.each([
    ['entries', (c: CreditsResource) => c.entries(undefined as never), 'Send at least one of: collaboratorId, idempotencyKey.'],
    ['holds', (c: CreditsResource) => c.holds(undefined as never), 'Send at least one of: collaboratorId, reference, idempotencyKey.'],
  ])('%s with no argument throws its own SirenError, not a TypeError', async (_name, call, message) => {
    const { http, credits: resource } = credits();

    const error = await call(resource).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(message);
    expect(http.requests).toHaveLength(0);
  });

  it('checkoutBalances refuses a missing collaboratorId before sending', async () => {
    const { http, credits: resource } = credits();

    await expect(resource.checkoutBalances(undefined as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['entries', (c: CreditsResource) => c.entries(inheriting({ collaboratorId: 4 }, {}) as never), 'Send at least one of: collaboratorId, idempotencyKey.'],
    [
      'holds',
      (c: CreditsResource) => c.holds(inheriting({ reference: 'hold:woocommerce:cart-9f2' }, {}) as never),
      'Send at least one of: collaboratorId, reference, idempotencyKey.',
    ],
  ])('%s refuses a scope key it would not send, one the params only inherit', async (_name, call, message) => {
    const { http, credits: resource } = credits();

    const error = await call(resource).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(message);
    expect(http.requests).toHaveLength(0);
  });

  it('entries sends the collaboratorId it checked, when a getter answers it first', async () => {
    const { http, credits: resource } = credits();

    await resource.entries(shifting({}, 'collaboratorId', 4, undefined) as never);

    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '4' });
  });
});

describe('4 polish: conversions.update checks the ids create checks', () => {
  it.each([
    ['a zero engagementId', { engagementId: 0 }],
    ['a transactionId that is a string', { transactionId: '71' }],
    ['a fractional obligationId', { obligationId: 1.5 }],
  ])('refuses %s before sending', async (_label, params) => {
    const built = transportOver([reply(200)]);
    const conversions = new ConversionsResource(built.transport);

    await expect(conversions.update(61, params as never)).rejects.toBeInstanceOf(SirenError);
    expect(built.http.requests).toHaveLength(0);
  });

  it('sends good ids as given', async () => {
    const built = transportOver([reply(200)]);
    const conversions = new ConversionsResource(built.transport);

    expect(await conversions.update(61, { engagementId: 31, transactionId: 71, obligationId: 5 })).toBeNull();
    expect(built.http.requests).toHaveLength(1);
  });

  it('types the four statuses Siren creates and updates with, and not deleted', () => {
    const params: CreateConversionParams = {
      engagementId: 31,
      type: 'sale',
      // @ts-expect-error Siren's create and update routes refuse deleted (CreateNewConversion.php, UpdateConversion.php).
      status: ConversionStatus.Deleted,
    };
    const expired: CreateConversionParams = { engagementId: 31, type: 'sale', status: ConversionStatus.Expired };

    expect([params.status, expired.status]).toEqual(['deleted', 'expired']);
  });
});

describe('4 polish: distributors.list refuses a metricType Siren reads as no filter', () => {
  it('refuses a metricType of "" before sending, naming it', async () => {
    const built = transportOver([reply(200, DistributorAnswers.listed)]);
    const distributors = new DistributorsResource(built.transport);

    const error = await distributors.list({ metricType: '' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain('metricType');
    expect(built.http.requests).toHaveLength(0);
  });
});
