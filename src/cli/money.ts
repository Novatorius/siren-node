import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/*
 * Money as Siren's screens show it. Siren stores an amount as an integer in
 * its currency's scale: 1840 is $18.40 in USD, 120 is 120 points. The rules
 * here are a port of Siren's frontend/src/core/utils/currency.ts, whose
 * backend twin is Siren\Commerce\Services\CurrencyAmountService. Every rule
 * comes from a currency definition, and every definition comes from Siren's
 * registry, GET /registries/currencies. Nothing here knows a currency by
 * name.
 *
 * The one addition: a money amount ends with its code, as `$18.40 USD`,
 * since a terminal has no flag or column header to tell USD from CAD. A
 * ledger unit such as points reads as Siren draws it, `120 pts`.
 */

/** How a currency's amounts are stored and drawn. One registry entry. */
export interface CurrencyDefinition {
  code: string;
  name?: string;
  symbol?: string;
  symbolPosition?: 'before' | 'after';
  /** Digits of a stored amount that sit after the decimal point. */
  scale: number;
  /** Digits shown. Never more than the scale. */
  decimalPlaces: number;
  /** `monetary` is money. `internal` is a ledger unit such as points. */
  type?: 'monetary' | 'internal';
  /** True on the org's default currency, which amounts with no code are read in. */
  isDefault?: boolean;
}

export type CurrencyDefinitions = ReadonlyArray<CurrencyDefinition> | null | undefined;

const LOCALE = 'en-US';

/** Codes that mean "the default currency". `currency` is what older transactions recorded. */
const UNSET_MARKERS = new Set(['', 'CURRENCY']);

export function normalizeCurrencyCode(code: string | null | undefined): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

export function isUnsetCurrencyCode(code: string | null | undefined): boolean {
  return UNSET_MARKERS.has(normalizeCurrencyCode(code));
}

export function findCurrencyDefinition(code: string | null | undefined, definitions: CurrencyDefinitions): CurrencyDefinition | undefined {
  const upper = normalizeCurrencyCode(code);
  if (upper === '') return undefined;
  return (definitions ?? []).find((definition) => definition?.code?.toUpperCase() === upper);
}

/** A code nobody registered: the code after the number, read in hundredths, as Siren reads it. */
export function unregisteredCurrency(code: string): CurrencyDefinition {
  return { code, name: code, symbol: code, symbolPosition: 'after', scale: 2, decimalPlaces: 2 };
}

/** The definition for a code: registered, the default for a missing code, or the unregistered fallback. Undefined with no registry. */
export function resolveCurrencyDefinition(code: string | null | undefined, definitions: CurrencyDefinitions): CurrencyDefinition | undefined {
  const list = definitions ?? [];
  if (list.length === 0) return undefined;
  if (isUnsetCurrencyCode(code)) return list.find((definition) => definition.isDefault) ?? list[0];
  return findCurrencyDefinition(code, list) ?? unregisteredCurrency(normalizeCurrencyCode(code));
}

function digits(value: unknown, otherwise: number): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 8) return otherwise;
  return count;
}

export function currencyScale(definition: CurrencyDefinition | undefined): number {
  return digits(definition?.scale, 2);
}

export function currencyDecimalPlaces(definition: CurrencyDefinition | undefined): number {
  const scale = currencyScale(definition);
  return Math.min(scale, digits(definition?.decimalPlaces, scale));
}

/** A stored amount (1050) as the number a person reads (10.5 for USD), shifted on decimal text so 1999 is 19.99. */
export function toShownAmount(stored: number | string, definition: CurrencyDefinition | undefined): number {
  const value = Number(stored);
  if (!Number.isFinite(value)) return 0;
  const shifted = Number(`${value}e-${currencyScale(definition)}`);
  return Number.isFinite(shifted) ? shifted : value / 10 ** currencyScale(definition);
}

function formatNumber(value: number, places: number): string {
  try {
    return value.toLocaleString(LOCALE, { minimumFractionDigits: places, maximumFractionDigits: places });
  } catch {
    return value.toFixed(places);
  }
}

/** A stored amount drawn with a definition: "$5.00", "¥5" or "500 FZ". */
export function formatWithDefinition(stored: number, definition: CurrencyDefinition): string {
  const text = formatNumber(Math.abs(toShownAmount(stored, definition)), currencyDecimalPlaces(definition));
  const sign = stored < 0 ? '-' : '';
  const symbol = definition.symbol?.trim() ?? '';
  if (symbol !== '' && definition.symbolPosition !== 'after') return `${sign}${symbol}${text}`;
  return `${sign}${text} ${symbol !== '' ? symbol : definition.code}`;
}

/** A stored amount as Siren's screens draw it, or the fallback when it can't be read. Never throws. */
export function formatMoney(amount: number | string | null | undefined, code?: string | null, options: { definitions?: CurrencyDefinitions; fallback?: string } = {}): string {
  const fallback = options.fallback ?? '—';
  try {
    if (amount === null || amount === undefined || amount === '') return fallback;
    const value = Number(amount);
    if (!Number.isFinite(value)) return fallback;
    const definition = resolveCurrencyDefinition(code, options.definitions);
    if (!definition) return fallback;
    return formatWithDefinition(value, definition);
  } catch {
    return fallback;
  }
}

/** A stored amount as the tool prints it: Siren's drawing, with a money currency's code after, as `$18.40 USD`. Undefined when it can't be read. */
export function moneyText(amount: unknown, code: string | null | undefined, definitions: CurrencyDefinitions): string | undefined {
  if (typeof amount !== 'number' && typeof amount !== 'string') return undefined;
  const definition = resolveCurrencyDefinition(code, definitions);
  if (definition === undefined || amount === '' || !Number.isFinite(Number(amount))) return undefined;
  const text = formatWithDefinition(Number(amount), definition);
  return definition.type === 'internal' || text.includes(definition.code) ? text : `${text} ${definition.code}`;
}

/** The fields Siren's screens draw as money, each with the field beside it that names its currency. */
const MONEY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  orderTotal: ['orderCurrency'],
};
const AMOUNT_KEYS = new Set(['amount', 'value', 'total', 'subtotal', 'commission', 'balance', 'onHold', 'share']);
const CURRENCY_KEYS = ['currency', 'units', 'awardType', 'obligationAwardType'];

/** The fields that name a currency, which a table can leave out once the amount carries its code. */
export function isCurrencyKey(key: string): boolean {
  return CURRENCY_KEYS.includes(key) || key === 'orderCurrency';
}

/** The record's money fields, each with the key of its currency field. */
export function moneyFields(record: Readonly<Record<string, unknown>>): Array<{ key: string; currencyKey: string }> {
  const found: Array<{ key: string; currencyKey: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number') continue;
    const candidates = MONEY_FIELDS[key] ?? (AMOUNT_KEYS.has(key) ? CURRENCY_KEYS : []);
    const currencyKey = candidates.find((candidate) => candidate in record && (typeof record[candidate] === 'string' || record[candidate] === null));
    if (currencyKey !== undefined) found.push({ key, currencyKey });
  }
  return found;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the answer holds an amount beside its currency, at any depth. */
export function holdsMoney(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsMoney);
  if (!isObject(value)) return false;
  return moneyFields(value).length > 0 || Object.values(value).some(holdsMoney);
}

/** The answer with each amount beside a currency drawn as money, at any depth. Amounts it can't read stay as they are. */
export function withMoney<T>(value: T, definitions: CurrencyDefinitions): T {
  if (definitions === undefined || definitions === null || definitions.length === 0) return value;
  if (Array.isArray(value)) return value.map((member) => withMoney(member, definitions)) as T;
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) out[key] = withMoney(member, definitions);
  for (const { key, currencyKey } of moneyFields(value)) {
    const text = moneyText(value[key], value[currencyKey] as string | null, definitions);
    if (text !== undefined) out[key] = text;
  }
  return out as T;
}

/** How long the tool keeps an organization's currencies before reading them again. */
const CURRENCIES_KEPT_MS = 60 * 60 * 1000;

interface CurrencyCache {
  version: 1;
  orgs: Record<string, { readAt: number; items: CurrencyDefinition[] }>;
}

function isDefinition(value: unknown): value is CurrencyDefinition {
  return isObject(value) && typeof value.code === 'string' && value.code !== '';
}

/**
 * The organization's currencies: the ones kept in currencies.json in the
 * config folder when they are under an hour old, or Siren's registry, read
 * with `read` and kept. Undefined when Siren answers none, so amounts print
 * as stored. A cache that can't be read or written is let go.
 */
export async function currenciesFor(configDir: string, org: string, now: number, read: () => Promise<unknown>): Promise<CurrencyDefinition[] | undefined> {
  const path = join(configDir, 'currencies.json');
  let cache: CurrencyCache = { version: 1, orgs: {} };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CurrencyCache;
    if (parsed?.version === 1 && isObject(parsed.orgs)) cache = parsed;
  } catch {
    // No cache yet, or one that can't be read: read the registry.
  }
  const kept = cache.orgs[org];
  if (kept !== undefined && now - kept.readAt >= 0 && now - kept.readAt < CURRENCIES_KEPT_MS && Array.isArray(kept.items) && kept.items.length > 0) return kept.items;
  let items: CurrencyDefinition[];
  try {
    const body = await read();
    const list = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.items) ? body.items : [];
    items = list.filter(isDefinition);
  } catch {
    return undefined;
  }
  if (items.length === 0) return undefined;
  cache.orgs[org] = { readAt: now, items };
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const temporary = join(configDir, `.currencies.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // Keeping them saves a request next time. Failing to keep them must not fail the command.
  }
  return items;
}
