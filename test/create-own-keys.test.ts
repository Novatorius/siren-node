import { describe, expect, it } from 'vitest';
import {
  ConversionsResource,
  CustomCurrenciesResource,
  EngagementsResource,
  SirenError,
  TransactionsResource,
} from '../src/index';
import { reply } from './http-fakes';
import { page, queryOf, transportOver } from './record-fakes';
import { TransactionAnswers } from './record-fakes-2';

/*
 * Slice 4 re-review, fix 1: each check reads the same values the request
 * carries. The allow lists build the body from the caller's own keys, each
 * read once (`pickFields`). A check that read `params` again could see an
 * inherited key the body leaves out, or a getter's second answer, and pass
 * a request it would have refused. On `transactions.create` that sent half
 * a binding, which Siren dedupes on neither field, so a resend recorded a
 * second transaction. On `conversions.recoverCreate` the read asked for the
 * inherited `transactionId` while the create it sent left it out.
 *
 * Integration shape (KB 568): the real resources over the real
 * HttpTransport, with a FakeHttpClient at the HttpClient seam, aimed at
 * example.invalid.
 */

const details = [{ name: 'Mug', value: 1200, quantity: 2 }];

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

describe('4 re-review fix 1: checks read the values the request carries', () => {
  it('transactions.create refuses an inherited bindingId beside an own bindingDataType, before sending', async () => {
    const built = transportOver([reply(201, TransactionAnswers.created)]);
    const transactions = new TransactionsResource(built.transport);

    const error = await transactions
      .create(inheriting({ bindingId: 'order-91' }, { details, bindingDataType: 'crm_order' }) as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      'transactions.create() needs bindingId and bindingDataType together, or neither. Siren finds a resent transaction only by both.',
    );
    expect(built.http.requests).toHaveLength(0);
  });

  it('transactions.create checks the bindingId it sends, when a getter answers "" first', async () => {
    const built = transportOver([reply(201, TransactionAnswers.created)]);
    const transactions = new TransactionsResource(built.transport);

    const error = await transactions
      .create(shifting({ details, bindingDataType: 'crm_order' }, 'bindingId', '', 'order-91') as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe('transactions.create() cannot send bindingId "", which Siren reads as no binding.');
    expect(built.http.requests).toHaveLength(0);
  });

  it('conversions.recoverCreate refuses an inherited transactionId, before reading or sending', async () => {
    const built = transportOver([reply(200, page([])), reply(201, { id: 61 })]);
    const conversions = new ConversionsResource(built.transport);

    const error = await conversions
      .recoverCreate(inheriting({ transactionId: 71 }, { engagementId: 31, type: 'sale', status: 'pending' }) as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      'conversions.recoverCreate() needs a transactionId to find the first send. Without one, Siren cannot tell whether the create landed.',
    );
    expect(built.http.requests).toHaveLength(0);
  });

  it('conversions.create refuses an inherited engagementId, before sending', async () => {
    const built = transportOver([reply(201, { id: 61 })]);
    const conversions = new ConversionsResource(built.transport);

    const error = await conversions
      .create(inheriting({ engagementId: 31 }, { type: 'sale', status: 'pending' }) as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain('engagementId');
    expect(built.http.requests).toHaveLength(0);
  });

  it('customCurrencies.create refuses an inherited code, before sending', async () => {
    const built = transportOver([reply(201, { code: 'PTS' })]);
    const currencies = new CustomCurrenciesResource(built.transport);

    const error = await currencies
      .create(inheriting({ code: 'PTS' }, { name: 'Points', propertyIds: [3] }) as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect(built.http.requests).toHaveLength(0);
  });

  it('engagements.list sends the from it checked, when a getter answers a day first', async () => {
    const built = transportOver([reply(200, page([]))]);
    const engagements = new EngagementsResource(built.transport);

    await engagements.list(shifting({}, 'from', '2026-01-01', 'not-a-day') as never);

    expect(built.http.requests).toHaveLength(1);
    expect(queryOf(built.http.requests[0])).toMatchObject({ from: '2026-01-01' });
  });
});
