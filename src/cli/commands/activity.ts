import { NotFoundError, PermissionError, SirenError } from '../../errors';
import { parseJsonBody } from '../../http';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { recordLink } from '../links';
import { currenciesFor, moneyText } from '../money';
import type { CurrencyDefinitions } from '../money';
import { orgScope } from '../org';
import { minute, sirenDate } from '../record-view';
import { clean, hanging, styleFor } from '../style';
import { CliUsageError } from '../targets';
import { itemsOf } from './condition-sets';
import { sinceOf } from './logs';
import { NOTE_TYPES } from './notes';

/*
 * `siren activity --on <type:id>`: what happened to one record, newest
 * first. Siren has no single timeline route, so it reads three and merges
 * them: GET /notes with sourceType and sourceId (the notes people wrote and
 * the ones Siren writes as it works, status changes among them), GET
 * /conversions filtered to the record, and GET /payouts filtered to it.
 * Each route lists newest first by id, so the merge reads one page of each
 * and the cursor keeps how far it got in each.
 */

/** The kinds of item the timeline holds. A status change is a note Siren wrote when a status changed. */
export const ACTIVITY_KINDS = ['note', 'status', 'conversion', 'payout'] as const;
type Kind = (typeof ACTIVITY_KINDS)[number];
type Feed = 'notes' | 'conversions' | 'payouts';

/** The conversions filter for each record type that has conversions. */
const CONVERSION_FILTER: Readonly<Record<string, string>> = {
  collaborator: 'collaboratorId',
  program: 'programId',
  engagement: 'engagementId',
  transaction: 'transactionId',
  obligation: 'obligationId',
};

/** The payouts filter for each record type that has payouts. */
const PAYOUT_FILTER: Readonly<Record<string, string>> = { collaborator: 'collaboratorId', fulfillment: 'fulfillmentId' };

/** The blueprint keys of the notes Siren writes when a status changes, besides every `*_status_changed`. */
const STATUS_KEYS = new Set(['conversion_pending', 'conversion_approved', 'conversion_rejected', 'payout_paid']);

const DEFAULT_LIMIT = 20;
/** The most one route gives in a page. */
const PAGE_MOST = 100;
/** The most rounds of reads one page takes, when --kind leaves out most of what each round reads. */
const ROUNDS = 5;

/** One line of the timeline. Amounts stay as Siren stores them. */
export interface ActivityItem {
  kind: Kind;
  type: string;
  id: number;
  date: string;
  status: string | null;
  amount: number | null;
  currency: string | null;
  text: string;
  url: string;
  [more: string]: unknown;
}

/** One route's page: its items in the order it gave them, and whether it may hold more past them. */
interface FeedPage {
  feed: Feed;
  entries: Array<{ item: ActivityItem; shown: boolean }>;
  full: boolean;
  total?: number;
}

/** The kinds a record type's timeline can hold. */
function kindsFor(type: string): Kind[] {
  return ACTIVITY_KINDS.filter((kind) => (kind === 'conversion' ? type in CONVERSION_FILTER : kind === 'payout' ? type in PAYOUT_FILTER : true));
}

/** `--on <type:id>`, or `--on org` for the organization's own feed. */
function recordOf(given: unknown): { type: string; id?: number } {
  const values = ([] as unknown[]).concat(given ?? []).filter((value): value is string => typeof value === 'string');
  if (values.length === 0) throw new CliUsageError('Name the record with --on, such as --on collaborator:1, or --on org for the organization.');
  if (values.length > 1) throw new CliUsageError('siren activity reads one record at a time. Give --on once.');
  const match = /^([a-z_]+)(?::(\d+))?$/.exec(values[0]!.trim());
  if (match === null || !(NOTE_TYPES as readonly string[]).includes(match[1]!)) {
    throw new CliUsageError(`${JSON.stringify(values[0])} isn't a record with a timeline. Name one as type:id, such as collaborator:1. The types are ${NOTE_TYPES.join(', ')}.`);
  }
  if (match[1] === 'org') return { type: 'org' };
  if (match[2] === undefined) throw new CliUsageError(`Name the record as ${match[1]}:<id>, such as ${match[1]}:1.`);
  return { type: match[1]!, id: Number(match[2]) };
}

/** `--kind note,conversion`, checked against what the record's timeline holds. */
function kindsOf(given: unknown, type: string): Kind[] {
  const holds = kindsFor(type);
  if (typeof given !== 'string') return holds;
  const words = [...new Set(given.split(',').map((word) => word.trim()).filter((word) => word !== ''))];
  const unknown = words.filter((word) => !(ACTIVITY_KINDS as readonly string[]).includes(word));
  if (words.length === 0 || unknown.length > 0) throw new CliUsageError(`--kind takes ${ACTIVITY_KINDS.join(', ')}, or several joined by commas.`);
  const missing = words.filter((word) => !holds.includes(word as Kind));
  if (missing.length > 0) {
    const holder = { conversion: 'collaborators, programs, engagements, sales and obligations', payout: 'collaborators and fulfillments' } as const;
    throw new CliUsageError(`A ${type.replace(/_/g, ' ')}'s timeline has no ${missing.join(' or ')} items. Siren lists ${missing.map((kind) => `${kind}s for ${holder[kind as 'conversion' | 'payout']}`).join(', and ')}.`);
  }
  return words as Kind[];
}

/** `--limit`, 1 to 100. */
function limitOf(given: unknown): number {
  if (given === undefined) return DEFAULT_LIMIT;
  if (typeof given !== 'string' || !/^\d+$/.test(given) || Number(given) < 1 || Number(given) > PAGE_MOST) {
    throw new CliUsageError(`--limit takes a whole number from 1 to 100, and got ${JSON.stringify(given)}.`);
  }
  return Number(given);
}

/** How far each route has been read, as `--cursor` carries it. */
type Offsets = Record<Feed, number>;

/** The cursor for the next page: how many of each route's items the pages so far took. */
export function cursorOf(offsets: Offsets): string {
  return Buffer.from(`n${offsets.notes}.c${offsets.conversions}.p${offsets.payouts}`).toString('base64url');
}

/** `--cursor`, as the previous page printed it. */
export function offsetsOf(given: unknown): Offsets {
  if (given === undefined) return { notes: 0, conversions: 0, payouts: 0 };
  const match = typeof given === 'string' ? /^n(\d+)\.c(\d+)\.p(\d+)$/.exec(Buffer.from(given, 'base64url').toString('utf8')) : null;
  if (match === null) throw new CliUsageError('--cursor takes the cursor the previous page printed, and this one does not read as one.');
  return { notes: Number(match[1]), conversions: Number(match[2]), payouts: Number(match[3]) };
}

/** A note's blueprint key, the part of its stored content before any details. */
function keyOf(content: unknown): string | undefined {
  return typeof content === 'string' && /^[a-z_]+(\?|$)/.test(content) ? content.split('?')[0] : undefined;
}

/** The count a list answer carries, from its header or envelope. */
function totalOf(response: { headers: { get(name: string): string | null } }, body: unknown): number | undefined {
  const header = response.headers.get('x-siren-estimated-count');
  const counted = header !== null ? Number(header) : typeof body === 'object' && body !== null && typeof (body as { total?: unknown }).total === 'number' ? (body as { total: number }).total : undefined;
  return counted !== undefined && Number.isFinite(counted) ? counted : undefined;
}

/** Why a route answered nothing, in a sentence, for the line that says what the timeline leaves out. */
function hiddenReason(error: unknown): string {
  if (error instanceof NotFoundError && /^(?:siren: )?not found\.?$/i.test(error.message.trim())) return "This Siren doesn't answer that route yet.";
  if (error instanceof PermissionError && error.code === 'plan_required') return "This organization's plan doesn't include it.";
  if (error instanceof PermissionError) return "This sign-in can't read them.";
  if (error instanceof SirenError) return `Siren answered ${error.statusCode ?? 'with an error'}: ${clean(error.message.replace(/^Siren: /, ''))}`;
  return clean(error instanceof Error ? error.message : String(error));
}

/** `siren activity --on <type:id>`: a record's timeline, newest first, one line each. */
export async function activity(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const record = recordOf(values.on);
  const kinds = kindsOf(values.kind, record.type);
  const limit = limitOf(values.limit);
  const offsets = offsetsOf(values.cursor);
  // A timeline reaches back as far as the record does, not only the log's 7 days.
  const since = typeof values.since === 'string' ? sinceOf(values.since, io.now(), { longest: Infinity }) : undefined;
  const sinceMs = since === undefined ? undefined : Date.parse(since);

  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'activity');
  const http = scope.http;
  const id = record.id ?? scope.orgId;
  const link = (type: string, recordId: string | number, extra: { fulfillmentId?: unknown } = {}) => recordLink(run.target.baseUrl, io.env, scope.orgSlug, type, recordId, extra);
  const number = String(Math.min(limit + 1, PAGE_MOST));

  // A payout's notes open on its fulfillment, which the payout names.
  let recordUrl = link(record.type, id);
  if (record.type === 'payout' && (kinds.includes('note') || kinds.includes('status'))) {
    const payout = await http.request({ method: 'GET', path: `/payouts/${id}`, retriable: true }).then(parseJsonBody).catch(() => undefined);
    recordUrl = link('payout', id, { fulfillmentId: (payout as { fulfillmentId?: unknown } | undefined)?.fulfillmentId });
  }

  // How far each route has been read: from --cursor, then past each round this run reads.
  const position: Offsets = { ...offsets };
  const read = async (feed: Feed, path: string, query: Record<string, string>, toItem: (row: Record<string, unknown>) => { item: ActivityItem; shown: boolean }): Promise<FeedPage> => {
    const response = await http.request({ method: 'GET', path, query: { ...query, number, offset: String(position[feed]) }, retriable: true });
    const body = await parseJsonBody(response);
    const rows = itemsOf(body);
    const entries: FeedPage['entries'] = [];
    let full = rows.length >= Number(number);
    for (const row of rows) {
      const entry = toItem(row);
      // Each route lists newest first, so the first item older than --since ends it.
      if (sinceMs !== undefined && sirenDate(entry.item.date).getTime() < sinceMs) {
        full = false;
        break;
      }
      entries.push(entry);
    }
    const total = totalOf(response, body);
    return { feed, entries, full, ...(total === undefined ? {} : { total }) };
  };

  const reads: Array<{ feed: Feed; load: () => Promise<FeedPage> }> = [];
  if (kinds.includes('note') || kinds.includes('status')) {
    const query: Record<string, string> = { sourceType: record.type, sourceId: String(id), order: 'desc', fields: 'id,content,renderedContent,creationSource,dateCreated' };
    if (since !== undefined) query.from = since.slice(0, 19).replace('T', ' ');
    reads.push({
      feed: 'notes',
      load: () => read('notes', '/notes', query, (note) => {
        const key = keyOf(note.content);
        const kind: Kind = key !== undefined && (key.endsWith('_status_changed') || STATUS_KEYS.has(key)) ? 'status' : 'note';
        return {
          item: { kind, type: 'note', id: Number(note.id), date: String(note.dateCreated ?? ''), status: null, amount: null, currency: null, text: clean(String(note.renderedContent ?? note.content ?? '')), url: recordUrl, ...(key === undefined ? {} : { key }), author: note.creationSource ?? null },
          shown: kinds.includes(kind),
        };
      }),
    });
  }
  if (kinds.includes('conversion')) {
    reads.push({
      feed: 'conversions',
      load: () => read('conversions', '/conversions', { [CONVERSION_FILTER[record.type]!]: String(id), orderBy: 'id', order: 'desc' }, (conversion) => {
        const parts = [
          typeof conversion.type === 'string' ? `${clean(conversion.type)} conversion` : 'conversion',
          ...(conversion.transactionId != null ? [`transaction ${clean(String(conversion.transactionId))}`] : []),
          ...(conversion.obligationId != null ? [`obligation ${clean(String(conversion.obligationId))}`] : []),
        ];
        return {
          item: {
            kind: 'conversion',
            type: 'conversion',
            id: Number(conversion.id),
            date: String(conversion.dateCreated ?? ''),
            status: typeof conversion.status === 'string' ? conversion.status : null,
            amount: typeof conversion.amount === 'number' ? conversion.amount : null,
            currency: typeof conversion.obligationAwardType === 'string' ? conversion.obligationAwardType : null,
            text: parts.join(', '),
            url: link('conversion', Number(conversion.id)),
            transactionId: conversion.transactionId ?? null,
            obligationId: conversion.obligationId ?? null,
          },
          shown: true,
        };
      }),
    });
  }
  if (kinds.includes('payout')) {
    reads.push({
      feed: 'payouts',
      load: () => read('payouts', '/payouts', { [PAYOUT_FILTER[record.type]!]: String(id), orderBy: 'id', order: 'desc' }, (payout) => {
        const zone = io.env.TZ;
        const parts = [
          ...(payout.fulfillmentId != null ? [`in fulfillment ${clean(String(payout.fulfillmentId))}`] : []),
          ...(typeof payout.datePaid === 'string' ? [`paid ${minute(payout.datePaid, zone)}`] : []),
          ...(typeof payout.waitingReason === 'string' && payout.waitingReason !== '' ? [`waiting: ${clean(payout.waitingReason).replace(/_/g, ' ')}`] : []),
          ...(typeof payout.failureReason === 'string' && payout.failureReason !== '' ? [`failed: ${clean(payout.failureReason)}`] : []),
        ];
        return {
          item: {
            kind: 'payout',
            type: 'payout',
            id: Number(payout.id),
            date: String(payout.dateCreated ?? ''),
            status: typeof payout.status === 'string' ? payout.status : null,
            amount: typeof payout.value === 'number' ? payout.value : null,
            currency: typeof payout.currency === 'string' ? payout.currency : null,
            text: parts.join(', '),
            url: link('payout', Number(payout.id), { fulfillmentId: payout.fulfillmentId }),
            fulfillmentId: payout.fulfillmentId ?? null,
          },
          shown: true,
        };
      }),
    });
  }

  // Merge newest first. A route whose page was full may hold a newer item than the other routes' next ones,
  // so a round ends once such a route's items run out. When --kind leaves out most of what a round read,
  // the next round reads on from there, up to ROUNDS reads of each route, and the cursor picks up after that.
  const hidden: Array<{ part: Feed; reason: string }> = [];
  const items: ActivityItem[] = [];
  const totals = new Map<Feed, number | undefined>();
  let live = reads;
  let more = false;
  for (let round = 0; round < ROUNDS && items.length < limit && live.length > 0; round += 1) {
    const settled = await Promise.allSettled(live.map((one) => one.load()));
    const pages: FeedPage[] = [];
    settled.forEach((result, at) => {
      if (result.status === 'fulfilled') pages.push(result.value);
      else hidden.push({ part: live[at]!.feed, reason: hiddenReason(result.reason) });
    });
    // Nothing could be read at all: the first refusal is the answer.
    if (round === 0 && pages.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    if (round === 0) for (const page of pages) totals.set(page.feed, page.total);
    const at = new Map(pages.map((page) => [page.feed, 0]));
    for (;;) {
      if (items.length >= limit) break;
      if (pages.some((page) => page.full && at.get(page.feed)! >= page.entries.length)) break;
      const heads = pages.filter((page) => at.get(page.feed)! < page.entries.length);
      if (heads.length === 0) break;
      const time = (page: FeedPage) => sirenDate(page.entries[at.get(page.feed)!]!.item.date).getTime() || 0;
      const next = heads.reduce((best, page) => (time(page) > time(best) ? page : best));
      const entry = next.entries[at.get(next.feed)!]!;
      at.set(next.feed, at.get(next.feed)! + 1);
      if (entry.shown) items.push(entry.item);
    }
    for (const page of pages) position[page.feed] += at.get(page.feed)!;
    more = pages.some((page) => page.full || at.get(page.feed)! < page.entries.length);
    // A route that gave all it holds is read no more. One that failed is left out of later rounds.
    live = live.filter((one) => pages.some((page) => page.feed === one.feed && (page.full || at.get(page.feed)! < page.entries.length)));
  }
  const nextOffsets = position;
  const nextCursor = more ? cursorOf(nextOffsets) : null;

  if (values.json === true) {
    run.print(JSON.stringify({ record: { type: record.type, id: record.id ?? null, url: recordUrl }, items, nextCursor, hidden }, null, 2));
    return 0;
  }

  const out = styleFor(io, 'stdout', values);
  const err = styleFor(io, 'stderr', values);
  const tip = (text: string) => io.stderr(`${err.rich ? err.dim(text) : text}\n`);
  for (const part of hidden) io.stderr(`${err.rich ? err.warning(`Not shown: ${part.part}. ${part.reason}`) : `Not shown: ${part.part}. ${part.reason}`}\n`);
  if (items.length === 0) {
    tip(values.cursor !== undefined ? 'Nothing more.' : 'Nothing has happened to this record that this sign-in can read.');
    return 0;
  }

  const money = items.some((item) => item.amount !== null)
    ? await currenciesFor(io.configDir, `${run.target.baseUrl} ${scope.orgId}`, io.now(), async () => parseJsonBody(await http.request({ method: 'GET', path: '/registries/currencies', retriable: true })))
    : undefined;
  const zone = io.env.TZ;
  const rows = items.map((item) => [
    item.date === '' ? '' : minute(item.date, zone),
    `${item.type} ${item.id}`,
    item.status === null ? '' : clean(item.status),
    amountText(item, money),
    item.text,
  ]);
  const widths = [0, 1, 2, 3].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
  if (out.rich) {
    // In a terminal the record's page prints once, above the items. Each item is a heading line, then its full text wrapped beneath, never cut.
    const name = record.id === undefined ? record.type : `${record.type} ${record.id}`;
    run.print(out.bold(`Activity on ${name}`));
    run.print(out.dim(recordUrl));
    for (const row of rows) {
      const [when = '', what = '', status = '', amount = ''] = row;
      const head = [when, out.bold(what), status, amount].filter((cell) => cell !== '').join('  ');
      run.print('');
      run.print(head);
      if (row[4] !== '') run.print(hanging('  ', row[4]!, '  '));
    }
    run.print('');
  } else {
    for (const [index, row] of rows.entries()) {
      const cells = row.slice(0, 4).map((cell, column) => (widths[column]! === 0 ? undefined : cell.padEnd(widths[column]!))).filter((cell): cell is string => cell !== undefined);
      // Through a pipe, one line an item, its address last, so awk '{print $NF}' reads the address.
      run.print([...cells, row[4], items[index]!.url].filter((cell) => cell !== '').join('  '));
    }
  }

  const counts = [...totals.values()];
  const counted = hidden.length === 0 && kinds.includes('note') === kinds.includes('status') && counts.every((total) => total !== undefined) ? counts.reduce((sum: number, total) => sum + total!, 0) : undefined;
  const shown = `${items.length}${counted !== undefined && counted > items.length ? ` of ${counted}` : ''} ${items.length === 1 ? 'item' : 'items'}.`;
  const again = [
    `activity --on ${record.type}${record.id === undefined ? '' : `:${record.id}`}`,
    ...(typeof values.kind === 'string' ? [`--kind ${kinds.join(',')}`] : []),
    ...(typeof values.since === 'string' ? [`--since ${values.since}`] : []),
    ...(values.limit === undefined ? [] : [`--limit ${limit}`]),
    `--cursor ${nextCursor}`,
  ].join(' ');
  tip(nextCursor === null ? shown : `${shown} ${run.command(again)} reads the next page.`);
  const conversion = items.find((item) => item.kind === 'conversion');
  if (conversion !== undefined) tip(`${run.command(`explain conversion ${conversion.id}`)} says why it paid what it did.`);
  // Notes have no page of their own, so the tip names an item that does, or the record.
  const paged = items.find((item) => item.type !== 'note');
  if (out.rich) tip(`${run.command(paged === undefined ? `open ${record.type}${record.id === undefined ? '' : ` ${record.id}`}` : `open ${paged.type} ${paged.id}`)} opens its page in Siren.`);
  return 0;
}

/** An item's amount as the tool prints money, or its stored integer and code when the currency can't be read. */
function amountText(item: ActivityItem, definitions: CurrencyDefinitions): string {
  if (item.amount === null) return '';
  return moneyText(item.amount, item.currency, definitions) ?? `${item.amount}${item.currency === null ? '' : ` ${clean(item.currency)}`}`;
}

