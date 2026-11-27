import { describe, expect, it } from 'vitest';
import { Siren, SirenError } from '../src/index';
import type { PostAllocationActionTell, PostConversionActionTell, AppCurrency } from '../src/index';
import { FakeHttpClient } from './http-fakes';
import { TEST_API_KEY } from './helpers';
import { AppCurrencies, AppTells } from './apps-siren-answers';

/*
 * The amount in a tell. Siren sends `value` as the stored integer and the
 * reward's currency beside it, and the shown amount is
 * `value / 10^currency.scale` (AppActionSubjects.php lines 34 to 41 on
 * Siren's feat/apps at 27169452a). `apps.shownAmount()` reads it the way
 * Siren's own CurrencyAmountService does (lib/Commerce/Services/CurrencyAmountService.php:
 * toFloat(), toDecimalString() and format()), so no app works out the scale.
 */

const siren = new Siren({ apiKey: TEST_API_KEY, httpClient: new FakeHttpClient([]) });

describe('apps-sdk-followups-1: the amount a person reads from a tell', () => {
  it('reads dollars, yen and points by their scale and decimal places', () => {
    expect(siren.apps.shownAmount(1500, AppCurrencies.usd())).toEqual({ amount: 15, decimal: '15.00', text: '$15.00' });
    expect(siren.apps.shownAmount(10000, AppCurrencies.jpy())).toEqual({ amount: 100, decimal: '100', text: '¥100' });
    expect(siren.apps.shownAmount(10000, AppCurrencies.points())).toEqual({ amount: 10000, decimal: '10000', text: '10,000 pts' });
  });

  // Slice C6 item 8. Siren's CurrencyAmountService::format() (lines 88 to 99 on int/preview-apps at
  // a22547327) takes its sign from the stored value, so a negative that rounds to zero prints
  // "-$0.00". Its toDecimalString() drops that sign. decimal and text both follow format().
  it('gives decimal the sign text has, as format() prints a negative that rounds to zero', () => {
    const fine = { ...AppCurrencies.usd(), scale: 4, decimalPlaces: 2 };
    expect(siren.apps.shownAmount(-49, fine)).toEqual({ amount: -0.0049, decimal: '-0.00', text: '-$0.00' });
    expect(siren.apps.shownAmount(-50, fine)).toEqual({ amount: -0.005, decimal: '-0.01', text: '-$0.01' });
    expect(siren.apps.shownAmount(-49, AppCurrencies.jpy())).toEqual({ amount: -0.49, decimal: '-0', text: '-¥0' });
    expect(siren.apps.shownAmount(-4, { ...AppCurrencies.points(), scale: 1 })).toEqual({ amount: -0.4, decimal: '-0', text: '-0 pts' });
    expect(siren.apps.shownAmount(0, fine)).toEqual({ amount: 0, decimal: '0.00', text: '$0.00' });
  });

  it('rounds to the decimal places shown, halves up, and groups thousands, as Siren formats an amount', () => {
    expect(siren.apps.shownAmount(10050, AppCurrencies.jpy())).toEqual({ amount: 100.5, decimal: '101', text: '¥101' });
    expect(siren.apps.shownAmount(10049, AppCurrencies.jpy()).text).toBe('¥100');
    expect(siren.apps.shownAmount(123456789, AppCurrencies.usd())).toEqual({ amount: 1234567.89, decimal: '1234567.89', text: '$1,234,567.89' });
    expect(siren.apps.shownAmount(5, AppCurrencies.usd())).toEqual({ amount: 0.05, decimal: '0.05', text: '$0.05' });
    expect(siren.apps.shownAmount(-1505, AppCurrencies.usd())).toEqual({ amount: -15.05, decimal: '-15.05', text: '-$15.05' });
    expect(siren.apps.shownAmount(0, AppCurrencies.usd()).text).toBe('$0.00');
  });

  it('puts a symbol written after the number behind a space, and the code when there is no symbol', () => {
    expect(siren.apps.shownAmount(1999, { ...AppCurrencies.usd(), symbol: '', id: 'FZ' }).text).toBe('19.99 FZ');
    expect(siren.apps.shownAmount(1999, { ...AppCurrencies.usd(), symbol: 'kr', position: 'after' }).text).toBe('19.99 kr');
  });

  it('reads the amount of both tells as Siren builds them', () => {
    const approved: PostConversionActionTell = AppTells.conversionApproved(10000, AppCurrencies.jpy());
    const completed: PostAllocationActionTell = AppTells.allocationCompleted(2500);
    expect(approved.reward).not.toBeNull();
    expect(siren.apps.shownAmount(approved.reward!.value, approved.reward!.currency).text).toBe('¥100');
    expect(siren.apps.shownAmount(completed.allocation.value, completed.allocation.currency).text).toBe('$25.00');
    const none: PostConversionActionTell = AppTells.conversionWithoutReward();
    expect(none.reward).toBeNull();
  });

  it('refuses a value that is not a stored integer, and a currency it cannot read, naming the field', () => {
    const usd: AppCurrency = AppCurrencies.usd();
    const cases: Array<[unknown, unknown, string]> = [
      [15.5, usd, 'value'],
      ['1500', usd, 'value'],
      [Number.MAX_SAFE_INTEGER + 1, usd, 'value'],
      [1500, null, 'currency'],
      [1500, { ...usd, scale: undefined }, 'currency.scale'],
      [1500, { ...usd, scale: -1 }, 'currency.scale'],
      [1500, { ...usd, scale: 9 }, 'currency.scale'],
      [1500, { ...usd, scale: 1.5 }, 'currency.scale'],
      [1500, { ...usd, decimalPlaces: 3 }, 'currency.decimalPlaces'],
      [1500, { ...usd, decimalPlaces: -1 }, 'currency.decimalPlaces'],
    ];
    for (const [value, currency, field] of cases) {
      let error: unknown;
      try {
        siren.apps.shownAmount(value as number, currency as AppCurrency);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${JSON.stringify(value)} ${JSON.stringify(currency)}`).toBeInstanceOf(SirenError);
      expect((error as Error).message).toContain('apps.shownAmount()');
      expect((error as Error).message).toContain(field);
    }
  });
});
