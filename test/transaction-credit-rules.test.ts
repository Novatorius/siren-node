import { describe, expect, it } from 'vitest';
import { SirenError, TransactionsResource } from '../src/index';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { TransactionAnswers } from './record-fakes-2';

/*
 * Unit tests for the checks inside TransactionsResource.creditCollaborator
 * (slice 4 packet P9) that test/transaction-writes.test.ts leaves open: the
 * 500 id ceiling seen from the side that is sent, and a `type` that is not a
 * string at all.
 */

function over() {
  const built = transportOver([reply(200, TransactionAnswers.credited)]);
  return { ...built, transactions: new TransactionsResource(built.transport) };
}

describe('P9 unit: creditCollaborator checks', () => {
  it('sends 500 ids, the most Siren takes', async () => {
    const { http, transactions } = over();
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);

    await transactions.creditCollaborator(ids, 4);

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0])).toEqual({ transactionIds: ids, collaboratorId: 4 });
  });

  it.each([
    ['a number', 7],
    ['null', null],
  ])('refuses a type that is %s before sending', async (_label, type) => {
    const { http, transactions } = over();

    await expect(transactions.creditCollaborator([71], 4, type as unknown as string)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
