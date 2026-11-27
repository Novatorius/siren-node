import { parseJsonBody } from '../../http';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { LIST_PAGES, OPEN_TYPES, appLink, recordPath, recordTypeOf } from '../links';
import { orgScope } from '../org';
import { clean, styleFor } from '../style';
import { CliUsageError } from '../targets';

/*
 * `siren open <type> <id>`: prints where a record opens in Siren's app, and
 * opens it in the browser when standard output is a terminal. The address
 * comes from the one map in src/cli/links.ts.
 */

/**
 * The record a command line names, as `<type> <id>` or `<type>:<id>`, with
 * the type checked against `types`. `listOnly` names the types that need no
 * id, which open on a list.
 */
export function recordArgs(args: readonly string[], types: readonly string[], command: string, listOnly: readonly string[] = []): { type: string; id?: string } {
  const [first = '', second] = args;
  const colon = /^([^:]+):(.*)$/.exec(first);
  if (colon !== null && second !== undefined) throw new CliUsageError(`Name the record once, as ${colon[1]} ${colon[2]} or ${first}.`);
  const word = colon === null ? first : colon[1]!;
  const id = colon === null ? second : colon[2];
  const type = recordTypeOf(word);
  if (type === undefined || !types.includes(type)) {
    throw new CliUsageError(`${JSON.stringify(word)} isn't a record ${command} takes. It takes ${types.join(', ')}.`);
  }
  if (id === undefined || id === '') {
    if (listOnly.includes(type)) return { type };
    throw new CliUsageError(`Name the ${type.replace(/_/g, ' ')} by its id, such as ${command} ${type} 1.`);
  }
  if (!/^\d+$/.test(id) || Number(id) < 1) throw new CliUsageError(`${JSON.stringify(id)} isn't a record id. Ids are whole numbers, as siren lists them.`);
  return { type, id };
}

/** `siren open <type> <id>`. */
export async function openRecord(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io } = input;
  const { type, id } = recordArgs(input.args, OPEN_TYPES, 'siren open', ['application']);
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'open');
  let fulfillmentId: unknown;
  if (type === 'payout') {
    // A payout has no page of its own. It shows inside its fulfillment, which the payout names.
    const response = await scope.http.request({ method: 'GET', path: `/payouts/${id}`, retriable: true });
    const payout = await parseJsonBody(response);
    fulfillmentId = typeof payout === 'object' && payout !== null ? (payout as { fulfillmentId?: unknown }).fulfillmentId : undefined;
  }
  const path = recordPath(type, id ?? '', { fulfillmentId });
  const url = appLink(run.target.baseUrl, io.env, scope.orgSlug, path);
  run.print(url);
  const err = styleFor(io, 'stderr', input.values);
  const note = (text: string) => io.stderr(`${err.rich ? err.dim(text) : text}\n`);
  if (type === 'application') note("Siren's app has no page for one application, so this is the applications list.");
  if (type === 'payout') note(path === LIST_PAGES.payout ? `Payout ${id} names no fulfillment, so this is the fulfillments list.` : `A payout shows inside its fulfillment, so this is the fulfillment that holds payout ${clean(String(id))}.`);
  if (io.stdoutTty === true && io.openUrl !== undefined) {
    const opened = await io.openUrl(url).catch(() => false);
    note(opened ? 'Opened it in your browser.' : "Couldn't start a browser here, so open the address above.");
  }
  return 0;
}
