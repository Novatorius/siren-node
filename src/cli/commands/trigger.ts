import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { styleFor } from '../style';
import { CliUsageError } from '../targets';
import { appKeyArgument } from './apply';
import { TestActivityClient, activityBody, activityReport, askAndWait, askReport, assertSandbox, triggerAndWait, waitSeconds } from './trigger-client';

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
function featureKeyArgument(key: string): string {
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

  const run = contextOf(input);
  await assertSandbox(run, `trigger ${event}`);
  await run.signedIn();
  const result = await triggerAndWait(new TestActivityClient(run), io, body, seconds, json);

  if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout(activityReport(styleFor(io, 'stdout', {}), input, run, result));
  return 0;
}

/**
 * `siren trigger ask <app> <feature>`: Siren sends the feature its kind's
 * sample request now, marked as a test, and the command waits up to
 * `--wait` for the answer. Siren checks the answer as the kind would, and
 * nothing acts on it. A live organization needs `--live`.
 */
export async function triggerAsk(input: CommandInput): Promise<number> {
  const app = appKeyArgument(input.args[0]!);
  const feature = featureKeyArgument(input.args[1]!);
  const { values, io } = input;
  const seconds = waitSeconds(values.wait, ASK_WAIT_SECONDS);
  const json = values.json === true;

  const run = contextOf(input);
  await run.signedIn();
  const request = await askAndWait(new TestActivityClient(run), io, app, feature, seconds, json);

  if (json) io.stdout(`${JSON.stringify({ request }, null, 2)}\n`);
  else io.stdout(askReport(styleFor(io, 'stdout', {}), input, run, app, feature, request));
  return 0;
}
