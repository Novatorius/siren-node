import { SirenError } from '../errors';
import type { AppCurrency, ShownAmount } from '../record-types';

/*
 * Reading a stored amount the way Siren does. Siren stores an amount as an
 * integer, the shown amount times 10^scale, and its CurrencyAmountService
 * (lib/Commerce/Services/CurrencyAmountService.php on int/preview-apps at
 * a22547327, last changed in 2d104f289) is the one place that turns it
 * back: toFloat(), toDecimalString() and format(). This copies those three,
 * integer arithmetic throughout, so an app reads the same text the
 * dashboard shows.
 *
 * Siren's two text forms disagree on one edge: a negative amount that
 * rounds to zero. format() (lines 88 to 99) takes its sign from the stored
 * value, so -49 in a currency of scale 4 and 2 places prints "-$0.00".
 * toDecimalString() goes through toText() (lines 116 to 134), which drops
 * the sign when the shown value is 0, and prints "0.00". `decimal` and
 * `text` here both follow format(), so the two fields always agree on the
 * sign: "-0.00" and "-$0.00".
 */

/** The largest scale a currency may declare (`Currency::MAX_SCALE`). */
const MAX_SCALE = 8;

/**
 * The amount a person reads from a stored `value` in `currency`.
 *
 * - `amount` is `value / 10^scale` (`toFloat()`).
 * - `decimal` rounds to `decimalPlaces`, halves up, with no symbol and no
 *   grouping (`toDecimalString()`), and the sign `format()` gives, which
 *   keeps the sign of a negative that rounds to zero.
 * - `text` adds the symbol touching the number when it sits before, after a
 *   space when it sits after, or the currency's `id` after a space when it
 *   has none, and groups thousands with commas (`format()`).
 *
 * Throws `SirenError` naming `method` and the field for a `value` that is
 * not a safe integer, a currency that is not an object, a `scale` that is
 * not a whole number from 0 to 8, and `decimalPlaces` that is not a whole
 * number from 0 to `scale`.
 *
 * @internal
 */
export function shownAmount(value: number, currency: AppCurrency, method: string): ShownAmount {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SirenError(`Siren: ${method} needs value as the stored integer Siren sent, and got ${String(value)}.`);
  }
  if (typeof currency !== 'object' || currency === null) {
    throw new SirenError(`Siren: ${method} needs the currency Siren sent beside the value, as an object.`);
  }
  const { scale, decimalPlaces } = currency;
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new SirenError(`Siren: ${method} needs currency.scale as a whole number from 0 to ${MAX_SCALE}.`);
  }
  if (typeof decimalPlaces !== 'number' || !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > scale) {
    throw new SirenError(`Siren: ${method} needs currency.decimalPlaces as a whole number from 0 to the scale, ${scale}.`);
  }

  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  // Drop the digits the currency stores and does not show, rounding halves up.
  const dropped = 10 ** (scale - decimalPlaces);
  const shown = Math.floor(magnitude / dropped) + ((magnitude % dropped) * 2 >= dropped ? 1 : 0);
  const unit = 10 ** decimalPlaces;
  const whole = String(Math.floor(shown / unit));
  const fraction = decimalPlaces > 0 ? `.${String(shown % unit).padStart(decimalPlaces, '0')}` : '';
  // The sign comes from the stored value, as format() takes it, for both fields.
  const decimal = `${sign}${whole}${fraction}`;
  const grouped = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
  const symbol = typeof currency.symbol === 'string' ? currency.symbol.trim() : '';
  const text =
    symbol !== '' && currency.position === 'before'
      ? `${sign}${symbol}${grouped}`
      : `${sign}${grouped} ${symbol !== '' ? symbol : String(currency.id)}`;

  return { amount: value / 10 ** scale, decimal, text };
}
