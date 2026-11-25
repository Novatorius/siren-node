import { clean } from './style';
import type { Style } from './style';

/*
 * One record as a person reads it (review/cli-dx/lean-output.md in the run
 * folder, section 1). The headline names the record. Scalars are aligned
 * `key  value` rows. A nested object is dotted rows, such as
 * `fields.tier  gold`. A list of objects is its own section, one line an
 * item. Nothing is cut mid-value: a terminal line is fitted to 80 columns,
 * and through a pipe every value is whole.
 */

/** The widest line in a terminal. */
const WIDTH = 80;

/** The most items a section shows before "and N more". */
const SECTION_ITEMS = 10;

/** The widest a label grows in a terminal before it is cut. */
const LABEL = 28;

/** The keys that name a record, first found wins. The headline shows it, so its row is left out. */
const NAME_KEYS = ['fullName', 'name', 'title', 'label'] as const;

/** The keys that name an item in a section, first found wins. */
const ITEM_NAME_KEYS = ['name', 'fullName', 'title', 'label', 'key', 'email'] as const;

/** The scalars a record view shows first, in this order. */
const IDENTITY = ['status', 'email'] as const;

/** Siren's date keys, with the word a view prints. */
const DATE_LABELS: Readonly<Record<string, string>> = { createdDate: 'created', dateCreated: 'created', modifiedDate: 'modified', dateModified: 'modified' };

/** What to call the record and how to name the commands it points to. */
export interface RecordViewOptions {
  /** The record's kind in words, such as `collaborator`. */
  what: string;
  /** The command words of its resource, such as `collaborators`. */
  words: string;
  /** The time zone dates print in, `TZ` from the environment, or the machine's own when unset. */
  zone?: string;
  /** The resource names that have a `get`, so a section such as `programs` points to `siren programs get <id>`. */
  resources?: readonly string[];
}

/** A view's lines, without the trailing line break, and the Next commands, without `siren`. */
export interface RecordView {
  lines: string[];
  next: string[];
}

/** One more section a caller adds, such as the latest notes. */
export interface ViewSection {
  title: string;
  lines: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** An ISO date and time, as Siren writes `createdDate`. */
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * A Siren date as a Date. Siren writes some with a zone, such as
 * `2026-11-25T18:57:27+00:00`, and some without, such as
 * `2026-11-24 15:51:48`. It stores every one in UTC, so a date without a
 * zone is read as UTC, never as the machine's own time.
 */
export function sirenDate(iso: string): Date {
  const text = iso.trim().replace(' ', 'T');
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || !/T\d/.test(text) ? text : `${text}Z`);
}

/** `2026-11-25T18:57:27+00:00` as `Nov 25, 2026` in `zone`. */
export function day(iso: string, zone: string | undefined): string {
  const date = sirenDate(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone || undefined }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
}

/** `2026-11-25T19:29:37+00:00` as `Nov 25 19:29` in `zone`, as `apps requests` prints a time. */
export function minute(iso: string, zone: string | undefined): string {
  const date = sirenDate(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone || undefined });
  } catch {
    format = new Intl.DateTimeFormat('en-US', options);
  }
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
}

/** A scalar as words: text whole, null as -, a date as its day. */
function scalarText(value: string | number | boolean | null, zone: string | undefined): string {
  if (value === null) return '-';
  if (typeof value === 'string') return ISO.test(value) ? day(value, zone) : clean(value.replace(/\s+/g, ' '));
  return String(value);
}

/** An object that only names another record, such as `{id: 'sale', name: 'Sale'}`, as `Sale (sale)`. */
function reference(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('name')) return undefined;
  if (!isScalar(value.id) || typeof value.name !== 'string') return undefined;
  return `${clean(value.name)} (${clean(String(value.id))})`;
}

/** Each scalar in a nested object as dotted rows, deeper objects folded into the key. */
function dotted(prefix: string, value: Record<string, unknown>, zone: string | undefined): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, inner] of Object.entries(value)) {
    const label = `${prefix}.${clean(key)}`;
    if (isScalar(inner)) rows.push([label, scalarText(inner, zone)]);
    else if (isObject(inner)) {
      const named = reference(inner);
      if (named !== undefined) rows.push([label, named]);
      else if (Object.keys(inner).length === 0) rows.push([label, 'none']);
      else rows.push(...dotted(label, inner, zone));
    } else if (Array.isArray(inner)) rows.push([label, inner.length === 0 ? 'none' : inner.every(isScalar) ? inner.map((item) => scalarText(item, zone)).join(', ') : `${inner.length} items`]);
  }
  return rows;
}

/** The words an item of a section shows: its id, its name, then up to two short scalars. */
function itemCells(item: Record<string, unknown>, zone: string | undefined): string[] {
  const nameKey = ITEM_NAME_KEYS.find((key) => typeof item[key] === 'string' && item[key] !== '');
  const cells = [nameKey === undefined ? '' : clean(String(item[nameKey]))];
  for (const [key, value] of Object.entries(item)) {
    if (cells.length >= 3) break;
    if (key === 'id' || key === nameKey || !isScalar(value) || value === null) continue;
    const text = scalarText(value, zone);
    if (text.length > 20) continue;
    cells.push(text);
  }
  return cells.filter((text, at) => at === 0 || text !== '');
}

/**
 * One record as a view: the headline, the rows, then a section for each
 * list of objects and each extra section given, in that order. `next` names
 * the record each section points to, by its first id.
 */
export function recordView(style: Style, record: Record<string, unknown>, options: RecordViewOptions, extra: readonly ViewSection[] = []): RecordView {
  const zone = options.zone;
  const id = record.id;
  const nameKey = NAME_KEYS.find((key) => typeof record[key] === 'string' && record[key] !== '');
  const title = `${options.what}${id === undefined || id === null ? '' : ` ${clean(String(id))}`}${nameKey === undefined ? '' : ` · ${clean(String(record[nameKey]))}`}`;

  const keys = Object.keys(record).filter((key) => key !== 'id' && key !== nameKey);
  const ordered = [...IDENTITY.filter((key) => keys.includes(key)), ...keys.filter((key) => !(IDENTITY as readonly string[]).includes(key))];
  const rows: Array<[string, string]> = [];
  const sections: ViewSection[] = [];
  const next: string[] = [];
  const created = record.createdDate ?? record.dateCreated;

  for (const key of ordered) {
    const value = record[key];
    const label = clean(DATE_LABELS[key] ?? key);
    if (label === 'modified' && value === created) continue;
    if (isScalar(value)) rows.push([label, scalarText(value, zone)]);
    else if (isObject(value)) {
      const named = reference(value);
      if (named !== undefined) rows.push([label, named]);
      else if (Object.keys(value).length === 0) rows.push([label, 'none']);
      else rows.push(...dotted(clean(key), value, zone));
    } else if (Array.isArray(value)) {
      if (value.length === 0) rows.push([label, 'none']);
      else if (value.every(isScalar)) rows.push([label, value.map((item) => scalarText(item, zone)).join(', ')]);
      else {
        const items = value.filter(isObject);
        const shown = items.slice(0, SECTION_ITEMS);
        const ids = shown.map((item) => (item.id === undefined || item.id === null ? '' : clean(String(item.id))));
        const idWidth = Math.max(0, ...ids.map((text) => text.length));
        const lines = shown.map((item, at) => `${ids[at]!.padEnd(idWidth)}  ${itemCells(item, zone).join('  ')}`.trimEnd());
        if (value.length > shown.length) {
          lines.push(`and ${value.length - shown.length} more.${id === undefined || id === null ? '' : ` siren ${options.words} get ${clean(String(id))} --json lists them all.`}`);
        }
        sections.push({ title: `${clean(key)} (${value.length})`, lines });
        const first = ids.find((text) => text !== '');
        const resource = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        if (first !== undefined && options.resources?.includes(resource)) next.push(`${resource} get ${first}`);
      }
    }
  }

  const rich = style.rich;
  const labelWidth = Math.min(rich ? LABEL : Number.POSITIVE_INFINITY, Math.max(0, ...rows.map(([label]) => label.length))) + 2;
  const fit = (text: string, width: number) => (rich ? style.fit(text, width) : text);
  const lines = [style.bold(fit(title, WIDTH))];
  if (rows.length > 0) {
    lines.push('');
    for (const [label, value] of rows) lines.push(`  ${style.dim(fit(label, labelWidth - 2).padEnd(labelWidth))}${fit(value, WIDTH - 2 - labelWidth)}`.trimEnd());
  }
  for (const section of [...sections, ...extra]) {
    lines.push('', `  ${style.bold(section.title)}`, ...section.lines.map((line) => fit(`    ${line}`, WIDTH)));
  }
  return { lines, next };
}
