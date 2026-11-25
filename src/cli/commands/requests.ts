import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppErrorCode, ConflictError, ErrorCode, NotFoundError, SirenError, appErrorCode } from '../../errors';
import { AppRequestStatus } from '../../taxonomy';
import type { App, AppAnswer, AppRequestDetail, AppRequestListParams, AppRequestRecord } from '../../record-types';
import { MAX_APP_ANSWER_BYTES } from '../../resources/apps';
import { appKeyArgument, orgNamed } from './apply';
import { kindLabel, kindName } from '../app-kinds';
import { contextOf } from '../context';
import type { CommandContext, CommandInput } from '../context';
import { REPORT_WIDTH, clean, styleFor, visibleLength } from '../style';
import type { Style } from '../style';
import { CliRefusal, CliUsageError } from '../targets';

/*
 * `siren apps requests`, `answer` and `resend`: what Siren sent the
 * organization's apps and what came back. Contract:
 * docs/architecture/apps-cli.md, "The commands".
 */

/** How long `--follow` waits between reads, in milliseconds. */
const FOLLOW_EVERY_MS = 2000;

/** A request id: `apr_` and 32 lowercase hex characters. */
const REQUEST_ID = /^apr_[0-9a-f]{32}$/;

/** A request id or its start, as git takes a commit's: at least 4 hex characters after any `apr_`, which every id shares. */
const REQUEST_PREFIX = /^(?:apr_)?[0-9a-f]{4,32}$/;

/** How many characters of a request id the tool shows, and every command takes. */
const SHORT_ID = 8;

/**
 * The request id or the start of one that a command line names, or
 * `CliUsageError` in the tool's words, so the command answers 2 and sends
 * nothing. {@link requestIdFor} finds the whole id for a start.
 */
export function requestIdArgument(id: string): string {
  const lower = id.toLowerCase();
  if (!REQUEST_PREFIX.test(lower)) {
    throw new CliUsageError(`${JSON.stringify(id)} isn't a request id. Request ids look like apr_ec16a240198d5bc956c9a55c01103dd4, and the first ${SHORT_ID} characters after apr_ will do.`);
  }
  return lower;
}

/** A request's id as the list shows it: the first {@link SHORT_ID} hex characters. */
export function shortId(id: string): string {
  return id.replace(/^apr_/, '').slice(0, SHORT_ID);
}

/** The most requests `GET /apps/requests` answers in one list. A list this long may leave older requests out. */
const LIST_LIMIT = 50;

/**
 * The whole id for `typed`, a whole id or its start, after a search that
 * covers the whole organization. Siren lists the latest 50 requests, with
 * no paging. When that list holds fewer than 50, it holds every request.
 * When it is full, the tool reads the latest 50 in each state, and the
 * search covers the organization when every state holds fewer than 50.
 * A start that matches several requests is refused with the list of them,
 * never settled by picking one. A search that could not cover the
 * organization is refused too, since an older request could start the
 * same way, and the command must not act on the wrong one.
 */
async function requestIdFor(run: CommandContext, typed: string, org: string): Promise<string> {
  if (REQUEST_ID.test(typed)) return typed;
  const start = typed.replace(/^apr_/, '');
  const siren = run.siren();
  const latest = await siren.apps.requests.list({});
  const rows = [...latest];
  let whole = latest.length < LIST_LIMIT;
  if (!whole) {
    whole = true;
    for (const status of Object.values(AppRequestStatus)) {
      const some = await siren.apps.requests.list({ status });
      rows.push(...some);
      if (some.length >= LIST_LIMIT) whole = false;
    }
  }
  const ids = [...new Set(rows.map((row) => row.id).filter((id) => id.startsWith(`apr_${start}`)))];
  if (ids.length > 1) {
    throw new CliRefusal(`${ids.length} requests start with ${start}: ${ids.map((id) => shortIdOf(id, start)).join(', ')}.`, { why: 'Give more of the id.' });
  }
  if (!whole) {
    throw new CliRefusal(`${org} has more requests than Siren lists at once, so the tool can't be sure ${start} names one request.`, {
      why: 'Give the whole id, apr_ and 32 characters, which the request view and --json show.',
    });
  }
  if (ids.length === 0) {
    throw new CliRefusal(`${org} has no request that starts with ${start}.`, { fix: run.command('apps requests'), fixWords: 'to list the latest' });
  }
  return ids[0]!;
}

/** Enough of `id` to tell it from the others that start with `start`. */
function shortIdOf(id: string, start: string): string {
  return id.replace(/^apr_/, '').slice(0, Math.max(start.length + 4, SHORT_ID));
}

/** One column of the requests table: its header, the most characters a cell takes, and its cell. */
interface Column {
  header: string;
  cap: number;
  cell: (row: AppRequestRecord) => string;
}

/**
 * `siren apps requests`: the latest requests, oldest first, as a table, for
 * every app or the one `--app` names, and only those that need attention
 * with `--attention`, where the last column says why. In a terminal it
 * leaves out the sends, then the app, then what a request is about, until
 * the table fits. `--json` prints the rows Siren sent. `--follow` reads
 * again every 2 seconds and prints each new request or status change once,
 * until Ctrl-C, which ends it with exit code 130. Before each poll after
 * the first it reads the target's edition again, so a target that changed
 * edition stops the run with exit code 1 before the session is sent there.
 * With a request id or its start it shows that one request instead.
 */
export async function appsRequests(input: CommandInput): Promise<number> {
  const id = input.args[0];
  const { values } = input;
  if (id !== undefined) {
    if (values.app !== undefined || values.attention === true || values.follow === true) {
      const flag = values.app !== undefined ? '--app' : values.attention === true ? '--attention' : '--follow';
      throw new CliUsageError(`${flag} doesn't go with a request id, which shows that one request.`);
    }
    return showRequest(input, id);
  }

  const run = contextOf(input);
  const { io } = input;
  const json = values.json === true;
  const attention = values.attention === true;
  const appKey = typeof values.app === 'string' ? appKeyArgument(values.app) : undefined;
  const session = await run.signedIn();
  const org = orgNamed(session);
  const siren = run.siren();
  const out = styleFor(io, 'stdout', values);
  const filters: AppRequestListParams = attention ? { status: 'needs_attention' } : {};
  const appsById = new Map<number, App>();
  const appOf = async (row: AppRequestRecord): Promise<App | undefined> => {
    if (!appsById.has(row.appId)) for (const app of await siren.apps.list()) appsById.set(app.id, app);
    return appsById.get(row.appId);
  };

  const read = async (): Promise<AppRequestRecord[]> => {
    // The apps come first, once, for the APP column and --app.
    if (appsById.size === 0) for (const app of await siren.apps.list()) appsById.set(app.id, app);
    const rows = [...(await siren.apps.requests.list(filters))];
    // The plain list is the organization's latest 50. Every request that needs attention joins it, however old,
    // so an app's list never says it has none while `apps list` counts one.
    if (!attention) {
      const held = new Set(rows.map((row) => row.id));
      rows.push(...(await siren.apps.requests.list({ status: 'needs_attention' })).filter((row) => !held.has(row.id)));
    }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    if (appKey === undefined) return rows;
    const app = [...appsById.values()].find((candidate) => candidate.key === appKey);
    if (app === undefined) throw new CliRefusal(`${clean(session.orgName)} has no app ${appKey}.`, { fix: run.command('apps list'), fixWords: 'to see its apps' });
    return rows.filter((row) => row.appId === app.id);
  };

  const zone = io.env.TZ;
  const columns: Column[] = [
    { header: 'ID', cap: SHORT_ID, cell: (row) => out.dim(shortId(row.id)) },
    { header: 'WHEN', cap: 12, cell: (row) => when(row.createdAt, zone) },
    { header: 'APP', cap: 18, cell: (row) => clean(appsById.get(row.appId)?.key ?? `app ${row.appId}`) },
    { header: 'FEATURE', cap: 18, cell: (row) => clean(kindName(row.kind).replace(/ action$/, '')) },
    { header: 'ABOUT', cap: 16, cell: (row) => (row.subject ? clean(`${row.subject.type} ${row.subject.id}`) : '') },
    { header: 'SENDS', cap: 5, cell: (row) => String(row.sendCount) },
    attention
      ? { header: 'WHY', cap: Number.POSITIVE_INFINITY, cell: (row) => (row.lastError ? out.red(clean(row.lastError)) : out.amber('No answer')) }
      : { header: 'STATE', cap: 17, cell: (row) => stateCell(out, row) },
  ];
  const width = out.rich ? (io.screen?.size?.columns ?? REPORT_WIDTH) : Number.POSITIVE_INFINITY;

  if (values.follow !== true) {
    const rows = await read();
    if (json) {
      run.print(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      if (appKey !== undefined) {
        run.print(attention ? `No request of ${appKey} needs you.` : `No requests for ${appKey} yet.`);
        run.print(out.next(`${out.command(run.command(`apps requests --app ${appKey} --follow`))} watches for them.`));
      } else run.print(attention ? `Nothing needs you in ${org}.` : `No requests in ${org} yet.`);
      return 0;
    }
    const count = `${rows.length} ${rows.length === 1 ? 'request' : 'requests'}`;
    run.print(attention ? `${out.bold(count)} ${out.amber(rows.length === 1 ? 'needs you' : 'need you')} in ${org}` : `${out.bold(count)} in ${org}`);
    run.print('');
    const shown = fitting(columns, rows, width, false);
    for (const line of out.table(shown.map((column) => column.header), rows.map((row) => shown.map((column) => cut(column.cell(row), column.cap))), width)) run.print(line);
    const newest = shortId(rows.at(-1)!.id);
    run.print('');
    const one = out.command(run.command(`apps requests ${newest}`));
    run.print(out.next(attention ? `${one} shows it, and ${out.command(run.command(`apps resend ${newest}`))} sends it again.` : `${one} shows one.`));
    return 0;
  }

  const seen = new Map<string, string>();
  let header = false;
  // While following, Ctrl-C aborts the signal and the loop ends with 130.
  const following = () => undefined;
  io.signal?.addEventListener('abort', following);
  if (!json) io.stderr(`${styleFor(io, 'stderr', values).dim(`Watching ${org} for requests. Ctrl-C stops.`)}\n`);
  const shown = fitting(columns, [], width, true);
  try {
    for (let poll = 1; ; poll += 1) {
      if (poll > 1) await run.recheckEdition();
      for (const row of await read()) {
        if (seen.get(row.id) === row.status) continue;
        seen.set(row.id, row.status);
        if (json) {
          run.print(JSON.stringify(row));
          continue;
        }
        await appOf(row);
        if (!header) {
          run.print(out.dim(padded(shown.map((column) => column.header), shown)));
          header = true;
        }
        run.print(padded(shown.map((column) => cut(column.cell(row), column.cap)), shown));
      }
      if (io.signal?.aborted) return 130;
      await io.sleep(FOLLOW_EVERY_MS);
      if (io.signal?.aborted) return 130;
    }
  } finally {
    io.signal?.removeEventListener('abort', following);
  }
}

/**
 * The columns that fit `width`: it leaves out the sends, then the app,
 * then what a request is about, until the widest row fits. A last column
 * of free text, the WHY, keeps 16 characters and is cut after that.
 * `fixed` measures each column at its cap, for a table printed a row at a
 * time.
 */
function fitting(columns: readonly Column[], rows: readonly AppRequestRecord[], width: number, fixed: boolean): Column[] {
  let shown = [...columns];
  const measure = (column: Column) => {
    const last = column === shown.at(-1);
    if (last && column.cap === Number.POSITIVE_INFINITY) return 16;
    if (fixed) return Math.max(column.header.length, column.cap);
    return Math.max(column.header.length, ...rows.map((row) => Math.min(visibleLength(column.cell(row)), column.cap)));
  };
  const total = () => shown.reduce((sum, column) => sum + measure(column), 0) + 2 * (shown.length - 1);
  for (const header of ['SENDS', 'APP', 'ABOUT']) {
    if (total() <= width) break;
    shown = shown.filter((column) => column.header !== header);
  }
  return shown;
}

/** `cells` padded to each column's cap, for `--follow`, which prints one row at a time. */
function padded(cells: readonly string[], columns: readonly Column[]): string {
  return cells.map((cell, at) => (at === cells.length - 1 ? cell : `${cell}${' '.repeat(Math.max(Math.max(columns[at]!.cap, columns[at]!.header.length) - visibleLength(cell), 0))}`)).join('  ');
}

/** `text` cut to `cap` visible characters with a `…`. Styled text that fits is kept as it is. */
function cut(text: string, cap: number): string {
  if (visibleLength(text) <= cap) return text;
  const plain = [...text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '')];
  return `${plain.slice(0, cap - 1).join('')}…`;
}

/** A request's state: its mark, its word, and the color it takes in a terminal. */
function stateOf(out: Style, row: AppRequestRecord): [string, string, (text: string) => string] {
  switch (row.status) {
    case 'needs_attention':
      return ['●', 'needs attention', (text) => out.amber(text)];
    case 'answered':
    case 'applied':
      return ['✓', row.status, (text) => out.green(text)];
    case 'dropped':
      return ['○', 'dropped', (text) => out.dim(text)];
    case 'delivered':
      return row.mode === 'tell' ? ['✓', 'delivered', (text) => out.green(text)] : ['●', 'waiting', (text) => out.cyan(text)];
    case 'pending':
    case 'sent':
      return ['●', row.mode === 'tell' ? 'sending' : 'waiting', (text) => out.cyan(text)];
    default:
      return ['●', clean(String(row.status)), (text) => text];
  }
}

/** A request's state in a word, with a mark and a color in a terminal. */
function stateCell(out: Style, row: AppRequestRecord): string {
  const [mark, word, paint] = stateOf(out, row);
  return out.rich ? paint(`${mark} ${word}`) : word;
}

/** `2026-11-17T09:14:03+00:00` as `Nov 17 09:14` in the person's time zone, or the text itself when it is not a time. */
function when(iso: string, zone: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone || undefined });
  } catch {
    format = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * `siren apps requests <id> --json`: Siren's whole request, with the keys
 * of its app and feature, which Siren's detail names only by id, and the
 * sends found for it among the app's latest deliveries. The SDKs' replay
 * helpers read this saved request. The keys are null and the sends empty
 * when the app is gone.
 */
async function printRequestJson(run: ReturnType<typeof contextOf>, request: AppRequestDetail): Promise<number> {
  const siren = run.siren();
  const app = (await siren.apps.list()).find((candidate) => candidate.id === request.appId);
  const feature = app?.features.find((item) => item.ref === request.feature);
  const sends =
    app === undefined || app.address === null
      ? []
      : (await siren.apps.deliveries(app.key)).filter((delivery) => delivery.eventId.startsWith(`${request.id}.`)).sort((a, b) => sendNumber(a.eventId) - sendNumber(b.eventId));
  run.print(JSON.stringify({ ...request, appKey: app?.key ?? null, featureKey: feature?.key ?? null, sends }, null, 2));
  return 0;
}

/**
 * `siren apps requests <id>`: reads the request with
 * `GET /apps/requests/{id}`, however old, and prints its line, the data
 * Siren sent, and the answer Siren took with who gave it. Then it finds the
 * app's deliveries, `GET /apps/{key}/deliveries`, whose event id is
 * `<id>.<send>` and prints each
 * send with its HTTP status and what the app said back. A request the
 * organization does not have is refused in one line that says where to see
 * the latest.
 */
async function showRequest(input: CommandInput, typed: string): Promise<number> {
  const start = requestIdArgument(typed);
  const run = contextOf(input);
  const session = await run.signedIn();
  const id = await requestIdFor(run, start, clean(session.orgName));
  const siren = run.siren();

  let request: AppRequestDetail;
  try {
    request = await siren.apps.requests.retrieve(id);
  } catch (error) {
    if (error instanceof NotFoundError && appErrorCode(error) === AppErrorCode.RequestNotFound) {
      throw new CliRefusal(`This organization has no request ${id}. See the latest with ${run.command('apps requests')}.`);
    }
    throw error;
  }
  if (input.values.json === true) return printRequestJson(run, request);

  const out = styleFor(input.io, 'stdout', input.values);
  const zone = input.io.env.TZ;
  const app = (await siren.apps.list()).find((candidate) => candidate.id === request.appId);
  const feature = app?.features.find((item) => item.ref === request.feature);
  const [mark, word, paint] = stateOf(out, request);
  const state = request.status === 'needs_attention' && request.lastError ? `${word}: ${clean(request.lastError)}` : word;
  const who =
    request.answeredByUser !== null && request.answeredByUser !== undefined
      ? clean(request.answeredByUser.email)
      : request.answeredBy?.startsWith('app:')
        ? 'the app'
        : clean(request.answeredBy ?? 'no one Siren names');
  const answer =
    request.answer !== null && request.answer !== undefined
      ? clean(JSON.stringify(request.answer))
      : request.mode === 'tell'
        ? 'a tell takes none'
        : `none yet${request.answerBy ? `, due ${when(request.answerBy, zone)}` : ''}`;
  const appCell = app === undefined ? `gone (app ${request.appId})` : clean(app.key);
  const featureCell = feature === undefined ? clean(request.feature) : `${clean(feature.key)} (${clean(request.feature)})`;
  const rows: Array<readonly [string, string]> = [
    ['State', out.rich ? paint(`${mark} ${state}`) : state],
    ['Kind', `${clean(request.mode)} · ${clean(kindLabel(request.kind))}`],
    ['App', `${appCell} · ${featureCell}`],
    ...(request.subject ? [['About', clean(`${request.subject.type} ${request.subject.id}`)] as const] : []),
    ['Created', when(request.createdAt, zone)],
    ['Answer', answer],
    ...(request.answer !== null && request.answer !== undefined ? [['From', `${who}${request.answeredAt ? ` at ${when(request.answeredAt, zone)}` : ''}`] as const] : []),
  ];
  run.print(out.report({ headline: out.dim(request.id), rows, mark: false }).replace(/\n$/, ''));

  run.print('');
  run.print(out.bold('SENDS'));
  if (app === undefined) run.print('Its app is gone, so its sends cannot be shown.');
  else if (app.address === null) run.print('Its app has no address now, so its sends cannot be shown.');
  else {
    const sends = (await siren.apps.deliveries(app.key))
      .filter((delivery) => delivery.eventId.startsWith(`${id}.`))
      .sort((a, b) => sendNumber(a.eventId) - sendNumber(b.eventId));
    if (sends.length === 0) run.print("Siren holds no send of it among the app's latest 50 deliveries.");
    else {
      const width = out.rich ? (input.io.screen?.size?.columns ?? REPORT_WIDTH) : Number.POSITIVE_INFINITY;
      const table = sends.map((send) => [
        String(sendNumber(send.eventId)),
        clean(send.status),
        send.httpStatusCode === null ? '–' : String(send.httpStatusCode),
        clean(send.responseBody || send.errorMessage || ''),
      ]);
      for (const line of out.table(['#', 'STATUS', 'HTTP', 'THE APP SAID'], table, width)) run.print(line);
    }
  }

  run.print('');
  const data = Object.entries(request.data ?? {});
  if (data.length === 0) run.print('Siren sent no data.');
  else {
    run.print(out.bold('DATA'));
    const widest = Math.max(...data.map(([key]) => clean(key).length));
    for (const [key, value] of data) {
      const shown = clean(typeof value === 'string' ? value : JSON.stringify(value));
      run.print(`  ${out.dim(clean(key))}${' '.repeat(widest - clean(key).length + 2)}${shown}`);
    }
  }

  const short = shortId(id);
  const resend = `${out.command(run.command(`apps resend ${short}`))} sends it again.`;
  if (request.status === 'needs_attention') {
    run.print('');
    run.print(out.next(`${out.command(run.command(`apps answer ${short} --body '{"outcome":"…"}'`))} answers it.`));
    run.print(out.next(resend));
  } else if (request.status !== 'answered' && request.status !== 'applied') {
    run.print('');
    run.print(out.next(resend));
  }
  return 0;
}

/**
 * `siren apps answer <id> (--body <json> | --file <path>)`: posts the
 * answer with the signed-in admin's session, once. Refuses an answer it
 * cannot read as a JSON object before sending.
 */
export async function appsAnswer(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const start = requestIdArgument(input.args[0] ?? '');
  const body = typeof values.body === 'string' ? values.body : undefined;
  const file = typeof values.file === 'string' ? values.file : undefined;
  if ((body === undefined) === (file === undefined)) throw new CliUsageError('Give the answer with --body <json> or --file <path>, one of the two.');
  const text = body ?? (await readAnswerFile(resolve(io.cwd, file ?? '')));

  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(`The answer is not JSON: ${(error as Error).message}`);
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new CliUsageError('The answer must be a JSON object, such as {"outcome":"paid","reference":"acme-88"}.');
  }
  const outcome = (answer as Record<string, unknown>).outcome;
  if (typeof outcome !== 'string' || outcome === '') throw new CliUsageError('The answer needs a text outcome, such as {"outcome":"paid"}.');
  if (Buffer.byteLength(JSON.stringify(answer), 'utf8') > MAX_APP_ANSWER_BYTES) {
    throw new CliUsageError(`The answer is longer than ${MAX_APP_ANSWER_BYTES} bytes as JSON, which Siren refuses.`);
  }

  const run = contextOf(input);
  const session = await run.signedIn();
  const id = await requestIdFor(run, start, clean(session.orgName));
  let receipt;
  try {
    receipt = await run.siren().apps.requests.answer(id, answer as AppAnswer);
  } catch (error) {
    throw answerRefusal(run, error);
  }
  const out = styleFor(io, 'stdout', values);
  const short = shortId(id);
  if (receipt.duplicate) {
    run.print(out.success(`Siren already had this answer for ${out.bold(short)}. Nothing changed.`));
    return 0;
  }
  run.print(
    out
      .report({ headline: `Answered ${out.bold(short)}`, rows: [['Answer', JSON.stringify(answer)]], tips: [`${out.command(run.command(`apps requests ${short}`))} shows it.`] })
      .replace(/\n$/, ''),
  );
  return 0;
}

/** `siren apps resend <id>`: sends the request again and prints it as it now stands. */
export async function appsResend(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const start = requestIdArgument(input.args[0] ?? '');
  const session = await run.signedIn();
  const id = await requestIdFor(run, start, clean(session.orgName));
  const siren = run.siren();
  let row: AppRequestRecord;
  try {
    row = await siren.apps.requests.resend(id);
  } catch (error) {
    if (error instanceof ConflictError && appErrorCode(error) === AppErrorCode.NotResendable) throw new CliRefusal(await notResendableLine(run, id, error));
    throw error;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const short = shortId(id);
  run.print(
    out
      .report({
        headline: `Sent ${out.bold(short)} again`,
        rows: [
          ['State', stateCell(out, row)],
          ['Sends', String(row.sendCount)],
        ],
        tips: [`${out.command(run.command(`apps requests ${short}`))} shows each send.`],
      })
      .replace(/\n$/, ''),
  );
  return 0;
}

/**
 * What a resend Siren refused with 409 `app_request_not_resendable` says.
 * An `applied` request has nothing left to send. Any other status means
 * its app is off, so it reads the request and the apps to name the app and
 * the `siren apps on` that turns it on.
 */
async function notResendableLine(run: ReturnType<typeof contextOf>, id: string, error: ConflictError): Promise<string> {
  const data = (typeof error.data === 'object' && error.data !== null ? error.data : {}) as { status?: unknown };
  if (data.status === 'applied') return `Siren sent nothing: ${id} is applied, so its answer already did its work.`;
  const siren = run.siren();
  const app = await siren.apps.requests
    .retrieve(id)
    .then(async (request) => (await siren.apps.list()).find((candidate) => candidate.id === request.appId))
    .catch(() => undefined);
  const key = app?.key ?? '<app key>';
  return (
    `Siren sent nothing: ${app?.key ?? 'its app'} is off, and Siren sends nothing to an app that is off. ` +
    `Turn it on with ${run.command(`apps on ${key}`)}, then run ${run.command(`apps resend ${id}`)}.`
  );
}

/** Every code this SDK knows, so a refusal with any other one prints the code beside Siren's message. */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...Object.values(AppErrorCode), ...Object.values(ErrorCode)]);

/**
 * The refusal `apps answer` prints for an error from the answer route. A
 * person's answer to an ask that does not need attention says where to see
 * the ones that do. A refusal with a code this SDK does not know, such as
 * one a newer Siren sends, prints Siren's message and the code, and exits 1
 * like any other refusal. Anything else passes as it is.
 */
function answerRefusal(run: ReturnType<typeof contextOf>, error: unknown): unknown {
  if (!(error instanceof SirenError) || error.statusCode === undefined) return error;
  const code = appErrorCode(error);
  if (code === AppErrorCode.NotNeedingAttention) {
    return new CliRefusal(`${error.message} See the requests that need attention with ${run.command('apps requests --attention')}.`);
  }
  if (code !== undefined && !KNOWN_CODES.has(code)) return new CliRefusal(`${error.message} Siren's code: ${code}.`);
  return error;
}

/** The send number at the end of a delivery's event id, `<request id>.<n>`. */
function sendNumber(eventId: string): number {
  return Number(eventId.slice(eventId.lastIndexOf('.') + 1)) || 0;
}

/** The answer file's text, or a refusal naming it. */
async function readAnswerFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CliRefusal(`${path} could not be read: ${(error as Error).message}`);
  }
}

/** What `apps requests` prints when it found nothing, naming the requests it looked through. */
function emptyLine(attention: boolean, appKey: string | undefined): string {
  if (attention) return appKey === undefined ? 'No request needs attention.' : `No request of ${appKey} needs attention.`;
  if (appKey === undefined) return 'No requests yet.';
  return `No requests for ${appKey} among the organization's latest 50, and none of its requests needs attention.`;
}
