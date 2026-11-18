import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppErrorCode, ConflictError, ErrorCode, NotFoundError, SirenError, appErrorCode } from '../../errors';
import type { AppAnswer, AppRequestDetail, AppRequestListParams, AppRequestRecord } from '../../record-types';
import { MAX_APP_ANSWER_BYTES } from '../../resources/apps';
import { appKeyArgument } from './apply';
import { kindLabel } from '../app-kinds';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
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

/**
 * The request id a command line names, or `CliUsageError` in the tool's
 * words, so the command answers 2 and sends nothing.
 */
export function requestIdArgument(id: string): string {
  if (!REQUEST_ID.test(id)) throw new CliUsageError(`A request id is apr_ and 32 lowercase hex characters, and ${JSON.stringify(id)} is not one.`);
  return id;
}

/**
 * `siren apps requests`: the latest requests, oldest first, one line each,
 * for every app or the one `--app` names, and only those that need
 * attention with `--attention`. `--follow` reads again every 2 seconds and
 * prints each new request or status change once, until Ctrl-C, which ends
 * it with exit code 0. Before each poll after the first it reads the
 * target's edition again, so a target that changed edition stops the run
 * with exit code 1 before the session is sent there. With a request id it
 * shows that one request instead.
 */
export async function appsRequests(input: CommandInput): Promise<number> {
  const id = input.args[0];
  const { values } = input;
  if (id !== undefined) {
    if (values.app !== undefined || values.attention === true || values.follow === true) {
      throw new CliUsageError('A request id shows that one request, so it takes no --app, --attention or --follow.');
    }
    return showRequest(input, id);
  }

  const run = contextOf(input);
  const { io } = input;
  const appKey = typeof values.app === 'string' ? appKeyArgument(values.app) : undefined;
  await run.signedIn();
  const siren = run.siren();
  const filters: AppRequestListParams = values.attention ? { status: 'needs_attention' } : {};
  let appId: number | undefined;

  const seen = new Map<string, string>();
  // While following, Ctrl-C aborts the signal and the loop ends with 0.
  const following = () => undefined;
  if (values.follow === true) io.signal?.addEventListener('abort', following);
  try {
    for (let poll = 1; ; poll += 1) {
      if (poll > 1) await run.recheckEdition();
      const rows = await siren.apps.requests.list(filters);
      if (appKey !== undefined && appId === undefined) appId = (await siren.apps.retrieve(appKey)).id;
      for (const row of [...rows].reverse()) {
        if (appId !== undefined && row.appId !== appId) continue;
        if (seen.get(row.id) === row.status) continue;
        seen.set(row.id, row.status);
        run.print(requestLine(row));
      }
      if (values.follow !== true) {
        if (seen.size === 0) run.print(values.attention ? 'No request needs attention.' : 'No requests yet.');
        return 0;
      }
      if (io.signal?.aborted) return 0;
      await io.sleep(FOLLOW_EVERY_MS);
      if (io.signal?.aborted) return 0;
    }
  } finally {
    io.signal?.removeEventListener('abort', following);
  }
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
async function showRequest(input: CommandInput, id: string): Promise<number> {
  requestIdArgument(id);
  const run = contextOf(input);
  await run.signedIn();
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
  run.print(requestLine(request));
  run.print('The data Siren sent:');
  run.print(JSON.stringify(request.data, null, 2));
  if (request.answer !== null) {
    const who = request.answeredByUser !== null ? `${request.answeredByUser.email} (user ${request.answeredByUser.id})` : request.answeredBy?.startsWith('app:') ? 'the app' : (request.answeredBy ?? 'no one Siren names');
    run.print(`The answer Siren took, from ${who}${request.answeredAt ? ` at ${request.answeredAt}` : ''}:`);
    run.print(JSON.stringify(request.answer, null, 2));
  } else {
    run.print(request.mode === 'tell' ? 'A tell takes no answer.' : 'No answer yet.');
  }

  const app = (await siren.apps.list()).find((candidate) => candidate.id === request.appId);
  if (app === undefined) {
    run.print('Its app is gone, so its sends cannot be shown.');
    return 0;
  }
  if (app.address === null) {
    run.print('Its app has no address now, so its sends cannot be shown.');
    return 0;
  }
  const sends = (await siren.apps.deliveries(app.key))
    .filter((delivery) => delivery.eventId.startsWith(`${id}.`))
    .sort((a, b) => sendNumber(a.eventId) - sendNumber(b.eventId));
  if (sends.length === 0) {
    run.print('Siren holds no send of it among the app\'s latest 50 deliveries.');
    return 0;
  }
  for (const send of sends) {
    run.print(`Send ${send.eventId}: ${send.status}, ${send.httpStatusCode === null ? 'no HTTP answer' : `HTTP ${send.httpStatusCode}`}${send.errorMessage ? `, ${send.errorMessage}` : ''}`);
    if (send.responseBody !== null && send.responseBody !== '') run.print(`  The app answered: ${send.responseBody}`);
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
  const id = requestIdArgument(input.args[0] ?? '');
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
  await run.signedIn();
  let receipt;
  try {
    receipt = await run.siren().apps.requests.answer(id, answer as AppAnswer);
  } catch (error) {
    throw answerRefusal(run, error);
  }
  run.print(receipt.duplicate ? 'Siren already had this answer. Nothing changed.' : 'Siren accepted the answer.');
  return 0;
}

/** `siren apps resend <id>`: sends the request again and prints it as it now stands. */
export async function appsResend(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const id = requestIdArgument(input.args[0] ?? '');
  await run.signedIn();
  const siren = run.siren();
  let row: AppRequestRecord;
  try {
    row = await siren.apps.requests.resend(id);
  } catch (error) {
    if (error instanceof ConflictError && appErrorCode(error) === AppErrorCode.NotResendable) throw new CliRefusal(await notResendableLine(run, id, error));
    throw error;
  }
  run.print(requestLine(row));
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

/** One request as a line: its id, status, mode and kind with the kind's readable name, item, subject, sends, time and last error. */
function requestLine(row: AppRequestRecord): string {
  const subject = row.subject ? `${row.subject.type} ${row.subject.id}` : '';
  const sends = `${row.sendCount} ${row.sendCount === 1 ? 'send' : 'sends'}`;
  return [row.id, row.status, `${row.mode} ${kindLabel(row.kind)}`, row.item, subject, sends, row.createdAt, row.lastError ?? '']
    .filter((part) => part !== '')
    .join('  ');
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
