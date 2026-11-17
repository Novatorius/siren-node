import type { CommandInput } from '../context';
import { CliRefusal } from '../targets';

/*
 * `siren apps requests`, `answer` and `resend`: what Siren sent the
 * organization's apps and what came back. Contract:
 * docs/architecture/apps-cli.md, "The commands".
 */

/** The commands packet cli-requests builds. Each refuses until then. */
export async function notBuilt(_input: CommandInput): Promise<number> {
  throw new CliRefusal('This command is not built yet.');
}
