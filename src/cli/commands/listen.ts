import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ApiError, ConnectionError, SirenError, appErrorCode } from '../../errors';
import { deleteRecord, writeRecord } from '../../resources/record-requests';
import { APP_FILE_NAME, declarationFor, parseAppFile } from '../app-file';
import { contextOf } from '../context';
import { orgScope } from '../org';
import type { CommandContext, CommandInput } from '../context';
import { REPORT_WIDTH, clean, styleFor, visibleLength, wrapWords } from '../style';
import type { Style } from '../style';
import { CliRefusal, CliUsageError } from '../targets';
import { saveSecrets } from './apply';
import { idLabeller, whole } from './requests';
import type { IdLabel } from './requests';
import { assertSandbox } from './trigger-client';

/*
 * `siren listen`: while it runs, Siren sends one app's asks, tells and
 * webhook events to the command line instead of the app's address, and the
 * command line posts each one to a handler on this machine. Contract:
 * contract/devtools-listen.md, section 6.
 *
 * The command polls about once a second, at the pace Siren sets with
 * `nextPollMs`, since a held connection would tie up one of Cloud's few PHP
 * workers. Siren signs each delivery with the app's own secret when the
 * command collects it, so the handler checks it as it checks any request.
 * The command reports the handler's reply as the delivery's result: a 2xx
 * is receipt, and the handler posts an ask's answer to Siren itself.
 */

/** The exit code after Ctrl-C ends the run, as `logs tail` and `apps requests --follow` end. */
const CTRL_C_EXIT = 130;

/** The most deliveries the command holds at once. Each poll asks for at most this many. */
export const MAX_IN_FLIGHT = 4;

/** How long a handler has to answer, as Siren's own sender allows. */
export const FORWARD_TIMEOUT_MS = 8000;

/** How long Siren may stay out of reach before the command gives up. */
const OUT_OF_REACH_MS = 5 * 60 * 1000;

/** The longest wait between tries while Siren is out of reach. */
const MAX_BACKOFF_MS = 5000;

/** How much of a handler's reply a failure line shows. */
const REASON_LENGTH = 60;

/**
 * How many times the command sends one result before it gives up on it.
 * Siren writes a result whole or not at all, so a failed send leaves the
 * claim in place and the same result can go again.
 */
export const REPORT_TRIES = 3;

/** One delivery Siren handed the command, as `POST /listen-sessions/{id}/poll` answers it. */
export interface ListenDelivery {
  deliveryId: number;
  claim: string;
  claimedUntil: string;
  eventType: string;
  eventId: string;
  attempt: number;
  request: { id: string; mode: 'ask' | 'tell'; kind: string; feature: string } | null;
  headers: Record<string, string>;
  body: string;
}

export interface ListenAnswer {
  request: string;
  status: string;
  answeredBy: string | null;
  answeredAt: string | null;
}

interface OpenedSession {
  session: { id: string; app: string; address: string | null; events: string[] | null; forwardTo: string | null; idleTimeoutSeconds: number; nextPollMs: number };
  replaced: boolean;
  signingSecret?: string;
}

/** What the handler did with one delivery. */
interface Forwarded {
  httpStatus: number | null;
  body: string;
  error: string | null;
  durationMs: number;
}

/**
 * The address `--forward-to` names, with `http://` added when it has no
 * scheme, or `CliUsageError` when it is not an http or https address.
 */
export function forwardAddress(given: string): string {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(given) ? given : `http://${given}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliUsageError(`--forward-to takes an address such as localhost:8787/siren, and ${JSON.stringify(given)} is not one.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliUsageError(`--forward-to takes an http or https address, and ${JSON.stringify(given)} is neither.`);
  }
  return url.href;
}

/** True when `url` is http to this machine, the only app url `siren listen` forwards to without `--forward-to`. */
function isLocalHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** A duration as a line shows it: `41ms`, or `8.0s` from a second up. */
function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The local time of day, `19:02:11`. */
function clock(ms: number): string {
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** `ask`, `tell` or `event`. */
function kindOf(delivery: ListenDelivery): 'ask' | 'tell' | 'event' {
  return delivery.request?.mode ?? 'event';
}

/** The feature key, or the event type for a webhook event. */
function labelOf(delivery: ListenDelivery): string {
  return delivery.request?.feature ?? delivery.eventType;
}

/** The request id, or the event id for a webhook event. */
function idOf(delivery: ListenDelivery): string {
  return delivery.request?.id ?? delivery.eventId;
}

/**
 * The id a delivery line shows: a request's short id in a terminal when
 * Siren finds requests by the start of their id (CLI pass 3), the whole
 * id through a pipe, and a webhook event's id as it is.
 */
function idShown(style: Style, delivery: ListenDelivery, label: IdLabel): string {
  return delivery.request !== null && style.rich ? label(delivery.request.id) : idOf(delivery);
}

/** Text from Siren or a handler on one line, with every control character and escape sequence taken out. */
function shown(text: string): string {
  return clean(text.replace(/[\r\n\t]+/g, ' '));
}

/** `text` cut to `width` characters in a terminal, and whole through a pipe. */
function cut(style: Style, text: string, width: number): string {
  return style.rich ? [...text].slice(0, width).join('') : text;
}

/** The answer statuses that mean the ask went wrong. */
const BAD_ANSWERS: ReadonlySet<string> = new Set(['needs_attention', 'dropped']);

/**
 * One delivery's line: time, kind, feature or event type, the handler's
 * status, the time it took and the id cut to 12 characters. In a terminal
 * it starts with a green ✓, or a red ✗ for a failure, and plain it has no
 * symbol. Every value from Siren is cleaned. In a terminal no line passes
 * 80 columns, and through a pipe each value is whole.
 */
export function deliveryLine(style: Style, at: number, delivery: ListenDelivery, result: Forwarded, label: IdLabel = whole): string {
  const ok = result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;
  const status = result.httpStatus === null ? '---' : String(result.httpStatus);
  const rest = `${shown(kindOf(delivery)).padEnd(7)} ${cut(style, shown(labelOf(delivery)), 19).padEnd(19)} ${status.padEnd(4)} ${duration(result.durationMs).padStart(6)}  ${cut(style, shown(idShown(style, delivery, label)), 12)}`;
  return ok ? style.success(`${style.dim(clock(at))}  ${rest}`) : style.failure(`${clock(at)}  ${rest}`);
}

/** The line for an ask's answer the handler posted: time, the feature, Siren's status and the request id. */
export function answerLine(style: Style, at: number, feature: string, answer: Pick<ListenAnswer, 'request' | 'status'>, label: IdLabel = whole): string {
  const status = shown(answer.status);
  const rest = `${'answer'.padEnd(7)} ${cut(style, shown(feature), 19).padEnd(19)} ${cut(style, status, 11).padEnd(11)}  ${cut(style, shown(style.rich ? label(answer.request) : answer.request), 12)}`;
  return BAD_ANSWERS.has(status) ? style.failure(`${clock(at)}  ${rest}`) : style.success(`${style.dim(clock(at))}  ${rest}`);
}

/**
 * Why a delivery failed, for the line under its ✗ line: the transport's
 * error, or the handler's status with its JSON `error` field, or else the
 * first 60 characters of what it said.
 */
export function failureReason(result: Forwarded): string {
  if (result.httpStatus === null) return result.error ?? 'Nothing answered.';
  let said = result.body.trim();
  try {
    const parsed: unknown = JSON.parse(result.body);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') said = (parsed as { error: string }).error;
    else if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: { message?: unknown } }).error?.message === 'string') {
      said = (parsed as { error: { message: string } }).error.message;
    }
  } catch {
    // Not JSON, so the text itself.
  }
  const cut = said.length > REASON_LENGTH ? `${said.slice(0, REASON_LENGTH - 1)}…` : said;
  return `The handler answered ${result.httpStatus}${cut === '' ? '.' : `: ${cut}`}`;
}

/**
 * Posts one delivery to the handler with Siren's headers and the exact body
 * bytes, follows no redirect, and stops waiting after 8 seconds.
 */
export async function forward(url: string, delivery: ListenDelivery, now: () => number): Promise<Forwarded> {
  const started = now();
  const where = new URL(url).host;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const body = await response.text();
    return { httpStatus: response.status, body, error: null, durationMs: Math.max(0, now() - started) };
  } catch (error) {
    const durationMs = Math.max(0, now() - started);
    const name = (error as { name?: string }).name;
    const code = ((error as { cause?: { code?: string } }).cause ?? {}).code;
    const message =
      name === 'TimeoutError' || name === 'AbortError'
        ? `The handler took longer than ${FORWARD_TIMEOUT_MS / 1000} seconds.`
        : code === 'ECONNREFUSED'
          ? `Nothing answered at ${where} (connection refused).`
          : `Nothing answered at ${where} (${code ?? (error as Error).message}).`;
    return { httpStatus: null, body: '', error: message, durationMs };
  }
}

/** The app file in the working folder, read with no url needed, or undefined when there is none or it does not read. */
async function appFileIn(cwd: string, env: Readonly<Record<string, string | undefined>>) {
  const path = join(cwd, APP_FILE_NAME);
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = parseAppFile(text, env, { urlMayBeUnset: true });
  return parsed.file === null ? undefined : { path, ...declarationFor(parsed.file) };
}

/**
 * `siren listen [--forward-to <url>] [--app <key>] [--events <types>] [--json]`.
 *
 * Opens a listen session for the app, then polls. Each delivery Siren hands
 * over goes to `--forward-to` with Siren's own headers, and the command
 * reports the handler's reply to Siren and prints one line. An ask's answer
 * that the handler then posted shows on its own line. Ctrl-C stops taking
 * deliveries, reports the ones in flight, closes the session and answers 0,
 * and Siren sends anything still waiting to the app's address. A session
 * Siren ended for silence, as after a laptop sleeps, is opened again. A
 * session another `siren listen` took over answers 1.
 *
 * An app with no address gets a signing secret when the session opens, and
 * the command writes it to the env file beside the app file without
 * printing it.
 */
export async function listen(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const json = values.json === true;
  const file = await appFileIn(io.cwd, io.env);
  const appKey = typeof values.app === 'string' ? values.app : file?.key;
  if (appKey === undefined || appKey === '') {
    throw new CliUsageError(`Name the app with --app <key>, or run siren listen where ${APP_FILE_NAME} is.`);
  }
  let target: string;
  if (typeof values['forward-to'] === 'string') {
    target = forwardAddress(values['forward-to']);
  } else if (typeof file?.params.url === 'string' && isLocalHttp(file.params.url)) {
    target = file.params.url;
  } else {
    throw new CliUsageError('Say where your handler runs with --forward-to, such as --forward-to localhost:8787/siren.');
  }
  const events =
    typeof values.events === 'string'
      ? values.events
          .split(',')
          .map((type) => type.trim())
          .filter((type) => type !== '')
      : undefined;
  if (events !== undefined && events.length === 0) throw new CliUsageError('--events takes a comma list, such as app.request,sale.created.');

  const run = contextOf(input);
  // The organization comes from --org, SIREN_ORG, "org" in the app file, or the only one.
  if (file !== undefined) run.appFilePath = file.path;
  // Siren's live Cloud refuses a listen session (403 listen_live_refused), so a live target is refused here, before --live is asked for.
  await assertSandbox(run, 'listen');
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'listen');
  // Short request ids when Siren finds requests by their start (CLI pass 3), from one idPrefix call at the first request.
  const labelFor = idLabeller(scope);
  const { http } = scope;
  const emit = (object: Record<string, unknown>) => io.stdout(`${JSON.stringify(object)}\n`);
  const say = (line: string) => {
    if (!json) run.print(line);
  };
  const style = styleFor(io, 'stdout', { json });
  const err = styleFor(io, 'stderr', { json });
  // A warning on standard error: amber in a terminal, `siren: ` and the words when plain.
  const warn = (words: string) => run.warn(err.rich ? err.warning(words) : `siren: ${words}`);

  const open = async (): Promise<OpenedSession> =>
    writeRecord<OpenedSession>(http, 'POST', '/listen-sessions', { app: appKey, ...(events === undefined ? {} : { events }), forwardTo: target });

  let opened = await open();
  const envPath = join(file === undefined ? io.cwd : dirname(file.path), run.envFileName());
  if (opened.signingSecret !== undefined) {
    // In --json, the saved line goes to standard error, so standard output stays JSON.
    const quiet = json ? (Object.assign(Object.create(run) as CommandContext, { print: (line: string) => run.warn(line) }) as CommandContext) : run;
    if (!(await saveSecrets(quiet, appKey, envPath, { signingSecret: opened.signingSecret }, false))) return 1;
    await run.remember(appKey, envPath);
  }
  const address = opened.session.address;
  if (json) {
    emit({ type: 'session', id: opened.session.id, app: appKey, address, forwardTo: target, events: opened.session.events, replaced: opened.replaced });
  } else {
    run.print(headline(style, appKey, scope.orgName, target, opened, basename(envPath)));
  }

  const features = new Map<string, string>();
  let forwarded = 0;
  let answeredOk = 0;
  let pause = opened.session.nextPollMs;
  let outOfReachSince: number | undefined;
  let tries = 0;

  for (;;) {
    if (io.signal?.aborted) break;
    let page: { deliveries: ListenDelivery[]; answers: ListenAnswer[]; nextPollMs: number };
    try {
      page = await writeRecord<typeof page>(http, 'POST', `/listen-sessions/${opened.session.id}/poll`, { max: MAX_IN_FLIGHT });
      outOfReachSince = undefined;
      tries = 0;
    } catch (error) {
      const code = appErrorCode(error);
      if (code === 'listen_session_ended' && endedBecause(error) === 'idle') {
        opened = await open();
        if (json) emit({ type: 'reopened', id: opened.session.id, reason: 'idle' });
        else say(style.warning(`Siren heard nothing for ${opened.session.idleTimeoutSeconds} seconds and ended the session, so a new one is open.`));
        continue;
      }
      if (code === 'listen_session_ended' && endedBecause(error) === 'listen_off') {
        throw new CliRefusal(`Siren ended the listen session for ${appKey}.`, {
          why: "siren listen was turned off on this Siren, so Siren sends this app's requests to its address now.",
          fix: run.command(`apps requests --app ${appKey}`),
          fixWords: 'to see where they went',
          note: 'To listen again, ask whoever runs this Siren to set SIREN_LISTEN_ALLOWED=1, or give the app a url and run siren apps apply.',
        });
      }
      if (code === 'listen_session_replaced' || code === 'listen_session_ended' || code === 'listen_session_not_found') throw error;
      if (!(error instanceof ConnectionError || error instanceof ApiError)) throw error;
      outOfReachSince ??= io.now();
      if (io.now() - outOfReachSince >= OUT_OF_REACH_MS) {
        throw new CliRefusal(`Siren stayed out of reach for ${OUT_OF_REACH_MS / 60000} minutes, so siren listen stopped. Siren sends to the app's address again.`, {
          why: shown((error as Error).message.replace(/^Siren: /, '')),
          fix: run.command(`listen --app ${appKey}`),
          fixWords: 'to start again',
        });
      }
      tries += 1;
      await io.sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** tries));
      continue;
    }

    const results = await Promise.all(page.deliveries.map(async (delivery) => ({ delivery, result: await forward(target, delivery, () => io.now()) })));
    for (const { delivery, result } of results) {
      if (delivery.request !== null) features.set(delivery.request.id, delivery.request.feature);
      forwarded += 1;
      const ok = result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;
      if (ok) answeredOk += 1;
      let nextRetryAt: string | null = null;
      const sent = {
        deliveryId: delivery.deliveryId,
        claim: delivery.claim,
        httpStatus: result.httpStatus,
        body: result.body,
        error: result.error,
        durationMs: result.durationMs,
      };
      for (let attempt = 1; ; attempt += 1) {
        try {
          const reported = await writeRecord<{ delivery: { nextRetryAt: string | null } }>(http, 'POST', `/listen-sessions/${opened.session.id}/results`, sent);
          nextRetryAt = reported.delivery.nextRetryAt;
          break;
        } catch (error) {
          if (appErrorCode(error) === 'listen_claim_lost') {
            warn(`Siren had already counted delivery ${delivery.deliveryId} as failed, because its 30 seconds ran out. It sends it again.`);
            break;
          }
          if (!reportMayGoAgain(error)) throw error;
          if (attempt >= REPORT_TRIES) {
            warn(
              `Siren could not record delivery ${delivery.deliveryId} after ${REPORT_TRIES} tries. ` +
                'When its 30 seconds run out, Siren counts a failed attempt and sends it again.',
            );
            break;
          }
          // Siren kept the claim, so the same result goes again. Ctrl-C waits for it.
          await io.sleep(500 * 2 ** (attempt - 1));
        }
      }
      if (json) {
        emit({
          type: 'delivery',
          at: new Date(io.now()).toISOString(),
          kind: kindOf(delivery),
          feature: delivery.request?.feature ?? null,
          featureKind: delivery.request?.kind ?? null,
          eventType: delivery.eventType,
          request: delivery.request?.id ?? null,
          eventId: delivery.eventId,
          deliveryId: delivery.deliveryId,
          attempt: delivery.attempt,
          httpStatus: result.httpStatus,
          durationMs: result.durationMs,
          ok,
          error: ok ? null : failureReason(result),
          nextRetryAt,
        });
        continue;
      }
      // Through a pipe a line keeps the whole id, so only a terminal line or a failure's resend hint needs the lookup.
      const label = delivery.request !== null && (style.rich || !ok) ? await labelFor(delivery.request.id) : whole;
      say(deliveryLine(style, io.now(), delivery, result, label));
      if (!ok) for (const line of failureLines(style, run, delivery, result, nextRetryAt, io.now(), label)) say(line);
    }
    for (const answer of page.answers) {
      if (json) {
        emit({ type: 'answer', at: answer.answeredAt ?? new Date(io.now()).toISOString(), request: answer.request, status: answer.status });
      } else {
        say(answerLine(style, io.now(), features.get(answer.request) ?? '', answer, style.rich ? await labelFor(answer.request) : whole));
      }
    }
    pause = page.nextPollMs > 0 ? page.nextPollMs : pause;
    if (io.signal?.aborted) break;
    await io.sleep(pause);
  }

  // Ctrl-C: every post in flight has been reported, so the session closes.
  const closed = await deleteRecord<{ closed: boolean; returned: number }>(http, `/listen-sessions/${opened.session.id}`).catch(() => null);
  const returned = closed?.returned ?? 0;
  if (json) {
    emit({ type: 'closed', forwarded, ok: answeredOk, returned });
    return CTRL_C_EXIT;
  }
  const where = address === null ? '' : ` to ${shown(address)}`;
  run.print('');
  io.stdout(
    style.report({
      headline: `Stopped listening for ${style.bold(shown(appKey))}`,
      rows: [
        ['Forwarded', `${forwarded} ${forwarded === 1 ? 'delivery' : 'deliveries'}, ${answeredOk} answered 2xx`],
        ['Returned', `${returned} waiting ${returned === 1 ? 'delivery' : 'deliveries'}${where}`],
      ],
      next: [{ text: style.command(run.command(`apps requests --app ${appKey}`)), aside: 'what Siren did next' }],
      tips: [address === null ? 'The app has no address, so Siren holds nothing for it now.' : `Siren sends new requests to ${shown(address)} now.`],
    }),
  );
  return CTRL_C_EXIT;
}

/**
 * Whether a result Siren did not take may go again: the request never
 * arrived, or Siren failed on its side. A 4xx other than a lost claim is an
 * answer, so it does not.
 */
function reportMayGoAgain(error: unknown): boolean {
  if (error instanceof ConnectionError) return true;
  if (!(error instanceof ApiError)) return false;
  return error.statusCode === undefined || error.statusCode >= 500;
}

/** Why Siren ended a session, from a 410's data: `idle`, `closed` or `listen_off`. */
function endedBecause(error: unknown): string | undefined {
  if (!(error instanceof SirenError)) return undefined;
  const data = error.data;
  return typeof data === 'object' && data !== null ? ((data as { endedBecause?: string }).endedBecause ?? undefined) : undefined;
}

/** The block `siren listen` starts with: a report with the session's rows and how Ctrl-C ends it. */
function headline(style: Style, appKey: string, orgName: string, target: string, opened: OpenedSession, envName: string): string {
  const events = opened.session.events;
  const takes =
    events === null
      ? 'asks, tells and every event its address gets'
      : events.includes('app.request')
        ? `asks, tells${events.length > 1 ? ` and ${events.length - 1} event ${events.length === 2 ? 'type' : 'types'}` : ''}`
        : `${events.length} event ${events.length === 1 ? 'type' : 'types'}`;
  const address = opened.session.address;
  return style.report({
    headline: `Listening for ${style.bold(shown(appKey))} in ${style.bold(shown(orgName))}`,
    rows: [
      ['Forwarding', shown(target)],
      ['Takes', takes],
      ['Signing', `your app's secret, SIREN_SIGNING_SECRET in ${shown(envName)}`],
      ['Session', `${cut(style, shown(opened.session.id), 12)}, ends ${opened.session.idleTimeoutSeconds}s after the CLI stops`],
      ...(opened.replaced ? [['Replaced', 'another siren listen for this app, which stops'] as const] : []),
    ],
    tips: [address === null ? 'Ctrl-C stops. The app has no address, so Siren holds nothing for it then.' : `Ctrl-C stops. Siren then sends to ${shown(address)} again.`],
  });
}

/**
 * The lines under a ✗ line: what went wrong, wrapped to fit, then the
 * command that sends it again, each a › step in a terminal. A command is
 * never cut, so one that would pass 80 columns under the kind moves left.
 */
function failureLines(style: Style, run: CommandContext, delivery: ListenDelivery, result: Forwarded, nextRetryAt: string | null, now: number, label: IdLabel = whole): string[] {
  const pad = ' '.repeat(10);
  const step = (text: string) => {
    const line = `${pad}${style.next(text)}`;
    return visibleLength(line) <= REPORT_WIDTH ? line : `  ${style.next(text)}`;
  };
  // Wrapped to fit a terminal, and one whole line through a pipe.
  const reason = shown(failureReason(result));
  const lines = (style.rich ? wrapWords(reason, REPORT_WIDTH - pad.length) : [reason]).map((line) => `${pad}${line}`);
  if (delivery.request === null) return [...lines, step("The dashboard's webhook deliveries page shows it.")];
  const resend = style.command(run.command(`apps resend ${shown(label(delivery.request.id))}`));
  if (result.httpStatus === null) {
    lines.push(step('Is your server running? Start it, then:'));
  } else if (nextRetryAt !== null) {
    const minutes = Math.max(1, Math.round((Date.parse(nextRetryAt) - now) / 60000));
    lines.push(step(`Siren sends it again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or now:`));
  } else {
    lines.push(step('Siren tried it five times. Send it again with:'));
  }
  return [...lines, step(resend)];
}
