import { clean } from '../style';
import type { Style } from '../style';

/*
 * How the record commands lay out Siren's answers, through the style module
 * (src/cli/style.ts): an aligned table for a list, labels and values for one
 * record. Nothing passes 80 columns, and every key and value from Siren is
 * cleaned of escape sequences and control characters first.
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
 * scalar, in the first row's order, as many as fit in {@link WIDTH}.
 */
export function columns(rows: readonly Record<string, unknown>[]): string[] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]!).filter((key) => rows.every((row) => scalar(row[key])));
  const ordered = keys.includes('id') ? ['id', ...keys.filter((key) => key !== 'id')] : keys;
  const chosen: string[] = [];
  let used = 2;
  for (const key of ordered) {
    const width = Math.min(COLUMN, Math.max(key.length, ...rows.map((row) => cell(row[key]).length)));
    if (chosen.length > 0 && used + width > WIDTH) break;
    chosen.push(key);
    used += width + 2;
  }
  return chosen;
}

/** A list as an aligned table, the header dim, indented two spaces. */
export function table(style: Style, rows: readonly Record<string, unknown>[]): string[] {
  const keys = columns(rows);
  if (keys.length === 0) return [];
  const lines = style.table(
    keys.map((key) => clean(key)),
    rows.map((row) => keys.map((key) => clip(cell(row[key]), COLUMN))),
    WIDTH - 2,
  );
  return lines.map((line) => `  ${line}`);
}

/** One record as labels and values for {@link Style.report}, `id` left out, each line inside {@link WIDTH}. */
export function recordRows(record: Record<string, unknown>): Array<readonly [string, string]> {
  const keys = Object.keys(record).filter((key) => key !== 'id');
  if (keys.length === 0) return [];
  const width = Math.min(24, Math.max(...keys.map((key) => key.length)));
  return keys.map((key) => [clip(clean(key), width), clip(cell(record[key]), WIDTH - width - 5)] as const);
}
