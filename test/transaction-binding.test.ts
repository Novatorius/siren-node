import { describe, expect, it } from 'vitest';
import { ConflictError, SirenError, TransactionsResource } from '../src/index';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { TransactionAnswers } from './record-fakes-2';

/*
 * Slice 4 contract fix, packet F2: the binding pair on
 * `transactions.create`. Siren finds a resent transaction, and answers its
 * 409, only when both `bindingId` and `bindingDataType` are set and PHP reads
 * both as true (TransactionCreateService.php line 107 at b6f7140, `$bindingId
 * && $bindingDataType`). A half binding, or a binding field of "", "0" or 0,
 * passes Cloud's validation (CreateTransaction.php, both fields nullable)
 * and is then dropped without a word, so a resend records a second
 * transaction. The SDK refuses both before sending.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam, aimed at example.invalid.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * packet F2, named in its describe block. The F2 implementer deletes the
 * `.skip` from each of them, so `it.skip(` becomes `it(` and `it.skip.each(`
 * becomes `it.each(`, and deletes the one-line comment above each, and this
 * paragraph. Nothing else here changes. The tests with no `.skip` pass now
 * and guard against a check that refuses too much.
 */

const HALF = 'transactions.create() needs bindingId and bindingDataType together, or neither. Siren finds a resent transaction only by both.';

const details = [{ name: 'Mug', value: 1200, quantity: 2 }];

function over() {
  const built = transportOver([reply(201, TransactionAnswers.created)]);
  return { ...built, transactions: new TransactionsResource(built.transport) };
}

describe('4 fix F2: transactions.create binding pair', () => {
  // Skipped until fix packet F2 (the binding pair) lands.
  it.skip.each([
    ['a bindingId alone', { bindingId: 'order-91' }],
    ['a numeric bindingId alone', { bindingId: 91 }],
    ['a bindingDataType alone', { bindingDataType: 'crm_order' }],
    ['a bindingId with a null bindingDataType', { bindingId: 'order-91', bindingDataType: null }],
    ['a bindingDataType with an undefined bindingId', { bindingId: undefined, bindingDataType: 'crm_order' }],
  ])('refuses %s before sending, with one message', async (_label, binding) => {
    const { http, transactions } = over();

    const error = await transactions.create({ details, ...binding } as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(HALF);
    expect(http.requests).toHaveLength(0);
  });

  // Skipped until fix packet F2 (the binding pair) lands.
  it.skip.each([
    ['bindingId', '', '""'],
    ['bindingId', '0', '"0"'],
    ['bindingId', 0, '0'],
    ['bindingDataType', '', '""'],
    ['bindingDataType', '0', '"0"'],
  ])('refuses a %s of %j, which Siren reads as no binding, before sending', async (key, value, shown) => {
    const { http, transactions } = over();
    const binding = { bindingId: 'order-91', bindingDataType: 'crm_order', [key]: value };

    const error = await transactions.create({ details, ...binding } as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(`transactions.create() cannot send ${key} ${shown}, which Siren reads as no binding.`);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['both binding fields', { bindingId: 'order-91', bindingDataType: 'crm_order' }],
    ['a numeric bindingId with its type', { bindingId: 91, bindingDataType: 'crm_order' }],
    ['a bindingId of "00", which Siren reads as set', { bindingId: '00', bindingDataType: 'crm_order' }],
    ['neither binding field', {}],
    ['both binding fields null', { bindingId: null, bindingDataType: null }],
  ])('sends %s as given', async (_label, binding) => {
    const { http, transactions } = over();

    expect(await transactions.create({ details, ...binding } as never)).toEqual(TransactionAnswers.created);
    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0])).toEqual({ details, ...binding });
  });

  it('raises the resend of a bound transaction as ConflictError, which means the first send worked', async () => {
    const built = transportOver([reply(409, TransactionAnswers.bindingExists)]);
    const transactions = new TransactionsResource(built.transport);

    await expect(transactions.create({ details, bindingId: 'order-91', bindingDataType: 'crm_order' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
