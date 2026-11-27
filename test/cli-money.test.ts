import { describe, expect, it } from 'vitest';
import { formatMoney, moneyText, toShownAmount, type CurrencyDefinition } from '../src/cli/money';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * Money as Siren's screens show it. Siren stores an amount as an integer in
 * its currency's scale, so 1840 is $18.40 in USD and 120 is 120 points. The
 * rules are a port of Siren's frontend/src/core/utils/currency.ts, and the
 * definitions come from GET /registries/currencies, as recorded on the PR
 * 1250 preview.
 */
const USD: CurrencyDefinition = { code: 'USD', name: 'US Dollar', symbol: '$', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: true };
const EUR: CurrencyDefinition = { code: 'EUR', name: 'Euro', symbol: '€', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: false };
const JPY: CurrencyDefinition = { code: 'JPY', name: 'Japanese Yen', symbol: '¥', symbolPosition: 'before', scale: 2, decimalPlaces: 0, type: 'monetary', isDefault: false };
const PTS: CurrencyDefinition = { code: 'PTS', name: 'Points', symbol: 'pts', symbolPosition: 'after', scale: 0, decimalPlaces: 0, type: 'internal', isDefault: false };
const KWD: CurrencyDefinition = { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'KD', symbolPosition: 'before', scale: 3, decimalPlaces: 3, type: 'monetary', isDefault: false };
const REGISTRY = [USD, EUR, JPY, PTS, KWD];

describe('money, as Siren draws it', () => {
  it('reads USD in hundredths, with the code after so $ is never ambiguous', () => {
    expect(moneyText(1840, 'USD', REGISTRY)).toBe('$18.40 USD');
    expect(moneyText(-1840, 'usd', REGISTRY)).toBe('-$18.40 USD');
    expect(moneyText(123456789, 'USD', REGISTRY)).toBe('$1,234,567.89 USD');
  });

  it('reads a scale-0 currency whole, as points', () => {
    expect(moneyText(120, 'PTS', REGISTRY)).toBe('120 pts');
    expect(formatMoney(120, 'PTS', { definitions: REGISTRY })).toBe('120 pts');
  });

  it('reads a 3-digit currency in thousandths', () => {
    expect(moneyText(12345, 'KWD', REGISTRY)).toBe('KD12.345 KWD');
    expect(toShownAmount(12345, KWD)).toBe(12.345);
  });

  it('shows no more digits than the currency shows, and shifts on decimal text', () => {
    expect(moneyText(500, 'JPY', REGISTRY)).toBe('¥5 JPY');
    expect(toShownAmount(1999, USD)).toBe(19.99);
    expect(toShownAmount(1, USD)).toBe(0.01);
  });

  it('reads a missing code in the default currency, and an unregistered one in hundredths after the number', () => {
    expect(moneyText(500, null, REGISTRY)).toBe('$5.00 USD');
    expect(moneyText(500, 'currency', REGISTRY)).toBe('$5.00 USD');
    expect(moneyText(500, 'FZ', REGISTRY)).toBe('5.00 FZ');
    expect(formatMoney(500, 'USD', { definitions: [] })).toBe('—');
    expect(formatMoney('x', 'USD', { definitions: REGISTRY })).toBe('—');
  });
});

const payouts = [
  { id: 623, status: 'unpaid', value: 12431, currency: 'EUR', collaboratorId: 19, dateCreated: '2026-11-01T13:00:00+00:00' },
  { id: 622, status: 'paid', value: 120, currency: 'PTS', collaboratorId: 18, dateCreated: '2026-11-01T12:00:00+00:00' },
];
const envelope = (items: unknown[]) => ({ items, total: items.length, page: 1, perPage: 10, totalPages: 1 });
const signedIn = (replies: Parameters<typeof harness>[0]) => {
  const h = harness(replies, { env: { TZ: 'UTC' } });
  h.signedIn();
  return h;
};
const paths = (h: ReturnType<typeof harness>) => h.http.requests.map((request) => `${request.method} ${new URL(request.url).pathname.replace(/^.*\/siren\/v1/, '')}`);

describe('money in record commands', () => {
  it('prints amounts in a list as currency, reading the registry once an organization', async () => {
    const h = signedIn([reply(200, envelope(payouts)), reply(200, REGISTRY), reply(200, envelope(payouts))]);
    expect(await h.run(['payouts', 'list']), h.err()).toBe(0);
    expect(h.out()).toContain('€124.31 EUR');
    expect(h.out()).toContain('120 pts');
    expect(h.out()).not.toContain('12431');
    expect(await h.run(['payouts', 'list'])).toBe(0);
    // The second run reads the currencies it kept for this organization.
    expect(paths(h)).toEqual(['GET /payouts', 'GET /registries/currencies', 'GET /payouts']);
  });

  it('keeps the stored integer in --json and reads no registry', async () => {
    const h = signedIn([reply(200, envelope(payouts))]);
    expect(await h.run(['payouts', 'list', '--json'])).toBe(0);
    expect(JSON.parse(h.out()).items[0].value).toBe(12431);
    expect(paths(h)).toEqual(['GET /payouts']);
  });

  it('prints a record view amount as currency', async () => {
    const h = signedIn([reply(200, payouts[0]), reply(200, REGISTRY)]);
    expect(await h.run(['payouts', 'get', '623']), h.err()).toBe(0);
    expect(h.out()).toMatch(/value\s+€124\.31 EUR/);
  });

  it('prints an ISO currency as money even when Siren answers no registry (review round 1, C4)', async () => {
    const h = signedIn([reply(200, envelope(payouts)), reply(404, { message: 'Not found.' })]);
    expect(await h.run(['payouts', 'list']), h.err()).toBe(0);
    expect(h.out()).toContain('€124.31 EUR');
    expect(h.out()).not.toMatch(/\b12431\b/);
  });
});
