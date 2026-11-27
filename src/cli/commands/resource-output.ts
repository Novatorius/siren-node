import { isSirenDate, stamp } from '../record-view';
import { clean } from '../style';
import type { Style } from '../style';

/*
 * How the record commands lay out Siren's answers, through the style module
 * (src/cli/style.ts): an aligned table for a list, labels and values for one
 * record. In a terminal nothing passes 80 columns. Through a pipe a list
 * shows every scalar column and each value whole. Every key and value from
 * Siren is cleaned of escape sequences and control characters first.
 */

/** The width the default columns are chosen for when no terminal is measured. */
export const WIDTH = 80;

/** The width a long column counts as when the default columns are chosen. Its values are never cut: the table wraps them. */
const COLUMN = 30;

/** A value as one short, cleaned line: text as it is, null as -, objects as compact JSON. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return clean(value.replace(/\s+/g, ' '));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // JSON escapes the C0 controls but not the C1 ones.
  return clean(JSON.stringify(value));
}

/** True for a value a table column can show: text, a number, a boolean or null. */
function scalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

const NAME_KEYS = ['name', 'fullName', 'title', 'label', 'email'];
const MONEY_KEYS = ['amount', 'value', 'total', 'subtotal', 'commission', 'balance', 'onHold', 'share', 'orderTotal'];
/** The fields that name an amount's currency, in the order Siren pairs them. */
const CURRENCY_KEYS = ['currency', 'units', 'awardType', 'obligationAwardType'];
const DATE_KEYS = ['dateCreated', 'createdDate', 'createdAt', 'happenedAt', 'date'];

/**
 * The columns a list shows by default (lean output, section 5): the id, the
 * name or else the email, the status, the money, the related record by
 * name, and the date. Relation ids such as `engagementId` are left out. A
 * record with none of these keeps every scalar field, `id` first.
 */
export function defaultColumns(keys: readonly string[]): string[] {
  const first = (candidates: readonly string[]) => candidates.find((key) => keys.includes(key));
  const id = first(['id', 'key']);
  const named = first(NAME_KEYS);
  const related = keys.find((key) => /[a-z]Name$/.test(key) && key !== named);
  const chosen = [id, named, keys.includes('status') ? 'status' : undefined, ...MONEY_KEYS.filter((key) => keys.includes(key)), related, first(DATE_KEYS)].filter((key): key is string => key !== undefined);
  if (chosen.length - (id === undefined ? 0 : 1) < 1) return keys.includes('id') ? ['id', ...keys.filter((key) => key !== 'id')] : [...keys];
  return chosen;
}

/**
 * The columns a list shows: {@link defaultColumns} of the fields every row
 * holds as a scalar, dropped from the right until they fit in `width`.
 */
export function columns(rows: readonly Record<string, unknown>[], width: number = WIDTH): string[] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]!).filter((key) => rows.every((row) => scalar(row[key])));
  // An amount left as Siren stores it, with no registry to draw it, keeps its currency beside it, so 1840 never shows without a unit.
  const ordered = defaultColumns(keys).flatMap((key) => {
    const unit = MONEY_KEYS.includes(key) && rows.some((row) => typeof row[key] === 'number') ? (key === 'orderTotal' ? ['orderCurrency'] : CURRENCY_KEYS).find((candidate) => keys.includes(candidate)) : undefined;
    return unit === undefined ? [key] : [key, unit];
  });
  const chosen: string[] = [];
  let used = 2;
  for (const key of ordered) {
    const wide = Math.min(COLUMN, Math.max(key.length, ...rows.map((row) => cell(row[key]).length)));
    if (chosen.length > 0 && used + wide > width) break;
    chosen.push(key);
    used += wide + 2;
  }
  return chosen;
}

/** How a table prints: the columns to show, and the zone and time a date is read against. */
export interface TableOptions {
  /** The columns, in order, in place of the ones that fit. */
  keys?: readonly string[];
  zone?: string;
  now?: number;
  /** Two spaces before each line, as a report has. Through a pipe the table starts at the margin. */
  indent?: boolean;
}

/** A cell, with a Siren date read as `Today 13:58`, `Nov 24 19:58` or `Mar 2, 2025` when the clock is given. */
function tableCell(value: unknown, options: TableOptions): string {
  return options.now !== undefined && isSirenDate(value) ? stamp(value, options.zone, options.now) : cell(value);
}

/** A list as an aligned table, the header dim, indented two spaces unless told otherwise. */
export function table(style: Style, rows: readonly Record<string, unknown>[], options: TableOptions = {}): string[] {
  const width = style.rich ? style.width : Number.POSITIVE_INFINITY;
  const keys = options.keys ?? columns(rows, width);
  if (keys.length === 0) return [];
  const indent = options.indent ?? true;
  const lines = style.table(
    keys.map((key) => clean(key)),
    rows.map((row) => keys.map((key) => tableCell(row[key], options))),
    width - (indent ? 2 : 0),
  );
  return indent ? lines.map((line) => `  ${line}`) : lines;
}

/** One record as labels and values for {@link Style.report}, `id` left out. The report wraps each value under itself, and no key or value is cut. */
export function recordRows(_style: Style, record: Record<string, unknown>): Array<readonly [string, string]> {
  const keys = Object.keys(record).filter((key) => key !== 'id');
  return keys.map((key) => [clean(key), cell(record[key])] as const);
}
