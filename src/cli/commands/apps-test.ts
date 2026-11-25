import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { styleFor } from '../style';
import { CliRefusal } from '../targets';
import { appKeyArgument } from './apply';
import { orgLabel } from './trigger-client';

/*
 * `siren apps test <app>`: one signed `webhook.test` delivery to the app's
 * address, through `POST /apps/{key}/test`. Contract:
 * contract/devtools-trigger.md in the run folder, section 4.
 */

/**
 * Sends the app's address one test delivery and prints what it answered.
 * A delivery that did not arrive exits 1 with the status and the error.
 * A live organization needs `--live`.
 */
export async function appsTest(input: CommandInput): Promise<number> {
  const key = appKeyArgument(input.args[0]!);
  const { io, values } = input;
  const run = contextOf(input);
  await run.signedIn();
  const result = await run.siren().apps.test(key);

  if (values.json === true) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.delivered ? 0 : 1;
  }
  if (!result.delivered) {
    throw new CliRefusal(`Siren could not reach ${key} in ${orgLabel(run)}.`, {
      why: `${result.httpStatus === null ? 'No answer' : `HTTP ${result.httpStatus}`}${result.error === null ? '' : `: ${result.error.replace(/\.+$/, '')}`}.`,
      fix: input.command(`apps show ${key}`),
      fixWords: 'to check its address',
    });
  }
  const style = styleFor(io, 'stdout', {});
  io.stdout(
    style.report({
      headline: `Siren reached ${style.bold(key)} in ${orgLabel(run)}`,
      rows: [
        ['Reply', `HTTP ${result.httpStatus ?? ''}`.trim()],
        ['Event', result.eventType],
      ],
      next: [{ text: style.command(input.command(`trigger ask ${key} <feature>`)), aside: "a feature's sample ask" }],
    }),
  );
  return 0;
}
