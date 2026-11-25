import { CallbackAccessTokenSource } from '../../auth/callback-access-token-source';
import { createHttpTransport } from '../../client';
import { ConnectionError, SirenError, appErrorCode } from '../../errors';
import { parseJsonBody } from '../../http';
import type { HttpTransport } from '../../http';
import { appKeyArgument } from './apply';
import { contextOf } from '../context';
import { orgScope } from '../org';
import type { CommandContext, CommandInput } from '../context';
import type { CliIo } from '../io';
import { clean, styleFor, visibleLength } from '../style';
import type { Style } from '../style';
import { CliRefusal, CliUsageError } from '../targets';
import { idLabeller, whole } from './requests';
import type { IdLabel } from './requests';

/*
 * `siren logs tail`: what happens in the organization as it happens, from
 * `GET /logs`, the one feed of app requests, deliveries, webhook
 * deliveries, event ingestion and API calls. `siren apps requests --follow`
 * reads the same feed. Contract: contract/devtools-logs.md, section 6.
 *
 * The connection is a paced cursor poll, as `siren listen` uses: each read
 * answers at once with the entries after the cursor, the next cursor, and
 * `nextPollMs`, how long to wait before the next read. 0 means more are
 * waiting. Siren sets the pace, so it can slow every reader at once.
 */

/** The entry types, in the order the headline names them. */
export const LOG_TYPES = ['request', 'delivery', 'webhook', 'event', 'api'] as const;
export type LogType = (typeof LOG_TYPES)[number];

export const LOG_STATUSES = ['ok', 'failed', 'refused'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

/** Who made an API call. `api-key` is read as `api_key`. */
export const LOG_SOURCES = ['dashboard', 'api_key', 'app', 'cli', 'site'] as const;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** How far back `--since` may reach: Siren keeps the API request log 7 days. */
const MAX_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

/** The longest wait between reads while Siren is out of reach, and how long the tail keeps trying. */
const BACKOFF_MAX_MS = 5000;
const GIVE_UP_MS = 5 * 60 * 1000;

/** How long to wait when Siren names no pace. */
const DEFAULT_POLL_MS = 1000;

/** The widths of a line's columns, so a line is 80 columns at most. */
const TYPE_WIDTH = 8;
const SUMMARY_WIDTH = 43;
const STATUS_WIDTH = 9;
const DURATION_WIDTH = 6;
const LINE_WIDTH = 80;
/** Where a reason or a tip under a line starts, under the type. */
const INDENT = ' '.repeat(10);

/** One entry as `GET /logs` gives it. Fields beyond these depend on the type. */
export interface LogEntry {
  id: string;
  type: LogType | (string & {});
  /** UTC, such as `2026-11-24T19:02:11.000Z`. */
  at: string;
  status: LogStatus | (string & {});
  summary: string;
  durationMs: number | null;
  httpStatus: number | null;
  reason: string | null;
  app?: string | null;
  feature?: string | null;
  /** For a `request`, the request as `GET /apps/requests` shapes it. For a `delivery`, the request id. */
  request?: unknown;
  requestStatus?: string;
  requestId?: string;
  source?: string;
  body?: unknown;
  [field: string]: unknown;
}

/** One page of the feed. */
interface LogPage {
  entries: LogEntry[];
  nextCursor: string;
  nextPollMs: number;
}

/** The filters `GET /logs` reads. */
export interface LogQuery {
  type?: string;
  status?: string;
  app?: string;
  feature?: string;
  method?: string;
  path?: string;
  source?: string;
  /** An ISO time. Read only on the first page. */
  since?: string;
  expand?: boolean;
}

/** What {@link followFeed} needs. */
export interface FollowOptions {
  /** The client for the organization the command acts in. Without one, the run's own session. */
  http?: Pick<HttpTransport, 'request'>;
  query: LogQuery;
  /** Stop after this many entries, with exit code 0. */
  limit?: number;
  onEntry(entry: LogEntry): void | Promise<void>;
}

/**
 * `siren logs tail`: prints each entry as it happens until Ctrl-C, which
 * ends it with exit code 130, or until `--limit` entries, which ends it
 * with 0. Before each read after the first it reads the target's edition
 * again, as every command that keeps sending does.
 */
export async function logsTail(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const json = values.json === true;
  const query = queryOf(values, io.now());
  const limit = limitOf(values.limit);
  const run = contextOf(input);
  const session = await run.signedIn();
  // The organization signedIn() settled: --org, SIREN_ORG, "org" in siren.app.json, the only one, or the one asked for.
  const org = await orgScope(run, input, session, 'logs tail');
  const style = styleFor(io, 'stdout', { json });
  // Short request ids in hints when Siren finds requests by their start (CLI pass 3), from one idPrefix call at the first.
  const labelFor = idLabeller(org);

  if (!json) {
    run.print(
      style.report({
        headline: `Tailing ${style.bold(clean(org.orgName))}, ${scopeWords(query)}`,
        rows: [
          ['Showing', showingWords(query)],
          ['Since', typeof values.since === 'string' ? values.since : 'now'],
        ],
        tips: ['Ctrl-C stops. --json prints one JSON object a line.'],
      }),
    );
  }

  return followFeed(run, io, {
    http: org.http,
    query,
    limit,
    onEntry: async (entry) => {
      if (json) return io.stdout(`${JSON.stringify(entry)}\n`);
      // Only a failed entry names a request, in its hint, so only one of those asks Siren how to print ids.
      const id = entry.status === 'failed' || entry.status === 'refused' ? requestIdOf(entry) : undefined;
      const label = id === undefined ? whole : await labelFor(id);
      for (const line of entryLines(style, entry, (words) => run.command(`${words}${org.flag}`), label)) run.print(line);
    },
  });
}

/**
 * Reads the feed until Ctrl-C (130) or `limit` entries (0), calling
 * `onEntry` for each entry in time order. The first read starts at now, or
 * at `query.since`. A Siren that cannot be reached, or answers 429 or 5xx,
 * is read again after a wait that grows to 5 seconds, and after 5 minutes
 * without an answer the tail gives up with a refusal. Any other refusal
 * ends it at once.
 */
export async function followFeed(run: CommandContext, io: CliIo, options: FollowOptions): Promise<number> {
  const http =
    options.http ??
    createHttpTransport({
      accessToken: new CallbackAccessTokenSource(
        () => run.accessToken(),
        () => run.refresh(),
      ),
      httpClient: io.httpClient,
      baseUrl: run.target.baseUrl,
    });
  const { query, limit } = options;
  const stop = () => undefined;
  io.signal?.addEventListener('abort', stop);
  let cursor: string | undefined;
  let printed = 0;
  let downSince: number | undefined;
  let misses = 0;

  try {
    for (let read = 1; ; read += 1) {
      if (io.signal?.aborted) return 130;
      if (read > 1) await run.recheckEdition();

      let page: LogPage;
      try {
        page = await readPage(http, cursor === undefined ? { ...query, cursor: undefined } : { ...query, since: undefined, cursor });
      } catch (error) {
        if (!outOfReach(error)) throw logsRefusal(run, query, error);
        downSince ??= io.now();
        if (io.now() - downSince >= GIVE_UP_MS) {
          throw new CliRefusal('Siren stayed out of reach for 5 minutes, so the tail stopped.', {
            why: (error as Error).message.replace(/^Siren: /, ''),
            fix: run.command('logs tail'),
            fixWords: 'to start again',
          });
        }
        await io.sleep(Math.min(BACKOFF_MAX_MS, 500 * 2 ** misses));
        misses += 1;
        continue;
      }
      downSince = undefined;
      misses = 0;

      cursor = page.nextCursor;
      for (const entry of page.entries) {
        await options.onEntry(entry);
        printed += 1;
        if (limit !== undefined && printed >= limit) return 0;
      }
      if (io.signal?.aborted) return 130;
      if (page.nextPollMs > 0) await io.sleep(page.nextPollMs);
    }
  } finally {
    io.signal?.removeEventListener('abort', stop);
  }
}

/** One read of `GET /logs`, checked enough that a page always has entries and a cursor. */
async function readPage(http: Pick<HttpTransport, 'request'>, query: LogQuery & { cursor?: string }): Promise<LogPage> {
  const response = await http.request({
    method: 'GET',
    path: '/logs',
    query: { ...query, expand: query.expand === true ? 1 : undefined },
    retriable: false,
  });
  const body = (await parseJsonBody(response)) as Partial<LogPage> | null;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.entries) || typeof body.nextCursor !== 'string') {
    throw new SirenError('Siren answered GET /logs with no list of entries and no cursor.');
  }
  const pace = typeof body.nextPollMs === 'number' && Number.isFinite(body.nextPollMs) && body.nextPollMs >= 0 ? body.nextPollMs : DEFAULT_POLL_MS;
  return { entries: body.entries, nextCursor: body.nextCursor, nextPollMs: pace };
}

/** True for an error that means Siren is out of reach for now: no answer, 429 or 5xx. */
function outOfReach(error: unknown): boolean {
  if (error instanceof ConnectionError) return true;
  return error instanceof SirenError && error.statusCode !== undefined && (error.statusCode === 429 || error.statusCode >= 500);
}

/** A refusal from `GET /logs` in the tool's words, where it has better ones. */
function logsRefusal(run: CommandContext, query: LogQuery, error: unknown): unknown {
  const code = appErrorCode(error);
  if (code === 'app_not_found' && query.app !== undefined) {
    return new CliRefusal(`This organization has no app ${query.app}.`, { why: `Siren found no app with the key ${query.app} here.`, fix: run.command('apps list'), fixWords: 'to see its apps' });
  }
  if (code === 'logs_since_too_old') {
    return new CliRefusal('--since reaches back too far.', { why: 'Siren keeps the log 7 days, so --since can reach back 7 days at most.', fixText: 'Pass --since 7d or less.' });
  }
  if (error instanceof SirenError && error.statusCode === 404 && code === undefined) {
    return new CliRefusal('This Siren has no log feed yet.', { why: 'It answered 404 for GET /logs, so it is older than this tool.', fixText: 'Update that Siren, or point the tool at one that has the log feed.' });
  }
  return error;
}

/** The feed's query from the command line, or `CliUsageError`, so a bad flag answers 2 and sends nothing. */
export function queryOf(values: Readonly<Record<string, string | boolean | undefined>>, now: number): LogQuery {
  const query: LogQuery = {};
  const type = listFlag(values.type, LOG_TYPES, 'type');
  if (type !== undefined) query.type = type;
  const status = listFlag(values.status, LOG_STATUSES, 'status');
  if (status !== undefined) query.status = status;
  const source = listFlag(typeof values.source === 'string' ? values.source.replace(/api-key/g, 'api_key') : undefined, LOG_SOURCES, 'source');
  if (source !== undefined) query.source = source;
  if (typeof values.app === 'string') query.app = appKeyArgument(values.app);
  if (typeof values.feature === 'string') {
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(values.feature)) throw new CliUsageError(`A feature key is lowercase letters and digits, and ${JSON.stringify(values.feature)} is not one.`);
    query.feature = values.feature;
  }
  if (typeof values.method === 'string') {
    const method = values.method.toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) throw new CliUsageError(`--method takes ${METHODS.join(', ')}.`);
    query.method = method;
  }
  if (typeof values.path === 'string') query.path = values.path.startsWith('/') ? values.path : `/${values.path}`;
  if (typeof values.since === 'string') query.since = sinceOf(values.since, now);
  if (values.expand === true) query.expand = true;
  return query;
}

/** A comma list of known words, or `CliUsageError` naming them. */
function listFlag(value: string | boolean | undefined, known: readonly string[], flag: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const words = value
    .toLowerCase()
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');
  const unknown = words.filter((word) => !known.includes(word));
  if (words.length === 0 || unknown.length > 0) throw new CliUsageError(`--${flag} takes ${known.join(', ')}, or several joined by commas.`);
  return [...new Set(words)].join(',');
}

/** `--since` as an ISO time: `10m`, `2h` or `1d` back from now, or a time Date can read. At most 7 days back. */
export function sinceOf(value: string, now: number): string {
  const ago = /^(\d+)([smhd])$/.exec(value.trim());
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const at = ago ? now - Number(ago[1]) * unit[ago[2] as keyof typeof unit] : Date.parse(value);
  if (Number.isNaN(at)) throw new CliUsageError(`--since takes a time back from now, such as 10m, 2h or 1d, or a time such as 2026-11-24T19:00:00Z, and ${JSON.stringify(value)} is neither.`);
  if (now - at > MAX_SINCE_MS) throw new CliUsageError('Siren keeps the log 7 days, so --since can reach back 7 days at most.');
  return new Date(at).toISOString();
}

/** `--limit` as a whole number of 1 or more. */
function limitOf(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new CliUsageError(`--limit takes a whole number of 1 or more, and ${JSON.stringify(value)} is not one.`);
  return Number(value);
}

const TYPE_PLURALS: Record<LogType, string> = { request: 'requests', delivery: 'deliveries', webhook: 'webhooks', event: 'events', api: 'API calls' };

/** The types the tail shows, in words: "requests, deliveries and API calls". */
function showingWords(query: LogQuery): string {
  const types = query.type === undefined ? [...LOG_TYPES] : LOG_TYPES.filter((type) => query.type!.split(',').includes(type));
  const words = types.map((type) => TYPE_PLURALS[type]);
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What the headline says the tail covers: "all apps", "app acme-payouts, failed only". */
function scopeWords(query: LogQuery): string {
  const parts = [query.app === undefined ? 'all apps' : `app ${query.app}`];
  if (query.feature !== undefined) parts.push(`feature ${query.feature}`);
  if (query.status !== undefined) parts.push(`${query.status.split(',').join(' or ')} only`);
  return parts.join(', ');
}

/**
 * One entry as lines: time, type, summary, status and duration, aligned
 * and 80 columns at most in a terminal, whole through a pipe. A failed or refused entry's status is the style
 * module's failure, a red ✗ in a terminal, with its reason under it in red
 * and a › command to look closer when there is one. `--expand` adds the
 * body as JSON under it. Every value from Siren is cleaned of escape
 * sequences and control characters first.
 */
export function entryLines(style: Style, entry: LogEntry, command: (words: string) => string, label: IdLabel = whole): string[] {
  const bad = entry.status === 'failed' || entry.status === 'refused';
  const time = clock(entry.at);
  const type = cut(style, String(entry.type), TYPE_WIDTH).padEnd(TYPE_WIDTH);
  const summary = cut(style, summaryOf(entry), SUMMARY_WIDTH).padEnd(SUMMARY_WIDTH);
  const word = cut(style, String(entry.status), bad && style.rich ? STATUS_WIDTH - 2 : STATUS_WIDTH);
  const shown = bad ? style.failure(word) : word;
  const status = `${shown}${' '.repeat(Math.max(0, STATUS_WIDTH - visibleLength(shown)))}`;
  const duration = formatDuration(entry.durationMs).padStart(DURATION_WIDTH);
  const lines = [`${style.dim(time)}  ${type}  ${summary}  ${status}${duration}`.trimEnd()];

  if (bad && entry.reason) lines.push(`${INDENT}${style.red(cut(style, entry.reason, LINE_WIDTH - INDENT.length))}`);
  const look = lookCloser(entry, label);
  if (bad && look !== undefined) {
    // A command is never cut, since a cut one cannot be run. When it would pass 80 columns under the type, it moves left.
    const hint = style.next(style.dim(command(look)));
    lines.push(`${INDENT.length + visibleLength(hint) <= LINE_WIDTH ? INDENT : '  '}${hint}`);
  }
  if (bad && look === undefined && typeof entry.requestId === 'string') lines.push(`${INDENT}${style.dim(cut(style, `Request id ${entry.requestId}`, LINE_WIDTH - INDENT.length))}`);
  if (entry.body !== undefined) {
    // JSON escapes the C0 controls but not the C1 ones, so each line is cleaned too.
    for (const line of JSON.stringify(entry.body, null, 2).split('\n')) lines.push(`${INDENT}${style.dim(clean(line))}`);
  }
  return lines;
}

/** What a line says: Siren's summary, the app, and for a request its status. */
function summaryOf(entry: LogEntry): string {
  const parts = [entry.summary];
  if (typeof entry.app === 'string' && entry.app !== '') parts.push(entry.app);
  if (entry.type === 'request' && typeof entry.requestStatus === 'string') parts.push(entry.requestStatus);
  return parts.join('  ');
}

/** The app request an entry is about, `apr_…`, or undefined. */
function requestIdOf(entry: LogEntry): string | undefined {
  const request = entry.request;
  if (typeof request === 'string' && request.startsWith('apr_')) return clean(request);
  if (typeof request === 'object' && request !== null && typeof (request as { id?: unknown }).id === 'string') return clean((request as { id: string }).id);
  return undefined;
}

/** The command that shows more about a failed entry, or undefined. */
function lookCloser(entry: LogEntry, label: IdLabel): string | undefined {
  const id = requestIdOf(entry);
  return id === undefined ? undefined : `apps requests ${label(id)}`;
}

/** An entry's time as local `HH:MM:SS`. */
function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** `38ms`, `1.2s`, or nothing when Siren keeps no time. */
function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `text` from Siren on one line, cleaned, and in a terminal cut to `width` columns with an ellipsis. Through a pipe it stays whole. */
function cut(style: Style, text: string, width: number): string {
  return style.fit(clean(text.replace(/[\r\n\t]+/g, ' ')), width);
}
