import { CallbackAccessTokenSource } from '../../auth/callback-access-token-source';
import { createHttpTransport } from '../../client';
import type { HttpTransport } from '../../http';
import type { AppRequestDetail } from '../../record-types';
import type { CommandContext, CommandInput } from '../context';
import type { CliIo } from '../io';
import { clean, styleFor } from '../style';
import type { NextStep, Style } from '../style';
import { CliRefusal, CliUsageError, hostName } from '../targets';
import { idLabelFor, whole } from './requests';
import type { IdLabel } from './requests';

/*
 * What `siren trigger`, `trigger ask`, `fixtures` and `simulate` share: the
 * Siren routes that make test activity, the flags they read, the wait on an
 * app's answer, and the report each prints. Contract:
 * contract/devtools-trigger.md in the run folder, sections 3 and 4.
 */

/** How long the tool waits between reads while an app's answer is open, in milliseconds. */
export const POLL_EVERY_MS = 2000;


/** An amount in minor units, and its currency code or award type. */
export interface Amount {
  value: number;
  units: string | null;
}

export interface ActivityConversion {
  id: number;
  type: string;
  status: string;
  programId: number | null;
  programName: string | null;
  collaboratorId: number | null;
  collaboratorName: string | null;
  obligationId: number | null;
  waitsOn: string | null;
}

export interface ActivityObligation {
  id: number;
  collaboratorId: number | null;
  collaboratorName: string | null;
  programId: number | null;
  value: number;
  units: string | null;
  status: string;
  holdReason: string | null;
}

/** An app request a reward waits on. */
export interface ActivityWait {
  requestKey: string;
  app: string | null;
  appName: string | null;
  feature: string | null;
  featureName: string | null;
  kind: string;
  status: string;
  programId: number | null;
}

/** What POST /test-activity, GET /test-activity/sales/{id} and POST /simulations/sale answer. */
export interface ActivityResult {
  event: string;
  simulated: boolean;
  status: string | null;
  message: string | null;
  opportunityId: number | null;
  transactionId: number | null;
  total: Amount | null;
  collaborator: { id: number; name: string | null } | null;
  conversions: ActivityConversion[];
  obligations: ActivityObligation[];
  waits: ActivityWait[];
}

/** The body POST /test-activity takes. */
export interface ActivityBody {
  event?: string;
  collaboratorId?: number;
  programId?: number;
  amount?: string;
  currency?: string;
  opportunityId?: number;
  transactionId?: number;
  fields?: Record<string, unknown>;
}

/** The statuses of an app request that is done: answered and applied, failed, or dropped. */
const SETTLED = new Set(['applied', 'needs_attention', 'dropped']);

/** True while a request may still change. A tell is done once delivered. */
export function isOpen(status: string, mode: string = 'ask'): boolean {
  return !(SETTLED.has(status) || (mode === 'tell' && status === 'delivered'));
}

/**
 * The test activity routes, through the SDK's transport with the session's
 * token, so a spent token is refreshed once and a refusal is a `SirenError`.
 * Writes are sent once, since each one makes something.
 */
export class TestActivityClient {
  private readonly http: HttpTransport;

  constructor(private readonly run: CommandContext) {
    this.http = createHttpTransport({
      accessToken: new CallbackAccessTokenSource(
        () => run.accessToken(),
        () => run.refresh(),
      ),
      httpClient: run.io.httpClient,
      baseUrl: run.target.baseUrl,
    });
  }

  trigger(body: ActivityBody): Promise<ActivityResult> {
    return this.http.requestData<ActivityResult>({ method: 'POST', path: '/test-activity', body, retriable: false });
  }

  sale(transactionId: number): Promise<ActivityResult> {
    return this.http.requestData<ActivityResult>({ method: 'GET', path: `/test-activity/sales/${transactionId}`, retriable: true });
  }

  simulate(body: ActivityBody): Promise<ActivityResult> {
    return this.http.requestData<ActivityResult>({ method: 'POST', path: '/simulations/sale', body, retriable: false });
  }

  featureTest(app: string, feature: string): Promise<{ test: true; request: AppRequestDetail }> {
    return this.http.requestData({ method: 'POST', path: `/apps/${encodeURIComponent(app)}/features/${encodeURIComponent(feature)}/test`, retriable: false });
  }

  request(id: string): Promise<AppRequestDetail> {
    return this.run.siren().apps.requests.retrieve(id);
  }

  /**
   * The kind of one of an app's features, from `GET /apps/{key}`, or null
   * when the app has no feature with that key. Siren lists them as `items`,
   * and the SDK's App type names the list `features`, so either is read.
   */
  async featureKind(app: string, feature: string): Promise<string | null> {
    const body = await this.http.requestData<Record<string, unknown>>({ method: 'GET', path: `/apps/${encodeURIComponent(app)}`, retriable: true });
    const list = Array.isArray(body.features) ? body.features : Array.isArray(body.items) ? body.items : [];
    const found = (list as Array<Record<string, unknown>>).find((entry) => entry !== null && typeof entry === 'object' && entry.key === feature);
    return typeof found?.kind === 'string' ? found.kind : null;
  }
}

/**
 * A copy of Siren's answer with every string in it cleaned of escape
 * sequences and control characters, for printing. `--json` prints the
 * answer as Siren sent it.
 */
export function cleaned<T>(value: T): T {
  if (typeof value === 'string') return clean(value) as T;
  if (Array.isArray(value)) return value.map((one: unknown) => cleaned(one)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, cleaned(one)])) as T;
  return value;
}

/** The kinds Siren never sends a sample to on a live organization, since an app could pay out on one. */
export const LIVE_REFUSED_KINDS: ReadonlySet<string> = new Set(['payoutMethod']);

/**
 * Before a sample ask on a live organization: refuses a payout method
 * outright, and for any other kind prints what the app receives and asks,
 * unless `yes`. With no terminal and no `yes` it refuses, having sent
 * nothing. Does nothing on a sandbox. `again` is the command line that
 * sends it without asking.
 */
export async function confirmLiveAsk(run: CommandContext, io: CliIo, client: TestActivityClient, app: string, feature: string, yes: boolean, again: string): Promise<void> {
  if (run.current().edition !== 'production') return;
  const kind = await client.featureKind(app, feature);
  // A kind the tool can't read could be a payout method, so a live organization gets no sample (review of PR 94).
  if (kind === null) {
    throw new CliRefusal(`Siren didn't say what kind of feature ${app} › ${feature} is, so the tool sends it no sample in ${orgLabel(run)}.`, {
      why: 'A payout method gets no sample on a live organization, and the tool could not rule one out.',
      fix: run.command(`apps show ${app}`),
      fixWords: "to see the app's features",
    });
  }
  if (LIVE_REFUSED_KINDS.has(kind)) {
    throw new CliRefusal(`${app} › ${feature} is a payout method, so Siren sends it no sample in ${orgLabel(run)}.`, {
      why: "An app that doesn't read the request's test flag could pay out on a sample.",
      fix: 'siren login --sandbox',
      fixWords: 'and send it there',
    });
  }
  // On standard error, so `--json` output stays one JSON document.
  io.stderr(`${app} › ${feature} receives a sample request marked test in ${orgLabel(run)}.\n`);
  if (yes) return;
  if (!io.interactive) throw new CliRefusal('Nothing was sent.', { why: 'A sample request needs a yes, and there is no terminal to ask in.', fix: run.command(again), fixWords: 'to send it without asking' });
  const typed = (await io.prompt('Send it? [y/N] ')).trim().toLowerCase();
  if (typed !== 'y' && typed !== 'yes') throw new CliRefusal('Nothing was sent.', { why: "You didn't answer yes.", fix: run.command(again), fixWords: 'to send it without asking' });
}

/** The flags `trigger`, `fixtures` and `simulate` read into a body. */
export interface ActivityFlags {
  collaborator?: unknown;
  program?: unknown;
  amount?: unknown;
  currency?: unknown;
  opportunity?: unknown;
  transaction?: unknown;
  add?: unknown;
}

/** A whole number of 1 or more from a flag, or `CliUsageError`. */
export function wholeNumber(value: unknown, flag: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (!/^[1-9]\d{0,15}$/.test(text)) throw new CliUsageError(`--${flag} takes a whole number, such as 42, and ${JSON.stringify(text)} is not one.`);
  return Number(text);
}

/** The text of a flag, trimmed, or undefined when empty. */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Each `--add key=value` as a field. A value that reads as JSON is sent as
 * that JSON, so `--add quantity=2` sends a number. Anything else is sent as
 * text. `CliUsageError` for one with no `=` or no key.
 */
export function addedFields(values: unknown): Record<string, unknown> {
  const list = values === undefined ? [] : Array.isArray(values) ? values : [values];
  const fields: Record<string, unknown> = {};
  for (const one of list) {
    const raw = String(one);
    const at = raw.indexOf('=');
    if (at <= 0) throw new CliUsageError(`--add takes key=value, such as --add source=shopify, and ${JSON.stringify(raw)} is not one.`);
    const value = raw.slice(at + 1);
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    fields[raw.slice(0, at)] = parsed;
  }
  return fields;
}

/** The body for these flags, with only what was given. `fields` may be an object, from a fixture. */
export function activityBody(event: string | undefined, flags: ActivityFlags): ActivityBody {
  const fields = flags.add !== undefined && typeof flags.add === 'object' && !Array.isArray(flags.add) ? { ...(flags.add as Record<string, unknown>) } : addedFields(flags.add);
  const body: ActivityBody = {};
  if (event !== undefined) body.event = event;
  const set = <K extends keyof ActivityBody>(key: K, value: ActivityBody[K] | undefined) => {
    if (value !== undefined) body[key] = value;
  };
  set('collaboratorId', wholeNumber(flags.collaborator, 'collaborator'));
  set('programId', wholeNumber(flags.program, 'program'));
  set('amount', text(flags.amount));
  set('currency', text(flags.currency));
  set('opportunityId', wholeNumber(flags.opportunity, 'opportunity'));
  set('transactionId', wholeNumber(flags.transaction, 'transaction'));
  if (Object.keys(fields).length > 0) body.fields = fields;
  return body;
}

/** Seconds from `--wait`, or the default. */
export function waitSeconds(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value);
  if (!/^\d{1,4}$/.test(raw)) throw new CliUsageError(`--wait takes a number of seconds, such as 30, and ${JSON.stringify(raw)} is not one.`);
  return Number(raw);
}

/**
 * Refuses a live target before the session is sent anywhere, for the
 * commands that make real activity. It reads only the target's edition,
 * which sends no credential.
 */
export async function assertSandbox(run: CommandContext, words: string): Promise<void> {
  if ((await run.targetEdition()) !== 'production') return;
  throw new CliRefusal(`siren ${words} runs on a sandbox only.`, {
    why: `${hostName(run.target.baseUrl)} is a live Siren, and test activity there would be real sales.`,
    fix: 'siren login --sandbox',
    fixWords: 'and try it there',
  });
}

/** Siren's money, such as "$49.99 USD", or the value and its units for anything that is not a currency. */
export function money(amount: Amount | { value: number; units: string | null } | null): string {
  if (amount === null) return '';
  const units = amount.units ?? '';
  if (/^[A-Z]{3}$/.test(units)) {
    try {
      const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: units });
      const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
      return `${format.format(amount.value / 10 ** digits)} ${units}`;
    } catch {
      // Not a code Intl knows. Print it plain below.
    }
  }
  return `${amount.value}${units === '' ? '' : ` ${units}`}`;
}

/** An app and its feature by name where Siren knows them, such as "Acme CRM › Split the pool". */
export function waitName(wait: ActivityWait): string {
  return `${wait.appName ?? wait.app ?? 'an app'} › ${wait.featureName ?? wait.feature ?? wait.kind}`;
}

/** The waits still open. */
/**
 * How a report prints the request id its hint names: short when Siren finds
 * requests by their start (CLI pass 3), from one idPrefix call, and whole
 * otherwise. No request id costs no call.
 */
export async function requestLabel(run: Pick<CommandContext, 'siren'>, id: string | undefined): Promise<IdLabel> {
  return id === undefined ? whole : idLabelFor(run, id).catch(() => whole);
}

export function openWaits(result: ActivityResult): ActivityWait[] {
  return result.waits.filter((wait) => isOpen(wait.status));
}

/** Rows as the report prints them: it wraps each value under itself, and nothing is cut. */
function fitted(_style: Style, rows: Array<readonly [string, string]>): Array<readonly [string, string]> {
  return rows;
}

/** The name of each program the conversions name, by id. */
function programNames(result: ActivityResult): Map<number, string> {
  const names = new Map<number, string>();
  for (const one of result.conversions) if (one.programId !== null && one.programName !== null) names.set(one.programId, one.programName);
  return names;
}

/**
 * One line per reward: who, how much, its status, and its program when the
 * result names more than one. `label` labels only the first.
 */
function earnRows(result: ActivityResult, label: string | null): Array<readonly [string, string]> {
  const programs = programNames(result);
  const several = new Set(result.obligations.map((one) => one.programId)).size > 1;
  const people = result.obligations.map((one) => one.collaboratorName ?? (one.collaboratorId === null ? 'Someone' : `Collaborator ${one.collaboratorId}`));
  const amounts = result.obligations.map((one) => money(one));
  const nameWidth = Math.max(0, ...people.map((name) => [...name].length));
  const amountWidth = Math.max(0, ...amounts.map((amount) => [...amount].length));
  return result.obligations.map((one, at) => {
    const hold = one.holdReason === null || label === null ? '' : ` (held: ${one.holdReason})`;
    const program = several && one.programId !== null ? ` · ${programs.get(one.programId) ?? `program ${one.programId}`}` : '';
    const rest = `${amounts[at]!.padEnd(amountWidth)}  ${one.status}${hold}${program}`;
    return label === null ? ([people[at]!, rest] as const) : ([at === 0 ? label : '', `${people[at]!.padEnd(nameWidth)}  ${rest}`] as const);
  });
}

/** One line per wait: open ones under Waits, settled ones under Answered. */
function waitRows(result: ActivityResult): Array<readonly [string, string]> {
  const open = result.waits.filter((wait) => isOpen(wait.status));
  const settled = result.waits.filter((wait) => !isOpen(wait.status));
  return [
    ...open.map((wait, at) => [at === 0 ? 'Waits' : '', `${waitName(wait)} · ${wait.status} · ${wait.requestKey}`] as const),
    ...settled.map((wait, at) => [at === 0 ? 'Answered' : '', `${waitName(wait)} · ${wait.status}`] as const),
  ];
}

const EVENT_NAMES: Record<string, string> = { sale: 'Sale', refund: 'Refund', visit: 'Visit' };

/** "Sale", "Refund", "Visit", or "Event signup" for a custom event. */
export function eventName(event: string): string {
  return EVENT_NAMES[event] ?? `Event ${event}`;
}

/** The rows of a result: the sale, who it went to, its conversions, rewards and waits. */
export function activityRows(style: Style, result: ActivityResult): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [];
  if (result.transactionId !== null) rows.push(['Transaction', `${result.transactionId}${result.total === null ? '' : ` · ${money(result.total)}`}`]);
  else if (result.opportunityId !== null) rows.push(['Opportunity', String(result.opportunityId)]);
  if (result.collaborator !== null) rows.push(['Collaborator', `${result.collaborator.name ?? 'Collaborator'} (${result.collaborator.id})`]);
  result.conversions.forEach((one, at) => {
    rows.push([at === 0 ? (result.conversions.length === 1 ? 'Conversion' : 'Conversions') : '', `${one.id} · ${one.type} in ${one.programName ?? `program ${one.programId}`} · ${one.status}`]);
  });
  rows.push(...earnRows(result, 'Earns'), ...waitRows(result));
  if (result.obligations.length === 0 && result.waits.length === 0 && result.event !== 'visit') rows.push(['Earns', 'nothing. No program paid for this.']);
  return fitted(style, rows);
}

/** "Acme (acme), sandbox": the organization the run acts in, as signedIn() settled it, and its edition. */
export function orgLabel(run: CommandContext): string {
  const session = run.current();
  return `${clean(session.orgName)} (${session.orgSlug === undefined ? session.orgId : clean(session.orgSlug)}), ${session.edition === 'production' ? 'live' : 'sandbox'}`;
}

/** What to run after a result: the ask a reward waits on, a refund of a sale, or a sale on a visit. */
export function activityNext(style: Style, input: Pick<CommandInput, 'command'>, raw: ActivityResult, label: IdLabel = whole): NextStep[] {
  const result = cleaned(raw);
  const next: NextStep[] = [];
  const open = openWaits(result);
  if (open.length > 0) next.push({ text: style.command(input.command(`apps requests ${label(open[0]!.requestKey)}`)), aside: 'the ask a reward waits on' });
  if (result.event === 'sale' && result.transactionId !== null) next.push({ text: style.command(input.command(`trigger refund --transaction ${result.transactionId}`)) });
  if (result.event === 'visit' && result.opportunityId !== null) next.push({ text: style.command(input.command(`trigger sale --opportunity ${result.opportunityId}`)) });
  return next;
}

/** The report `siren trigger` prints for a result. Every value from Siren is cleaned first. */
export function activityReport(style: Style, input: CommandInput, run: CommandContext, raw: ActivityResult, label: IdLabel = whole): string {
  const result = cleaned(raw);
  const next = activityNext(style, input, result, label);
  const open = openWaits(result);
  const tips = [
    ...(open.length > 0 ? ['A reward that waits is settled once the app answers.'] : []),
    ...(result.message !== null && result.message !== '' ? [result.message] : []),
  ];
  return style.report({ headline: `${eventName(result.event)} recorded in ${orgLabel(run)}`, rows: activityRows(style, result), next, tips });
}

/** The report `siren simulate` prints on a Siren with only the older sale route: who would earn what, and no ids, since none of them exist. Every value from Siren is cleaned first. */
export function simulationReport(style: Style, run: CommandContext, raw: ActivityResult): string {
  const result = cleaned(raw);
  const programs = [...programNames(result).values()];
  const count = result.obligations.length + result.waits.length;
  const total = result.total === null ? 'A' : `A ${money(result.total)}`;
  const rows = fitted(style, [
    ...(programs.length === 0 ? [] : [['Programs', programs.join(', ')] as const]),
    ...earnRows(result, null),
    ...result.waits.map((wait) => ['Waits', `on ${waitName(wait)}`] as const),
  ]);
  return style.report({
    headline: `${total} sale would earn ${count} ${count === 1 ? 'reward' : 'rewards'} in ${orgLabel(run)}`,
    rows,
    tips: [
      'Nothing was written.',
      ...(result.waits.length > 0 ? ["A simulation sends no ask, so an app's answer can't be shown here."] : []),
      ...(result.message !== null && result.message !== '' && count === 0 ? [result.message] : []),
    ],
  });
}

/** Calls `step` every {@link POLL_EVERY_MS} until it answers true, `seconds` pass, or Ctrl-C. */
export async function pollFor(io: CliIo, seconds: number, step: () => Promise<boolean>): Promise<void> {
  const reads = Math.ceil((seconds * 1000) / POLL_EVERY_MS);
  for (let read = 0; read < reads; read += 1) {
    if (io.signal?.aborted) return;
    await io.sleep(POLL_EVERY_MS);
    if (io.signal?.aborted) return;
    if (await step()) return;
  }
}

/**
 * Makes one event and, while a reward waits on an app, reads the sale
 * again every 2 seconds for up to `seconds`, with one line on standard
 * error. Answers the last result.
 */
export async function triggerAndWait(client: TestActivityClient, io: CliIo, body: ActivityBody, seconds: number, json: boolean): Promise<ActivityResult> {
  let result = await client.trigger(body);
  const transactionId = result.transactionId;
  if (transactionId === null || seconds <= 0 || openWaits(result).length === 0) return result;
  const first = result;
  const spinner = json ? null : styleFor(io, 'stderr', {}).spinner(`Waiting on ${clean(waitName(openWaits(first)[0]!))}`, (line) => io.stderr(line));
  await pollFor(io, seconds, async () => {
    // A read answers no status or message, so the first answer keeps them.
    result = { ...(await client.sale(transactionId)), event: first.event, status: first.status, message: first.message, collaborator: first.collaborator };
    return openWaits(result).length === 0;
  });
  const still = openWaits(result).length;
  spinner?.stop(still === 0, still === 0 ? 'Every app answered.' : `Still waiting on ${still} ${still === 1 ? 'app' : 'apps'}.`);
  return result;
}

/** Sends a feature its sample ask and waits up to `seconds` for it to settle. Answers the request as read last. */
export async function askAndWait(client: TestActivityClient, io: CliIo, app: string, feature: string, seconds: number, json: boolean): Promise<AppRequestDetail> {
  let request = (await client.featureTest(app, feature)).request;
  if (seconds <= 0 || !isOpen(request.status, request.mode)) return request;
  const spinner = json ? null : styleFor(io, 'stderr', {}).spinner(`Waiting for ${app} to answer`, (line) => io.stderr(line));
  await pollFor(io, seconds, async () => {
    request = await client.request(request.id);
    return !isOpen(request.status, request.mode);
  });
  const open = isOpen(request.status, request.mode);
  spinner?.stop(!open || request.mode === 'tell', open ? 'No answer yet.' : `The request is ${clean(request.status)}.`);
  return request;
}

/** The report `siren trigger ask` prints for a test request. Every value from Siren is cleaned first. */
export function askReport(style: Style, input: CommandInput, run: CommandContext, app: string, feature: string, raw: AppRequestDetail, label: IdLabel = whole): string {
  const request = cleaned(raw);
  const tell = request.mode === 'tell';
  const rows: Array<readonly [string, string]> = [
    ['Request', request.id],
    ['Status', request.status],
    ['Sent', `${request.sendCount} ${request.sendCount === 1 ? 'time' : 'times'}`],
  ];
  if (!tell) rows.push(['Answer', request.answer === null ? 'none yet' : JSON.stringify(request.answer)]);
  if (request.lastError !== null) rows.push(['Error', request.lastError]);
  if (!tell && request.answer !== null) rows.push(['Siren', 'took the answer as this kind would. Nothing acted on it.']);
  return style.report({
    headline: `Siren ${tell ? 'told' : 'asked'} ${app} › ${feature} in ${orgLabel(run)} (test)`,
    rows: fitted(style, rows),
    next: [{ text: style.command(input.command(`apps requests ${label(request.id)}`)), aside: 'each send and answer' }],
    tips: tell || request.answer !== null ? [] : [request.sendCount === 0 ? 'Siren queued it, and sends it on its next run.' : 'Your app answers it at the answerUrl the request carries.'],
  });
}
