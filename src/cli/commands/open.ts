import { parseJsonBody } from '../../http';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { LIST_PAGES, OPEN_TYPES, appLink, recordPath, recordTypeOf } from '../links';
import { orgScope } from '../org';
import { clean, styleFor } from '../style';
import { NotFoundError } from '../../errors';
import { CliRefusal, CliUsageError } from '../targets';

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

/**
 * The read route that says a record exists, by type. Every type `siren
 * open` takes has one, so it never prints a page for a record Siren doesn't
 * hold (review round 1, C17).
 */
const READ_PATHS: Readonly<Record<string, string>> = {
  collaborator: '/collaborators/{id}',
  program: '/programs/{id}',
  program_group: '/program-groups/{id}',
  collaborator_group: '/collaborator-groups/{id}',
  distributor: '/distributors/{id}',
  conversion: '/conversions/{id}',
  transaction: '/transactions/{id}',
  obligation: '/obligations/{id}',
  engagement: '/engagements/{id}',
  fulfillment: '/fulfillments/{id}',
  customer: '/customers/{id}',
  condition_set: '/condition-sets/{id}',
  enroller: '/enrollers/{id}',
  payout: '/payouts/{id}',
};

/**
 * `siren open <type> <id> [--browser]`: reads the record, so a record Siren
 * doesn't hold stops with one line and exit 1, then prints its page in
 * Siren's app. It opens the browser only with `--browser`, since a coding
 * agent or a script wants the address, not a window (review round 1).
 */
export async function openRecord(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io } = input;
  const { type, id } = recordArgs(input.args, OPEN_TYPES, 'siren open', ['application']);
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'open');
  let record: unknown;
  const read = id === undefined ? undefined : READ_PATHS[type];
  if (read !== undefined) {
    try {
      record = await parseJsonBody(await scope.http.request({ method: 'GET', path: read.replace('{id}', id!), retriable: true }));
    } catch (error) {
      if (error instanceof NotFoundError) {
        const words = type.replace(/_/g, ' ');
        throw new CliRefusal(`Siren has no ${words} ${id} in ${clean(scope.orgSlug)}.`, {
          why: 'So there is no page to open.',
          fix: input.command(`${resourceOf(type)} list`),
          fixWords: `lists the ${words}s there are`,
        });
      }
      throw error;
    }
  }
  // A payout has no page of its own. It shows inside its fulfillment, which the payout names.
  const fulfillmentId = type === 'payout' && typeof record === 'object' && record !== null ? (record as { fulfillmentId?: unknown }).fulfillmentId : undefined;
  const path = recordPath(type, id ?? '', { fulfillmentId });
  const url = appLink(run.target.baseUrl, io.env, scope.orgSlug, path);
  run.print(url);
  const err = styleFor(io, 'stderr', input.values);
  const note = (text: string) => io.stderr(`${err.rich ? err.dim(text) : text}\n`);
  if (type === 'application') note("Siren's app has no page for one application, so this is the applications list.");
  if (type === 'payout') note(path === LIST_PAGES.payout ? `Payout ${id} names no fulfillment, so this is the fulfillments list.` : `A payout shows inside its fulfillment, so this is the fulfillment that holds payout ${clean(String(id))}.`);
  if (input.values.browser === true) {
    const opened = io.openUrl === undefined ? false : await io.openUrl(url).catch(() => false);
    note(opened ? 'Opened it in your browser.' : "Couldn't start a browser here, so open the address above.");
  }
  return 0;
}

/** The resource command that lists a type, such as `program-groups` for `program_group`. */
function resourceOf(type: string): string {
  const word = type.replace(/_/g, '-');
  return word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`;
}
