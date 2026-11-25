import { clean } from '../style';
import type { Style } from '../style';

/*
 * How the record commands lay out Siren's answers, through the style module
 * (src/cli/style.ts): an aligned table for a list, labels and values for one
 * record. In a terminal nothing passes 80 columns. Through a pipe a list
 * shows every scalar column and each value whole. Every key and value from
 * Siren is cleaned of escape sequences and control characters first.
 */

/** The widest line the tool prints. */
export const WIDTH = 80;

/** The widest a table column grows before its values are cut. */
const COLUMN = 30;

/** A value as one short, cleaned line: text as it is, null as -, objects as compact JSON. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return clean(value.replace(/\s+/g, ' '));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // JSON escapes the C0 controls but not the C1 ones.
  return clean(JSON.stringify(value));
}

/** Cuts a line to `width` characters, with … at the end when it was longer. */
export function clip(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

/** True for a value a table column can show: text, a number, a boolean or null. */
function scalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * The columns a list shows: `id` first, then the fields every row holds as a
 * scalar, in the first row's order, as many as fit in `width`.
 */
export function columns(rows: readonly Record<string, unknown>[], width: number = WIDTH): string[] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]!).filter((key) => rows.every((row) => scalar(row[key])));
  const ordered = keys.includes('id') ? ['id', ...keys.filter((key) => key !== 'id')] : keys;
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

/** A list as an aligned table, the header dim, indented two spaces. */
export function table(style: Style, rows: readonly Record<string, unknown>[]): string[] {
  const width = style.rich ? WIDTH : Number.POSITIVE_INFINITY;
  const keys = columns(rows, width);
  if (keys.length === 0) return [];
  const lines = style.table(
    keys.map((key) => clean(key)),
    rows.map((row) => keys.map((key) => style.fit(cell(row[key]), COLUMN))),
    width - 2,
  );
  return lines.map((line) => `  ${line}`);
}

/** One record as labels and values for {@link Style.report}, `id` left out, each line inside {@link WIDTH} in a terminal and whole through a pipe. */
export function recordRows(style: Style, record: Record<string, unknown>): Array<readonly [string, string]> {
  const keys = Object.keys(record).filter((key) => key !== 'id');
  if (keys.length === 0) return [];
  const width = Math.min(24, Math.max(...keys.map((key) => key.length)));
  return keys.map((key) => [style.fit(clean(key), width), style.fit(cell(record[key]), WIDTH - width - 5)] as const);
}
