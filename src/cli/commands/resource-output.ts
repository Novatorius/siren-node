/*
 * How the record commands print: an aligned table for a list, a block of
 * labels and values for one record, and the three-part error. It follows
 * the shape Alex set (M114): a ✓ headline, a short aligned block, a numbered
 * Next and › tips, nothing past 80 columns. The style module on
 * pkt/apps-cli-dx replaces the marks and colours here once it lands.
 */

/** The widest line the tool prints. */
export const WIDTH = 80;

/** A value as one short line: text as it is, null as -, objects as compact JSON. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Cuts a line to `width` characters, with … at the end when it was longer. */
export function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
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
    const width = Math.min(30, Math.max(key.length, ...rows.map((row) => cell(row[key]).length)));
    if (chosen.length > 0 && used + width > WIDTH) break;
    chosen.push(key);
    used += width + 2;
  }
  return chosen;
}

/** A list as an aligned table under upper-case headings, each line inside {@link WIDTH}. */
export function table(rows: readonly Record<string, unknown>[]): string[] {
  const keys = columns(rows);
  if (keys.length === 0) return [];
  const widths = keys.map((key) => Math.min(30, Math.max(key.length, ...rows.map((row) => cell(row[key]).length))));
  const line = (values: string[]) => clip(`  ${values.map((value, index) => clip(value, widths[index]!).padEnd(widths[index]!)).join('  ')}`.trimEnd(), WIDTH);
  return [line(keys.map((key) => key.toUpperCase())), ...rows.map((row) => line(keys.map((key) => cell(row[key]))))];
}

/** One record as labels and values, the labels aligned, each line inside {@link WIDTH}. */
export function block(record: Record<string, unknown>): string[] {
  const keys = Object.keys(record).filter((key) => key !== 'id');
  if (keys.length === 0) return [];
  const width = Math.min(24, Math.max(...keys.map((key) => key.length)));
  return keys.map((key) => clip(`  ${clip(key, width).padEnd(width)}  ${cell(record[key])}`, WIDTH));
}

/** The three parts of an error: what went wrong, why, and the command that fixes it. */
export interface ErrorParts {
  what: string;
  why: string;
  fix: string;
}

/** An error as the tool prints it on standard error. */
export function errorLines(parts: ErrorParts): string {
  return `✗ ${parts.what}\n  ${parts.why}\n  ${parts.fix}\n`;
}
