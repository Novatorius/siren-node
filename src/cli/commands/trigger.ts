import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { orNotYet } from '../sandboxes';
import { styleFor } from '../style';
import { SirenError } from '../../errors';
import type { CommandContext } from '../context';
import { clean } from '../style';
import { CliRefusal, CliUsageError } from '../targets';
import { appTells, isApproved } from './trigger-tells';
import { appKeyArgument } from './apply';
import type { ActivityBody, ActivityResult } from './trigger-client';
import { TestActivityClient, activityBody, activityReport, askAndWait, askReport, assertSandbox, confirmLiveAsk, openWaits, requestLabel, triggerAndWait, waitSeconds } from './trigger-client';

/*
 * `siren trigger <sale|refund|visit|event-slug>` and `siren trigger ask
 * <app> <feature>`. Contract: contract/devtools-trigger.md in the run
 * folder, section 4.
 */

/** How long `trigger` waits on an app's answer by default, in seconds. */
export const TRIGGER_WAIT_SECONDS = 30;

/** How long `trigger ask` waits on the answer by default, in seconds. */
export const ASK_WAIT_SECONDS = 60;

/** An event slug: what `POST /event/{slug}` takes. */
const EVENT = /^[a-z0-9][a-z0-9._-]{0,190}$/i;

/** A feature key, as an app file names one: lowercase letters and digits joined by single dashes. */
export function featureKeyArgument(key: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key) || key.length > 64) {
    throw new CliUsageError(`A feature key is lowercase letters and digits joined by single dashes, at most 64 characters, and ${JSON.stringify(key)} is not one.`);
  }
  return key;
}

/**
 * `siren trigger <event>`: makes one sale, refund, visit or custom event in
 * a sandbox organization through Siren's own event ingestion, and prints
 * the conversion, the rewards and who earns them. While a reward waits on
 * an app it reads the sale again every 2 seconds, up to `--wait`. A live
 * target is refused before the session is sent.
 */
export async function trigger(input: CommandInput): Promise<number> {
  const event = input.args[0]!;
  if (!EVENT.test(event)) throw new CliUsageError(`siren trigger takes sale, refund, visit or a custom event's slug, and ${JSON.stringify(event)} is not one.`);
  const { values, io } = input;
  const body = activityBody(event, values);
  const seconds = waitSeconds(values.wait, TRIGGER_WAIT_SECONDS);
  const json = values.json === true;
  const approve = values.approve === true;
  if (approve && event !== 'sale') throw new CliUsageError('--approve takes a sale, since only a sale makes a conversion to approve.');

  const run = contextOf(input);
  await assertSandbox(run, `trigger ${event}`);
  await run.signedIn();
  const client = new TestActivityClient(run);
  let result: ActivityResult;
  try {
    result = await orNotYet(run, 'trigger', () => triggerAndWait(client, io, body, seconds, json));
  } catch (error) {
    throw (await emptyOrgRefusal(input, run, error, body)) ?? error;
  }
  // --approve approves each conversion the sale made, so Siren runs its post-conversion actions and tells the apps (review round 1, C3).
  if (approve) result = await approveAll(client, result);

  if (json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const style = styleFor(io, 'stdout', {});
  const label = await requestLabel(run, openWaits(result)[0]?.requestKey);
  const apps = await appTells(style, input, run, client, result);
  io.stdout(activityReport(style, input, run, result, label, apps));
  return 0;
}

/**
 * The refusals an empty sandbox meets first, each with the one command that
 * clears it (review round 1, C18), or undefined to keep Siren's own words.
 * Siren's message stays the headline.
 */
export async function emptyOrgRefusal(input: Pick<CommandInput, 'command'>, run: CommandContext, error: unknown, body: ActivityBody): Promise<CliRefusal | undefined> {
  if (!(error instanceof SirenError) || error.code === undefined) return undefined;
  const said = clean(error.message.replace(/^Siren: /, ''));
  const program = body.programId ?? Number(/^Program (\d+)/.exec(said)?.[1] ?? NaN);
  if (error.code === 'no_collaborator' && Number.isInteger(program)) {
    // Someone may be active in the org and not in this program. Enrolling them clears it.
    let someone: number | undefined;
    try {
      someone = (await run.siren().collaborators.list({ status: 'active', number: 1 }))[0]?.id as number | undefined;
    } catch {
      someone = undefined;
    }
    if (someone !== undefined) {
      return new CliRefusal(said, { why: `Nobody active is in program ${program}, so the sale has no one to credit. Nothing was made.`, fixLead: 'Enroll someone with', fix: input.command(`collaborator-programs create -d collaboratorId=${someone} -d programId=${program}`), fixWords: 'and run this again' });
    }
  }
  if (error.code === 'no_collaborator') {
    return new CliRefusal(said, { why: 'The sale has no one to credit, so nothing was made.', fixLead: 'Make sample collaborators in every active program with', fix: input.command('seed'), fixWords: 'and run this again' });
  }
  if (error.code === 'collaborator_not_enrolled' && body.collaboratorId !== undefined && Number.isInteger(program)) {
    return new CliRefusal(said, { why: 'Only someone in the program can earn in it. Nothing was made.', fixLead: 'Enroll them with', fix: input.command(`collaborator-programs create -d collaboratorId=${body.collaboratorId} -d programId=${program}`), fixWords: 'and run this again' });
  }
  if (error.code === 'no_sale') {
    return new CliRefusal(said, { why: 'A refund undoes a sale, and there is none to undo. Nothing was made.', fixLead: 'Make one with', fix: input.command('trigger sale'), fixWords: 'first' });
  }
  return undefined;
}

/** Approves each conversion the result left unapproved, then reads the sale again. A failed read keeps the result, with the statuses marked. */
async function approveAll(client: TestActivityClient, result: ActivityResult): Promise<ActivityResult> {
  const waiting = result.conversions.filter((one) => !isApproved(one));
  if (waiting.length === 0) return result;
  for (const conversion of waiting) await client.approve(conversion.id);
  if (result.transactionId !== null) {
    try {
      const read = await client.sale(result.transactionId);
      return { ...read, event: result.event, status: result.status, message: result.message, collaborator: result.collaborator };
    } catch {
      // The approvals stand. The report marks them below.
    }
  }
  return { ...result, conversions: result.conversions.map((one) => (isApproved(one) ? one : { ...one, status: 'approved' })) };
}

/**
 * `siren trigger ask <app> <feature>`: Siren sends the feature its kind's
 * sample request now, marked as a test, and the command waits up to
 * `--wait` for the answer. Siren checks the answer as the kind would, and
 * nothing acts on it. A live organization needs `--live`, refuses a payout
 * method outright, and asks before any other kind unless `--yes`.
 */
export async function triggerAsk(input: CommandInput): Promise<number> {
  const app = appKeyArgument(input.args[0]!);
  const feature = featureKeyArgument(input.args[1]!);
  const { values, io } = input;
  const seconds = waitSeconds(values.wait, ASK_WAIT_SECONDS);
  const json = values.json === true;

  const run = contextOf(input);
  await run.signedIn();
  const client = new TestActivityClient(run);
  await confirmLiveAsk(run, io, client, app, feature, values.yes === true, `trigger ask ${app} ${feature} --live --yes`);
  const request = await orNotYet(run, 'ask', () => askAndWait(client, io, app, feature, seconds, json));

  if (json) io.stdout(`${JSON.stringify({ request }, null, 2)}\n`);
  else io.stdout(askReport(styleFor(io, 'stdout', {}), input, run, app, feature, request, await requestLabel(run, request.id)));
  return 0;
}
