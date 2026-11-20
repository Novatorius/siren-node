import { SirenError } from '../errors';
import type { AppCurrency, AppSplitPool, AppSplitWeights, ShownAmount } from '../record-types';

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

/**
 * Splits a pool among ids by weight, for a resolver's answer: each id gets
 * `floor(steps * weight / total)` whole steps of the currency, where a step
 * is `10^(scale - decimalPlaces)` stored units (1 for dollars, 100 for yen
 * at scale 2) and `steps` is how many whole steps `pool.value` holds. Every
 * share is rounded down, so the shares never add up to more than the pool,
 * and what rounding leaves stays unpaid, which both resolvers' answers allow
 * (AppDistributionQuestion::unfitness() rule 9, AppRewardQuestion::validate()
 * on Siren's pkt/apps-c16-2 at f97b42820). When every weight is 0, each id
 * gets the same whole number of steps.
 *
 * `weights` is an object of id to weight or a list of `[id, weight]` pairs.
 * Answers an object of the ids, as text, to their shares in stored units.
 *
 * Throws `SirenError` naming `method` and the field for a pool `value` that
 * is not a safe integer of 0 or more, a currency with a `scale` outside 0 to
 * 8 or `decimalPlaces` outside 0 to the scale, weights that are neither an
 * object nor a list of pairs, an id given twice, and a weight that is not a
 * finite number of 0 or more.
 *
 * @internal
 */
export function splitPool(pool: AppSplitPool, weights: AppSplitWeights, method: string): Record<string, number> {
  if (typeof pool !== 'object' || pool === null) {
    throw new SirenError(`Siren: ${method} needs the pool as { value, currency }, as a resolver's question carries it.`);
  }
  const { value, currency } = pool;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SirenError(`Siren: ${method} needs pool.value as the stored whole number of 0 or more Siren sent, and got ${String(value)}.`);
  }
  if (typeof currency !== 'object' || currency === null) {
    throw new SirenError(`Siren: ${method} needs pool.currency, the currency Siren sent beside the pool, as an object.`);
  }
  const { scale, decimalPlaces } = currency;
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new SirenError(`Siren: ${method} needs pool.currency.scale as a whole number from 0 to ${MAX_SCALE}.`);
  }
  if (typeof decimalPlaces !== 'number' || !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > scale) {
    throw new SirenError(`Siren: ${method} needs pool.currency.decimalPlaces as a whole number from 0 to the scale, ${scale}.`);
  }

  const entries = weightEntries(weights, method);
  const shares: Record<string, number> = {};
  if (entries.length === 0) return shares;

  const step = 10 ** (scale - decimalPlaces);
  const steps = Math.floor(value / step);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);

  if (total === 0) {
    const each = Math.floor(steps / entries.length) * step;
    for (const [id] of entries) shares[id] = each;
    return shares;
  }

  const whole = entries.every(([, weight]) => Number.isSafeInteger(weight)) && Number.isSafeInteger(total);
  // Fractional weights are scaled to at most 1 first, so a huge weight cannot overflow the sum.
  const largest = Math.max(...entries.map(([, weight]) => weight));
  const scaledTotal = entries.reduce((sum, [, weight]) => sum + weight / largest, 0);
  let given = 0;
  for (const [id, weight] of entries) {
    // Whole weights split in exact integers. Fractional ones split in floats, checked below.
    const count = whole
      ? Number((BigInt(steps) * BigInt(weight)) / BigInt(total))
      : Math.floor((steps * (weight / largest)) / scaledTotal);
    shares[id] = count * step;
    given += count;
  }
  // A float can round a share up past its exact value. Take back one step at a time, from the largest share, until the sum fits.
  while (given > steps) {
    const [top] = Object.entries(shares).sort((a, b) => b[1] - a[1])[0]!;
    shares[top] = (shares[top] ?? 0) - step;
    given -= 1;
  }
  return shares;
}

/** The weights as `[id, weight]` pairs, refusing anything `splitPool` cannot split. */
function weightEntries(weights: AppSplitWeights, method: string): Array<[string, number]> {
  let given: Array<[unknown, unknown]>;
  if (Array.isArray(weights)) {
    given = weights.map((pair: unknown) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new SirenError(`Siren: ${method} takes weights as an object of id to weight, or a list of [id, weight] pairs.`);
      }
      return [pair[0], pair[1]];
    });
  } else if (typeof weights === 'object' && weights !== null) {
    given = Object.entries(weights);
  } else {
    throw new SirenError(`Siren: ${method} takes weights as an object of id to weight, or a list of [id, weight] pairs.`);
  }

  const seen = new Set<string>();
  return given.map(([id, weight]) => {
    if ((typeof id !== 'string' || id === '') && !(typeof id === 'number' && Number.isSafeInteger(id))) {
      throw new SirenError(`Siren: ${method} takes each id as text or a whole number, such as a metricId or a conversionId.`);
    }
    const key = String(id);
    if (seen.has(key)) throw new SirenError(`Siren: ${method} was given id ${key} twice.`);
    seen.add(key);
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new SirenError(`Siren: ${method} takes each weight as a finite number of 0 or more, and the weight for ${key} is ${String(weight)}.`);
    }
    return [key, weight];
  });
}
