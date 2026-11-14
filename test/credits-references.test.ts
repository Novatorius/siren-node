import { describe, expect, it } from 'vitest';
import { CreditsResource, SirenError } from '../src/index';
import { reply } from './http-fakes';
import { page, queryOf, transportOver } from './record-fakes';
import { CreditAnswers } from './record-fakes-2';

/*
 * Unit tests for the hold reference check inside CreditsResource (slice 4
 * packet P5). `holds` and `checkoutBalances` take a reference only when it
 * is `hold:{platform}:{token}` as `CreditsResource.holdReference` builds it.
 * The acceptance tests in test/credits.test.ts pin the message and most
 * shapes. These cover the parts they leave open: the `hold` prefix, a
 * platform that is not a plain name, and the two length limits, each next
 * to a reference at the limit that is sent.
 */

const REFERENCE_MESSAGE = 'Send reference as hold:{platform}:{token}. Build it with CreditsResource.holdReference().';
const EXCLUDE_MESSAGE = 'Send excludeReference as hold:{platform}:{token}. Build it with CreditsResource.holdReference().';

const longest = `hold:${'p'.repeat(60)}:${'t'.repeat(120)}`;

const refused = [
  ['another prefix', 'held:woocommerce:cart-9f2'],
  ['a platform that is not a plain name', 'hold:woo.commerce:cart-9f2'],
  ['a platform over 60', `hold:${'p'.repeat(61)}:cart-9f2`],
  ['a token over 120', `hold:woocommerce:${'t'.repeat(121)}`],
] as const;

function over(answer: unknown) {
  const built = transportOver([reply(200, answer)]);
  return { ...built, credits: new CreditsResource(built.transport) };
}

describe('P5 unit: hold references', () => {
  it('sends a reference with both parts at their longest', async () => {
    const holds = over(page([CreditAnswers.hold]));
    const balances = over(CreditAnswers.checkoutBalances);

    await holds.credits.holds({ reference: longest });
    await balances.credits.checkoutBalances(4, undefined, longest);

    expect(queryOf(holds.http.requests[0])).toEqual({ reference: longest });
    expect(queryOf(balances.http.requests[0])).toEqual({ collaboratorId: '4', excludeReference: longest });
  });

  it.each(refused)('holds refuses %s before sending', async (_label, reference) => {
    const { http, credits } = over(page([]));

    const error = await credits.holds({ reference }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(REFERENCE_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });

  it.each(refused)('checkoutBalances refuses %s as excludeReference before sending', async (_label, reference) => {
    const { http, credits } = over(CreditAnswers.checkoutBalances);

    const error = await credits.checkoutBalances(4, undefined, reference).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(EXCLUDE_MESSAGE);
    expect(http.requests).toHaveLength(0);
  });
});
