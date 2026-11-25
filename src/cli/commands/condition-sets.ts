import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { NotFoundError, PermissionError, ValidationError } from '../../errors';
import { parseJsonBody } from '../../http';
import type { HttpTransport } from '../../http';
import { contextOf } from '../context';
import type { CommandContext, CommandInput } from '../context';
import { orgScope } from '../org';
import { day } from '../record-view';
import { clean, styleFor } from '../style';
import type { Style } from '../style';
import { CliRefusal, CliUsageError } from '../targets';

/*
 * `siren condition-sets`: the saved lists of conditions Siren checks each
 * day, such as "joined in the last 30 days", and who matches one now. On
 * Siren's /condition-sets routes, on main since PR 1142, which a plan with
 * the audience-conditions capability serves. Enrollers start from them.
 */

/** The widest line in a terminal. */
const WIDTH = 80;

/** How many matching people `matches` names unless --limit says, and the most Siren's people page gives. */
const MATCH_ROWS = 5;
const MATCH_ROWS_MOST = 25;

/** One answer: Siren's JSON and the estimated count its header carries, when it sends one. */
export interface Answer {
  body: unknown;
  total?: number;
}

/** Sends one request through the organization's transport and reads its JSON. A refusal throws the SDK's error. */
export async function call(http: HttpTransport, method: 'GET' | 'POST', path: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  const response = await http.request({ method, path, ...(options.query === undefined ? {} : { query: options.query }), ...(options.body === undefined ? {} : { body: options.body }), retriable: method === 'GET' });
  const body = await parseJsonBody(response);
  const header = response.headers.get('x-siren-estimated-count');
  const total = header === null ? (typeof body === 'object' && body !== null && typeof (body as { total?: unknown }).total === 'number' ? (body as { total: number }).total : undefined) : Number(header);
  return { body, ...(total === undefined || !Number.isFinite(total) ? {} : { total }) };
}

/** The items of a list answer, a bare array or an envelope with `items`. */
export function itemsOf(body: unknown): Array<Record<string, unknown>> {
  const items = Array.isArray(body) ? body : typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item));
}

/** A feature a Siren may lack: its name in a sentence, and the route that serves it. */
export interface Feature {
  name: string;
  route: string;
}

/**
 * A refusal that says what's missing, in place of Siren's own: a Siren
 * that answers a bare "Not found." for the feature's route lacks the
 * feature, and a plan_required refusal means the plan lacks it. A record
 * that isn't there keeps Siren's own sentence, such as "Enroller not found."
 */
export function gated(error: unknown, feature: Feature): unknown {
  if (error instanceof NotFoundError && /^(?:siren: )?not found\.?$/i.test(error.message.trim())) {
    return new CliRefusal(`This Siren doesn't have ${feature.name} yet.`, {
      why: `It answers no ${feature.route} route, so it is older than the Siren that brings them.`,
      fixText: 'Point the tool at a Siren that has them with --base-url, or ask for this one to be updated.',
    });
  }
  if (error instanceof PermissionError && error.code === 'plan_required') {
    return new CliRefusal(`This organization's plan doesn't include ${feature.name}.`, {
      why: 'Siren checks the plan before it answers.',
      fixText: 'Use an organization whose plan includes them, with --org.',
    });
  }
  return error;
}

const SETS: Feature = { name: 'condition sets', route: '/condition-sets' };

/** The organization's transport, after sign-in, for `words`. */
export async function transportFor(input: CommandInput, words: string): Promise<{ run: CommandContext; http: HttpTransport }> {
  const run = contextOf(input);
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, words);
  return { run, http: scope.http };
}

/** A JSON object from a file, or from standard input when `given` is `-`, with a refusal that says what it should hold. */
export async function readJsonObject(input: CommandInput, given: string, what: string, holds: string): Promise<Record<string, unknown>> {
  const fromStdin = given === '-';
  const shown = fromStdin ? 'Standard input' : basename(given);
  let text: string;
  try {
    text = fromStdin ? await input.io.readStdin() : await readFile(resolve(input.io.cwd, given), 'utf8');
  } catch {
    throw new CliRefusal(`There is no file ${given}.`, { why: `The tool reads ${what} from the file named, or from standard input with -.`, fixText: `Name a file, or pipe ${what} in with -.` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliRefusal(`${shown} isn't JSON.`, { why: `${error instanceof Error ? error.message : 'It does not parse'}.`, fixText: `Give ${what} as one JSON object with ${holds}.` });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliRefusal(`${shown} isn't ${what}.`, { why: `${what[0]!.toUpperCase()}${what.slice(1)} is one JSON object with ${holds}.`, fixText: `Give ${what} as one JSON object with ${holds}.` });
  }
  return parsed as Record<string, unknown>;
}

/**
 * Siren's 422 for a write, with each field it refused on its own row.
 * `problems` is `{field: message}` on condition sets and enrollers.
 */
export function fieldRefusal(error: unknown, headline: string, help: string): unknown {
  if (!(error instanceof ValidationError)) return error;
  const problems = (error.data as { problems?: unknown } | undefined)?.problems;
  const rows = typeof problems === 'object' && problems !== null && !Array.isArray(problems) ? Object.entries(problems).map(([at, message]) => ({ at: clean(at), message: clean(String(message)) })) : [];
  return new CliRefusal(headline, {
    why: rows.length === 0 ? clean(error.message.replace(/^Siren: /, '')) : rows.length === 1 ? '1 field needs fixing.' : `${rows.length} fields need fixing.`,
    ...(rows.length === 0 ? {} : { problems: rows, problemsAs: 'rows' as const }),
    fix: help,
    fixWords: 'says what it takes',
  });
}

/** Lines for Next, printed to standard output in a terminal and to standard error through a pipe. */
export function printNext(input: CommandInput, style: Style, next: readonly string[]): void {
  if (next.length === 0) return;
  const err = styleFor(input.io, 'stderr', input.values);
  if (style.rich) {
    input.io.stdout(`${['', style.bold('Next'), ...next.map((words, at) => `  ${at + 1}  ${style.command(input.command(words))}`)].join('\n')}\n`);
    return;
  }
  input.io.stderr(`${['', err.bold('Next'), ...next.map((words, at) => `  ${at + 1}  ${input.command(words)}`)].join('\n')}\n`);
}

/** Rows padded to one width a column, the last column left whole. */
export function columns(rows: ReadonlyArray<readonly string[]>): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, at) => (widths[at] = Math.max(widths[at] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, at) => (at === row.length - 1 ? cell : cell.padEnd(widths[at]!))).join('  ').trimEnd());
}

/** `programs 4 and 5`, `program 4`: a record type and its ids, in words. */
export function idsInWords(type: string, ids: readonly unknown[]): string {
  const word = type.replace(/_/g, ' ');
  const shown = ids.map((id) => clean(String(id)));
  const list = shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return `${shown.length === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`} ${list}`;
}

/** One argument of a condition or a trigger, as Siren's catalog describes it. */
export interface ArgDefinition {
  key: string;
  type: string;
  label?: string;
  choices?: Array<{ key: string; label: string }>;
  recordType?: string | null;
}

/** One value in words: a choice by its label, record ids by their type, a list joined. */
export function argInWords(definition: ArgDefinition | undefined, value: unknown): string {
  if (definition !== undefined && (definition.type === 'ids' || definition.type === 'records') && Array.isArray(value)) {
    return idsInWords(definition.recordType ?? 'record', value);
  }
  if (definition?.type === 'choice' && typeof value === 'string') {
    const choice = definition.choices?.find((option) => option.key === value);
    if (choice !== undefined) return clean(choice.label.toLowerCase());
  }
  if (Array.isArray(value)) return value.map((item) => argInWords(definition, item)).join(', ');
  if (typeof value === 'object' && value !== null) return Object.values(value).map((item) => clean(String(item))).join(' ');
  return clean(String(value));
}

/** A condition as the catalog's sentence with its values filled in, or its id and values when the catalog lacks it. */
function conditionInWords(condition: Record<string, unknown>, catalog: ReadonlyMap<string, Record<string, unknown>>): string {
  const id = clean(String(condition.id ?? ''));
  const args = typeof condition.args === 'object' && condition.args !== null ? (condition.args as Record<string, unknown>) : {};
  const known = catalog.get(id);
  if (known === undefined || typeof known.summaryTemplate !== 'string') {
    const values = Object.entries(args).map(([key, value]) => `${clean(key)} ${argInWords(undefined, value)}`);
    return values.length === 0 ? id : `${id}  ${values.join(', ')}`;
  }
  const definitions = Array.isArray(known.args) ? (known.args as ArgDefinition[]) : [];
  return clean(known.summaryTemplate.replace(/\{([A-Za-z_]+)\}/g, (whole, key: string) => (args[key] === undefined || args[key] === null ? whole : argInWords(definitions.find((definition) => definition.key === key), args[key]))));
}

/** A set id from the line, a whole number. */
function setIdOf(given: string): string {
  if (!/^\d+$/.test(given)) throw new CliUsageError(`${JSON.stringify(given)} isn't a condition set id. Ids are whole numbers, as siren condition-sets list shows them.`);
  return given;
}

/** `siren condition-sets list`: each set on one line. */
export async function conditionSetsList(input: CommandInput): Promise<number> {
  const { run, http } = await transportFor(input, 'condition-sets list');
  let answer: Answer;
  try {
    answer = await call(http, 'GET', '/condition-sets');
  } catch (error) {
    throw gated(error, SETS);
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(answer.body, null, 2));
    return 0;
  }
  const sets = itemsOf(answer.body);
  const out = styleFor(input.io, 'stdout', input.values);
  if (sets.length === 0) {
    input.io.stderr('This organization has no condition sets.\n');
    return 0;
  }
  const zone = input.io.env.TZ;
  const rows = sets.map((set) => {
    const count = Array.isArray(set.conditions) ? set.conditions.length : 0;
    return [
      clean(String(set.id ?? '')),
      clean(String(set.name ?? '')),
      `${count} ${count === 1 ? 'condition' : 'conditions'}`,
      [typeof set.lastCheckedAt === 'string' ? `checked ${day(set.lastCheckedAt, zone)}` : 'not checked yet', ...(set.archivedAt ? ['archived'] : [])].join('  '),
    ];
  });
  for (const line of columns(rows)) run.print(out.rich ? out.fit(line, WIDTH) : line);
  printNext(input, out, [`condition-sets matches ${clean(String(sets[0]!.id))}`]);
  return 0;
}

/** The condition catalog by id, or an empty map when Siren can't give it, so a set still prints. */
async function catalogOf(http: HttpTransport): Promise<Map<string, Record<string, unknown>>> {
  try {
    return new Map(itemsOf((await call(http, 'GET', '/condition-sets/conditions')).body).map((condition) => [String(condition.id), condition]));
  } catch {
    return new Map();
  }
}

/** `siren condition-sets get <id>`: one set, its conditions in Siren's words, and what uses it. */
export async function conditionSetsGet(input: CommandInput): Promise<number> {
  const id = setIdOf(input.args[0]!);
  const { run, http } = await transportFor(input, 'condition-sets get');
  let set: Record<string, unknown>;
  try {
    set = (await call(http, 'GET', `/condition-sets/${id}`)).body as Record<string, unknown>;
  } catch (error) {
    throw gated(error, SETS);
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(set, null, 2));
    return 0;
  }
  const catalog = await catalogOf(http);
  let usedBy: Array<Record<string, unknown>> = [];
  try {
    const uses = (await call(http, 'GET', `/condition-sets/${id}/uses`)).body as { usedBy?: unknown };
    usedBy = itemsOf(uses.usedBy);
  } catch {
    usedBy = [];
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const zone = input.io.env.TZ;
  const fit = (text: string) => (out.rich ? out.fit(text, WIDTH) : text);
  const conditions = itemsOf(set.conditions);
  const rows: Array<[string, string]> = [
    ['checked', typeof set.lastCheckedAt === 'string' ? day(set.lastCheckedAt, zone) : 'not yet'],
    ...(typeof set.archivedAt === 'string' ? ([['archived', day(set.archivedAt, zone)]] as Array<[string, string]>) : []),
    ...(typeof set.sourceKey === 'string' ? ([['from recipe', clean(set.sourceKey)]] as Array<[string, string]>) : []),
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  const lines = [
    out.bold(fit(`condition set ${clean(String(set.id ?? id))}${typeof set.name === 'string' ? ` · ${clean(set.name)}` : ''}`)),
    '',
    ...rows.map(([label, value]) => fit(`  ${out.dim(label.padEnd(labelWidth))}${value}`)),
    '',
    `  ${out.bold(`conditions (${conditions.length})`)}`,
    ...(conditions.length === 0 ? ['    none'] : conditions.map((condition) => fit(`    ${conditionInWords(condition, catalog)}`))),
  ];
  if (usedBy.length > 0) {
    lines.push('', `  ${out.bold(`used by (${usedBy.length})`)}`, ...columns(usedBy.map((use) => [`${clean(String(use.type ?? ''))} ${clean(String(use.id ?? ''))}`, clean(String(use.name ?? '')), clean(String(use.status ?? (use.enabled === false ? 'off' : '')))])).map((line) => fit(`    ${line}`)));
  }
  run.print(lines.join('\n'));
  const firstEnroller = usedBy.find((use) => use.type === 'enroller');
  printNext(input, out, [`condition-sets matches ${id}`, ...(firstEnroller === undefined ? [] : [`enrollers get ${clean(String(firstEnroller.id))}`])]);
  return 0;
}

/** `--limit` for matches: 1 to 25, 5 unless given. */
function matchLimitOf(value: string | boolean | undefined): number {
  if (value === undefined) return MATCH_ROWS;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MATCH_ROWS_MOST) {
    throw new CliUsageError(`--limit takes a whole number from 1 to ${MATCH_ROWS_MOST}, and got ${JSON.stringify(value)}.`);
  }
  return Number(value);
}

/** `3 people`, `1 person`, `1,000 or more people`. */
function peopleCount(count: number, more: boolean): string {
  const shown = count.toLocaleString('en-US');
  return more ? `${shown} or more people` : `${shown} ${count === 1 ? 'person' : 'people'}`;
}

/**
 * `siren condition-sets matches <id|file|->`: who matches a saved set now,
 * with the count and the first few people, or how many would match
 * conditions not yet saved.
 */
export async function conditionSetsMatches(input: CommandInput): Promise<number> {
  const given = input.args[0]!;
  const limit = matchLimitOf(input.values.limit);
  if (!/^\d+$/.test(given)) {
    const draft = await readJsonObject(input, given, 'a condition set', 'name and conditions');
    if (!Array.isArray(draft.conditions)) throw new CliRefusal(`${given === '-' ? 'Standard input' : basename(given)} has no conditions.`, { why: 'A condition set is one JSON object with name and conditions, a list.', fix: input.command('condition-sets conditions'), fixWords: 'lists the conditions a set can use' });
    const { run, http } = await transportFor(input, 'condition-sets matches');
    let counted: { count?: unknown; more?: unknown };
    try {
      counted = (await call(http, 'POST', '/condition-sets/matches', { body: { conditions: draft.conditions } })).body as typeof counted;
    } catch (error) {
      throw fieldRefusal(gated(error, SETS), "Siren couldn't count these conditions.", input.command('condition-sets conditions'));
    }
    if (input.values.json === true) run.print(JSON.stringify(counted, null, 2));
    else run.print(`${peopleCount(Number(counted.count ?? 0), counted.more === true)} would match these conditions now.`);
    return 0;
  }

  const { run, http } = await transportFor(input, 'condition-sets matches');
  let counted: { count?: unknown; more?: unknown };
  let page: { collaboratorIds?: unknown; nextCursor?: unknown; unjudged?: unknown };
  try {
    counted = (await call(http, 'GET', `/condition-sets/${given}/matches`)).body as typeof counted;
    page = (await call(http, 'GET', `/condition-sets/${given}/people`, { query: { limit: String(limit) } })).body as typeof page;
  } catch (error) {
    throw gated(error, SETS);
  }
  const ids = Array.isArray(page.collaboratorIds) ? page.collaboratorIds.slice(0, limit) : [];
  // Each person is read on its own, since Siren's people page names ids alone. A person that can't be read keeps its id.
  const people: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    try {
      people.push((await call(http, 'GET', `/collaborators/${clean(String(id))}`)).body as Record<string, unknown>);
    } catch {
      people.push({ id });
    }
  }
  const count = Number(counted.count ?? ids.length);
  const more = counted.more === true;
  const unjudged = Number(page.unjudged ?? 0);
  if (input.values.json === true) {
    run.print(JSON.stringify({ count, more, unjudged, collaborators: people }, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const fit = (text: string) => (out.rich ? out.fit(text, WIDTH) : text);
  const lines = [`${peopleCount(count, more)} ${count === 1 && !more ? 'matches' : 'match'} condition set ${given} now.`];
  if (people.length > 0) {
    lines.push('', ...columns(people.map((person) => [clean(String(person.id ?? '')), clean(String(person.fullName ?? person.name ?? '')), clean(String(person.email ?? ''))])).map((line) => fit(`  ${line}`)));
    const rest = count - people.length;
    if (more || rest > 0) {
      const lead = more ? '  and more.' : `  and ${rest.toLocaleString('en-US')} more.`;
      lines.push(limit < MATCH_ROWS_MOST ? `${lead} --limit ${MATCH_ROWS_MOST} lists up to ${MATCH_ROWS_MOST}.` : lead);
    }
  }
  run.print(lines.join('\n'));
  if (unjudged > 0) input.io.stderr(`${unjudged} ${unjudged === 1 ? "person couldn't" : "people couldn't"} be checked yet. Siren checks them on its next pass.\n`);
  return 0;
}

/** `siren condition-sets create <file|->`: a new set from JSON with name and conditions. */
export async function conditionSetsCreate(input: CommandInput): Promise<number> {
  const given = input.args[0]!;
  const set = await readJsonObject(input, given, 'a condition set', 'name and conditions');
  if (typeof set.name !== 'string' || !Array.isArray(set.conditions)) {
    throw new CliRefusal(`${given === '-' ? 'Standard input' : basename(given)} isn't a condition set.`, {
      why: 'A condition set is one JSON object with name and conditions, such as {"name": "Joined this month", "conditions": [{"id": "joined_days", "args": {"comparison": "less_than", "days": 30}}]}.',
      fix: input.command('condition-sets conditions'),
      fixWords: 'lists the conditions and the values each takes',
    });
  }
  const { run, http } = await transportFor(input, 'condition-sets create');
  let made: Record<string, unknown>;
  try {
    made = (await call(http, 'POST', '/condition-sets', { body: { name: set.name, conditions: set.conditions } })).body as Record<string, unknown>;
  } catch (error) {
    throw fieldRefusal(gated(error, SETS), 'Siren refused the new condition set.', input.command('condition-sets conditions'));
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(made, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const id = clean(String(made.id ?? ''));
  run.print(out.success(`Made condition set ${id}${typeof made.name === 'string' ? ` · ${clean(made.name)}` : ''}.`));
  printNext(input, out, [`condition-sets matches ${id}`]);
  return 0;
}

/** `siren condition-sets conditions`: the conditions a set can use, each with its sentence and the values it takes. */
export async function conditionSetsConditions(input: CommandInput): Promise<number> {
  const { run, http } = await transportFor(input, 'condition-sets conditions');
  let answer: Answer;
  try {
    answer = await call(http, 'GET', '/condition-sets/conditions');
  } catch (error) {
    throw gated(error, SETS);
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(answer.body, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const rows = itemsOf(answer.body).map((condition) => {
    const args = (Array.isArray(condition.args) ? (condition.args as ArgDefinition[]) : []).map((arg) => (arg.choices !== undefined && arg.choices.length > 0 ? `${arg.key} (${arg.choices.map((choice) => choice.key).join(', ')})` : arg.key));
    return [clean(String(condition.id ?? '')), clean(String(condition.summaryTemplate ?? condition.name ?? '')), clean(args.join(', '))];
  });
  for (const line of columns(rows)) run.print(line);
  return 0;
}
