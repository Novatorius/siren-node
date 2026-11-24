import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { styleFor } from '../style';
import { TestActivityClient, activityBody, simulationReport } from './trigger-client';

/*
 * `siren simulate`: a sale through the organization's own programs that
 * keeps nothing, through `POST /simulations/sale`. Contract:
 * contract/devtools-trigger.md in the run folder, section 4.
 */

/**
 * Runs a sale through the organization's setup, undoes every write, and
 * prints who would earn what. It changes nothing, so a live organization
 * serves it without `--live`. A simulation sends no app an ask.
 */
export async function simulate(input: CommandInput): Promise<number> {
  const { values, io } = input;
  const body = activityBody(undefined, values);
  const run = contextOf(input);
  await run.signedIn();
  const result = await new TestActivityClient(run).simulate(body);

  if (values.json === true) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout(simulationReport(styleFor(io, 'stdout', {}), result));
  return 0;
}
