import { parseJsonBody } from '../../http';
import { deleteRecord, writeRecord } from '../../resources/record-requests';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { orgScope } from '../org';
import { minute } from '../record-view';
import { clean, styleFor } from '../style';
import { CliRefusal, CliUsageError } from '../targets';
import { sinceOf } from './logs';

/*
 * `siren notes`: read a record's notes, add one, edit one, delete one
 * (review/cli-dx/lean-output.md in the run folder, section 3). Siren's
 * /notes routes on feat/apps: GET /notes reads one sourceType and at most
 * one sourceId, POST /notes takes {sourceType, sourceId, body}, PUT
 * /notes/{id} takes {body, revision?}, and DELETE /notes/{id} leaves a
 * marker in the same feeds. A note changes no program, reward or payout, so
 * the commands take no --live (the command table's liveSafe mark).
 */

/** The types Siren keeps notes on, NoteSourceTypes::FEEDS on feat/apps. */
export const NOTE_TYPES = [
  'collaborator',
  'obligation',
  'conversion',
  'payout',
  'fulfillment',
  'engagement',
  'transaction',
  'program',
  'opportunity',
  'distribution',
  'distributor',
  'org',
  'collaborator_group',
  'program_group',
  'property',
  'customer',
  'coupon',
  'product',
  'application_form',
  'notification',
  'notification_rule',
] as const;

/** How many notes `siren notes` reads unless --limit says. Siren's own default. */
const NOTES_DEFAULT = 20;

/** The note type a resource's command word names, such as `collaborator_group` for `collaborator-groups`, or undefined. */
export function noteTypeOf(resource: string): string | undefined {
  const one = resource.endsWith('ies') ? `${resource.slice(0, -3)}y` : resource.endsWith('s') ? resource.slice(0, -1) : resource;
  const type = one.replace(/-/g, '_');
  return (NOTE_TYPES as readonly string[]).includes(type) ? type : undefined;
}

/**
 * `siren <resource> note <id> …` as `siren notes add <type>:<id> …`, the
 * short form for a note on a record. Any other line is answered as it came.
 */
export function noteShorthand(argv: readonly string[], words: readonly string[]): readonly string[] {
  if (words[1] !== 'note') return argv;
  const type = noteTypeOf(words[0] ?? '');
  if (type === undefined) return argv;
  const out = [...argv];
  const at = out.indexOf(words[0]!);
  const noteAt = out.indexOf('note', at + 1);
  // With no id, such as `collaborators note --help`, it is notes add, which prints its help or names what is missing.
  if (words[2] === undefined) {
    if (at < 0 || noteAt < 0) return argv;
    out[at] = 'notes';
    out[noteAt] = 'add';
    return out;
  }
  const idAt = out.indexOf(words[2], noteAt + 1);
  if (at < 0 || noteAt < 0 || idAt < 0) return argv;
  out[at] = 'notes';
  out[noteAt] = 'add';
  out[idAt] = `${type}:${words[2]}`;
  return out;
}

/** A `type:id` or `type` as Siren's sourceType and sourceId, or a usage error that names the types. */
function sourceOf(given: string, needsId: boolean): { sourceType: string; sourceId?: number } {
  const match = /^([a-z_]+)(?::(\d+))?$/.exec(given.trim());
  if (match === null || !(NOTE_TYPES as readonly string[]).includes(match[1]!)) {
    throw new CliUsageError(`${JSON.stringify(given)} isn't a record Siren keeps notes on. Name one as type:id, such as collaborator:1. The types are ${NOTE_TYPES.join(', ')}.`);
  }
  if (needsId && match[2] === undefined) throw new CliUsageError(`Name the record as ${match[1]}:<id>, such as ${match[1]}:1.`);
  return { sourceType: match[1]!, ...(match[2] === undefined ? {} : { sourceId: Number(match[2]) }) };
}

/** `--since` as Siren's `from`, `2026-11-20 00:00:00` in UTC, as the notes table stores dates. */
function fromOf(value: string, now: number): string {
  return sinceOf(value, now).slice(0, 19).replace('T', ' ');
}

/** `siren notes --on <type:id>`: a record's notes, newest first, one line each. */
export async function notesList(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const on = ([] as unknown[]).concat(values.on ?? []).filter((value): value is string => typeof value === 'string');
  if (on.length === 0) throw new CliUsageError('Name the record with --on, such as --on collaborator:1, or --on program for every program.');
  const sources = on.map((given) => sourceOf(given, false));
  if (sources.length > 1) {
    throw new CliRefusal("Siren reads one record's notes at a time.", {
      why: 'Its notes list takes one record, so the notes on two records at once wait for Siren to filter on several.',
      fix: run.command(`notes --on ${on[0]}`),
      fixWords: 'reads the first',
    });
  }
  let limit = NOTES_DEFAULT;
  if (values.limit !== undefined) {
    if (typeof values.limit !== 'string' || !/^\d+$/.test(values.limit) || Number(values.limit) < 1 || Number(values.limit) > 100) {
      throw new CliUsageError(`--limit takes a whole number from 1 to 100, and got ${JSON.stringify(values.limit)}.`);
    }
    limit = Number(values.limit);
  }
  const query: Record<string, string> = { sourceType: sources[0]!.sourceType, order: 'desc', number: String(limit), fields: 'id,renderedContent,creationSource,dateCreated' };
  if (sources[0]!.sourceId !== undefined) query.sourceId = String(sources[0]!.sourceId);
  if (typeof values.search === 'string' && values.search !== '') query.search = values.search;
  if (typeof values.since === 'string') query.from = fromOf(values.since, io.now());

  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'notes');
  const response = await scope.http.request({ method: 'GET', path: '/notes', query, retriable: true });
  const body = await parseJsonBody(response);
  const items = (Array.isArray(body) ? body : typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : []).filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  if (values.json === true) {
    run.print(JSON.stringify(body, null, 2));
    return 0;
  }
  const out = styleFor(io, 'stdout', values);
  const err = styleFor(io, 'stderr', values);
  const counted = Number(response.headers.get('x-siren-estimated-count') ?? (body as { total?: unknown })?.total ?? items.length);
  const total = Number.isFinite(counted) ? Math.max(counted, items.length) : items.length;
  if (items.length === 0) {
    io.stderr(`${err.rich ? err.dim('No notes match.') : 'No notes match.'}\n`);
    return 0;
  }
  const zone = io.env.TZ;
  const ids = items.map((note) => clean(String(note.id ?? '')));
  const idWidth = Math.max(...ids.map((id) => id.length));
  for (const [at, note] of items.entries()) {
    const when = typeof note.dateCreated === 'string' ? minute(note.dateCreated, zone) : '';
    const line = `${when}  ${out.dim(ids[at]!.padEnd(idWidth))}  ${clean(String(note.renderedContent ?? note.content ?? ''))}`;
    run.print(out.rich ? out.fit(line, 80) : line);
  }
  if (total > items.length) {
    const more = `${items.length} of ${total} notes.${limit < 100 ? ' --limit 100 reads more.' : ''}`;
    io.stderr(`${err.rich ? err.dim(more) : more}\n`);
  }
  return 0;
}

/** The note's text: typed, or read whole from standard input with --stdin. Never both, and never empty. */
async function textOf(input: CommandInput, typed: string | undefined): Promise<string> {
  const fromStdin = input.values.stdin === true;
  if (fromStdin && typed !== undefined) throw new CliUsageError('Give the note as text or with --stdin, not both.');
  const text = (fromStdin ? await input.io.readStdin() : (typed ?? '')).trim();
  if (text === '') throw new CliUsageError(fromStdin ? 'Standard input held no text for the note.' : 'Give the note text, such as "Called about the March payout", or pipe it in with --stdin.');
  return text;
}

/** `siren notes add <type:id> <text>`, and `siren <resource> note <id> <text>`: one note on one record. */
export async function notesAdd(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const source = sourceOf(input.args[0]!, true);
  const body = await textOf(input, input.args[1]);
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'notes add');
  const saved = await writeRecord<{ id?: unknown }>(scope.http, 'POST', '/notes', { ...source, body });
  const on = `${source.sourceType}:${source.sourceId}`;
  if (input.values.json === true) {
    run.print(JSON.stringify(saved, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const err = styleFor(input.io, 'stderr', input.values);
  run.print(out.success(`Noted on ${source.sourceType.replace(/_/g, ' ')} ${source.sourceId}${saved.id === undefined ? '' : ` as note ${clean(String(saved.id))}`}.`));
  const next = `${run.command(`notes --on ${on}`)} lists its notes.`;
  input.io.stderr(`${err.rich ? err.next(next) : next}\n`);
  return 0;
}

/** A note id from the line, a whole number. */
function noteIdOf(given: string): string {
  if (!/^\d+$/.test(given)) throw new CliUsageError(`${JSON.stringify(given)} isn't a note id. Note ids are whole numbers, as siren notes lists them.`);
  return given;
}

/** `siren notes edit <id> <text> [--revision <key>]`: the author's change to their note. */
export async function notesEdit(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const id = noteIdOf(input.args[0]!);
  const body = await textOf(input, input.args[1]);
  const revision = typeof input.values.revision === 'string' && input.values.revision !== '' ? input.values.revision : undefined;
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'notes edit');
  const saved = await writeRecord<Record<string, unknown>>(scope.http, 'PUT', `/notes/${id}`, { body, ...(revision === undefined ? {} : { revision }) });
  if (input.values.json === true) run.print(JSON.stringify(saved, null, 2));
  else run.print(styleFor(input.io, 'stdout', input.values).success(`Changed note ${id}.`));
  return 0;
}

/** `siren notes delete <id>`: asks first in a terminal, needs --yes otherwise. Siren leaves a marker in the feed. */
export async function notesDelete(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const id = noteIdOf(input.args[0]!);
  if (values.yes !== true) {
    const err = styleFor(io, 'stderr', values);
    if (!io.interactive) {
      const yes = run.command(`notes delete ${id} --yes`);
      io.stderr(err.rich ? `${err.warning("Nothing sent: there's no terminal to ask in.")}\n${err.next(`${err.command(yes)} deletes it without asking.`)}\n` : `siren: Nothing was sent. Run ${yes} to delete it without asking.\n`);
      return 1;
    }
    const typed = (await io.prompt(`Delete note ${id}? [y/N] `)).trim().toLowerCase();
    if (typed !== 'y' && typed !== 'yes') {
      io.stderr(err.rich ? `${err.dim('Nothing sent.')}\n` : 'siren: Nothing was sent.\n');
      return 1;
    }
  }
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'notes delete');
  await deleteRecord(scope.http, `/notes/${id}`);
  run.print(styleFor(io, 'stdout', values).success(`Deleted note ${id}. Its feeds keep a line saying so.`));
  return 0;
}
