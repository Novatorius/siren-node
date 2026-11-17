import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppAnswer, AppRequestListParams, AppRequestRecord } from '../../record-types';
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
 * `siren apps requests`: the latest requests, oldest first, one line each,
 * for every app or the one `--app` names, and only those that need
 * attention with `--attention`. `--follow` reads again every 2 seconds and
 * prints each new request or status change once, until Ctrl-C, which ends
 * it with exit code 0. With a request id it shows that one request instead.
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
  await run.signedIn();
  const siren = run.siren();
  const filters: AppRequestListParams = values.attention ? { status: 'needs_attention' } : {};
  const appKey = typeof values.app === 'string' ? values.app : undefined;
  let appId: number | undefined;

  const seen = new Map<string, string>();
  // While following, Ctrl-C aborts the signal and the loop ends with 0.
  const following = () => undefined;
  if (values.follow === true) io.signal?.addEventListener('abort', following);
  try {
    for (;;) {
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
 * `siren apps requests <id>`: finds the request among the latest 50, its
 * app, and the app's webhook deliveries whose event id is `<id>.<send>`, and
 * prints each send with its HTTP status and the app's answer, then the body
 * Siren sent. There is no route for one request, so an older one cannot be
 * shown.
 */
async function showRequest(input: CommandInput, id: string): Promise<number> {
  if (!REQUEST_ID.test(id)) throw new CliUsageError('A request id is apr_ and 32 lowercase hex characters.');
  const run = contextOf(input);
  await run.signedIn();
  const siren = run.siren();

  const row = (await siren.apps.requests.list()).find((request) => request.id === id);
  if (row === undefined) throw new CliRefusal(`${id} is not among the latest 50 requests, and Siren shows no older one.`);
  run.print(requestLine(row));

  const app = (await siren.apps.list()).find((candidate) => candidate.id === row.appId);
  if (app === undefined || app.webhookSubscriptionId === null) {
    run.print('Its app is gone, so its sends cannot be shown.');
    return 0;
  }
  const sends = (await siren.webhooks.subscriptions.deliveries(app.webhookSubscriptionId))
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
  run.print('The body Siren sent:');
  run.print(JSON.stringify(sends[sends.length - 1]?.payload, null, 2));
  return 0;
}

/**
 * `siren apps answer <id> (--body <json> | --file <path>)`: posts the
 * answer with the signed-in admin's session, once. Refuses an answer it
 * cannot read as a JSON object before sending.
 */
export async function appsAnswer(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const id = input.args[0] ?? '';
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

  const run = contextOf(input);
  await run.signedIn();
  const receipt = await run.siren().apps.requests.answer(id, answer as AppAnswer);
  run.print(receipt.duplicate ? 'Siren already had this answer. Nothing changed.' : 'Siren accepted the answer.');
  return 0;
}

/** `siren apps resend <id>`: sends the request again and prints it as it now stands. */
export async function appsResend(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const row = await run.siren().apps.requests.resend(input.args[0] ?? '');
  run.print(requestLine(row));
  return 0;
}

/** One request as a line: its id, status, mode and kind, item, subject, sends, time and last error. */
function requestLine(row: AppRequestRecord): string {
  const subject = row.subject ? `${row.subject.type} ${row.subject.id}` : '';
  const sends = `${row.sendCount} ${row.sendCount === 1 ? 'send' : 'sends'}`;
  return [row.id, row.status, `${row.mode} ${row.kind}`, row.item, subject, sends, row.createdAt, row.lastError ?? '']
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
