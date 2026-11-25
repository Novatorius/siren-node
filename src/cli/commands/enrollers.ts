import type { HttpTransport } from '../../http';
import type { CommandInput } from '../context';
import { day, minute } from '../record-view';
import { clean, styleFor } from '../style';
import { CliUsageError } from '../targets';
import { argInWords, call, columns, fieldRefusal, gated, idsInWords, itemsOf, printNext, readJsonObject, transportFor } from './condition-sets';
import type { Answer, ArgDefinition, Feature } from './condition-sets';

/*
 * `siren enrollers`: the rules that add people to programs, distributors
 * and collaborator groups, or take them out, when something happens to
 * them. On the /enrollers routes of Siren PR 1181, open as this is
 * written. A Siren without those routes, or a plan without enrollers, gets
 * a refusal that says which.
 */

/** The widest line in a terminal. */
const WIDTH = 80;

/** How many log lines `enrollers get` shows. */
const VIEW_LOG = 3;

const ENROLLERS: Feature = { name: 'enrollers', route: '/enrollers' };

/** What an enroller does, as `[label, key, record type]`, in the order a view lists it. */
const PLACES = [
  ['adds to', 'addProgramIds', 'program'],
  ['adds to', 'addDistributorIds', 'distributor'],
  ['adds to', 'addGroupIds', 'collaborator_group'],
  ['takes out of', 'removeProgramIds', 'program'],
  ['takes out of', 'removeDistributorIds', 'distributor'],
  ['takes out of', 'removeGroupIds', 'collaborator_group'],
] as const;

/** An enroller id from the line, a whole number. */
function enrollerIdOf(given: string): string {
  if (!/^\d+$/.test(given)) throw new CliUsageError(`${JSON.stringify(given)} isn't an enroller id. Ids are whole numbers, as siren enrollers list shows them.`);
  return given;
}

/** The triggers by id, or an empty map when Siren can't give them, so an enroller still prints with its trigger's id. */
async function triggersOf(http: HttpTransport): Promise<Map<string, Record<string, unknown>>> {
  try {
    return new Map(itemsOf((await call(http, 'GET', '/enroller-triggers')).body).map((trigger) => [String(trigger.id), trigger]));
  } catch {
    return new Map();
  }
}

/** A trigger's name, or its id when the trigger list lacks it. */
function triggerName(triggers: ReadonlyMap<string, Record<string, unknown>>, id: unknown): string {
  const known = triggers.get(String(id));
  return clean(String(typeof known?.name === 'string' ? known.name : (id ?? '')));
}

/** `--limit` for the log: 1 to 100. */
function logLimitOf(value: string | boolean | undefined, otherwise: number): number {
  if (value === undefined) return otherwise;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new CliUsageError(`--limit takes a whole number from 1 to 100, and got ${JSON.stringify(value)}.`);
  return Number(value);
}

/** A log line: when, who, and Siren's sentence for what happened. */
function logLine(line: Record<string, unknown>, zone: string | undefined): string {
  const when = typeof line.happenedAt === 'string' ? minute(line.happenedAt, zone) : '';
  const who = line.collaboratorId === null || line.collaboratorId === undefined ? 'no one' : `collaborator ${clean(String(line.collaboratorId))}`;
  return `${when}  ${who}  ${clean(String(line.message ?? line.outcome ?? ''))}`.trim();
}

/** `siren enrollers list`: each enroller on one line, with its status and what starts it. */
export async function enrollersList(input: CommandInput): Promise<number> {
  const { run, http } = await transportFor(input, 'enrollers list');
  const query: Record<string, string> = {};
  if (typeof input.values.status === 'string') query.status = input.values.status;
  let answer: Answer;
  try {
    answer = await call(http, 'GET', '/enrollers', { query });
  } catch (error) {
    throw gated(error, ENROLLERS);
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(answer.body, null, 2));
    return 0;
  }
  const enrollers = itemsOf(answer.body);
  if (enrollers.length === 0) {
    input.io.stderr(`${query.status === undefined ? 'This organization has no enrollers.' : `No enroller is ${query.status}.`}\n`);
    return 0;
  }
  const triggers = await triggersOf(http);
  const out = styleFor(input.io, 'stdout', input.values);
  const rows = enrollers.map((enroller) => [clean(String(enroller.id ?? '')), clean(String(enroller.name ?? '')), clean(String(enroller.status ?? '')), `when ${triggerName(triggers, enroller.triggerId)}`]);
  for (const line of columns(rows)) run.print(out.rich ? out.fit(line, WIDTH) : line);
  const total = answer.total ?? enrollers.length;
  if (total > enrollers.length) input.io.stderr(`${enrollers.length} of ${total} enrollers.\n`);
  printNext(input, out, [`enrollers get ${clean(String(enrollers[0]!.id))}`]);
  return 0;
}

/** `siren enrollers get <id>`: what starts it, what it does, and its latest log lines. */
export async function enrollersGet(input: CommandInput): Promise<number> {
  const id = enrollerIdOf(input.args[0]!);
  const { run, http } = await transportFor(input, 'enrollers get');
  let enroller: Record<string, unknown>;
  try {
    enroller = (await call(http, 'GET', `/enrollers/${id}`)).body as Record<string, unknown>;
  } catch (error) {
    throw gated(error, ENROLLERS);
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(enroller, null, 2));
    return 0;
  }
  const triggers = await triggersOf(http);
  let log: Answer | undefined;
  try {
    log = await call(http, 'GET', `/enrollers/${id}/log`, { query: { number: String(VIEW_LOG) } });
  } catch {
    log = undefined;
  }

  const zone = input.io.env.TZ;
  const out = styleFor(input.io, 'stdout', input.values);
  const fit = (text: string) => (out.rich ? out.fit(text, WIDTH) : text);
  const trigger = triggers.get(String(enroller.triggerId));
  const definitions = Array.isArray(trigger?.args) ? (trigger!.args as ArgDefinition[]) : [];
  const rows: Array<[string, string]> = [
    ['status', clean(String(enroller.status ?? ''))],
    ['when', triggerName(triggers, enroller.triggerId)],
  ];
  const args = typeof enroller.triggerArgs === 'object' && enroller.triggerArgs !== null ? (enroller.triggerArgs as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    const definition = definitions.find((arg) => arg.key === key);
    const label = clean((definition?.label ?? key.replace(/_/g, ' ')).toLowerCase());
    if (key === 'answer_tests' && Array.isArray(value)) {
      rows.push([label, value.map((test) => (typeof test === 'object' && test !== null ? [test.question, String(test.comparison ?? '').replace(/_/g, ' '), test.value].map((part) => clean(String(part ?? ''))).join(' ') : clean(String(test)))).join(', ')]);
      continue;
    }
    // A record list keeps its ids alone here, since the label already names the type.
    rows.push([label, Array.isArray(value) && (definition?.type === 'records' || definition?.type === 'ids') ? value.map((item) => clean(String(item))).join(', ') : argInWords(definition, value)]);
  }
  for (const label of ['adds to', 'takes out of'] as const) {
    const places = PLACES.filter(([word, key]) => word === label && Array.isArray(enroller[key]) && (enroller[key] as unknown[]).length > 0).map(([, key, type]) => idsInWords(type, enroller[key] as unknown[]));
    if (places.length > 0) rows.push([label, places.join(', ')]);
  }
  if (enroller.onlyWhileMatching === true) rows.push(['only while matching', 'yes']);
  if (typeof enroller.addForDays === 'number') rows.push(['for', `${enroller.addForDays} days`]);
  if (typeof enroller.needsFix === 'string' && enroller.needsFix !== '') rows.push(['needs fixing', clean(enroller.needsFix)]);
  if (typeof enroller.dateCreated === 'string') rows.push(['created', day(enroller.dateCreated, zone)]);
  const lines = itemsOf(log?.body);
  const total = log?.total ?? lines.length;
  if (log !== undefined && lines.length === 0) rows.push(['log', 'nothing yet']);

  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  const view = [out.bold(fit(`enroller ${clean(String(enroller.id ?? id))}${typeof enroller.name === 'string' ? ` · ${clean(enroller.name)}` : ''}`)), '', ...rows.map(([label, value]) => fit(`  ${out.dim(label.padEnd(labelWidth))}${value}`))];
  if (lines.length > 0) {
    view.push('', `  ${out.bold(`log (${total})`)}`, ...lines.map((line) => fit(`    ${logLine(line, zone)}`)));
    if (total > lines.length) view.push(`    and ${total - lines.length} more`);
  }
  run.print(view.join('\n'));

  const next = [`enrollers log ${id}`];
  const firstProgram = [enroller.addProgramIds, enroller.removeProgramIds].find((ids) => Array.isArray(ids) && ids.length > 0) as unknown[] | undefined;
  if (firstProgram !== undefined) next.push(`programs get ${clean(String(firstProgram[0]))}`);
  if (enroller.triggerId === 'condition_set_entered' || enroller.triggerId === 'condition_set_left') {
    const set = Array.isArray(args.set) ? args.set[0] : undefined;
    if (set !== undefined) next.push(`condition-sets get ${clean(String(set))}`);
  }
  printNext(input, out, next);
  return 0;
}

/** `siren enrollers log <id>`: what the enroller did, newest first. */
export async function enrollersLog(input: CommandInput): Promise<number> {
  const id = enrollerIdOf(input.args[0]!);
  const limit = logLimitOf(input.values.limit, 20);
  const { run, http } = await transportFor(input, 'enrollers log');
  let answer: Answer;
  try {
    answer = await call(http, 'GET', `/enrollers/${id}/log`, { query: { number: String(limit) } });
  } catch (error) {
    throw gated(error, ENROLLERS);
  }
  const lines = itemsOf(answer.body);
  if (input.values.json === true) {
    run.print(JSON.stringify(answer.body, null, 2));
    return 0;
  }
  if (lines.length === 0) {
    input.io.stderr(`Enroller ${id} has done nothing yet.\n`);
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  for (const line of lines) run.print(out.rich ? out.fit(logLine(line, input.io.env.TZ), WIDTH) : logLine(line, input.io.env.TZ));
  const total = answer.total ?? lines.length;
  if (total > lines.length) input.io.stderr(`${lines.length} of ${total} lines.${limit < 100 ? ' --limit 100 reads more.' : ''}\n`);
  return 0;
}

/**
 * `siren enrollers run <id>`: runs the enroller now on everyone who
 * matches. It says what the run would do first, then asks, or takes --yes.
 */
export async function enrollersRun(input: CommandInput): Promise<number> {
  const id = enrollerIdOf(input.args[0]!);
  const { io, values } = input;
  const { run, http } = await transportFor(input, 'enrollers run');
  let estimate: Record<string, unknown>;
  try {
    estimate = (await call(http, 'GET', `/enrollers/${id}/run-now`)).body as Record<string, unknown>;
  } catch (error) {
    throw gated(error, ENROLLERS);
  }
  const err = styleFor(io, 'stderr', values);
  const said = clean(String(estimate.message ?? ''));
  if (said !== '') io.stderr(`${said}\n`);
  if (values.yes !== true) {
    const yes = input.command(`enrollers run ${id} --yes`);
    if (!io.interactive) {
      io.stderr(err.rich ? `${err.warning("Nothing sent: there's no terminal to ask in.")}\n${err.next(`${err.command(yes)} runs it without asking.`)}\n` : `siren: Nothing was sent. Run ${yes} to run it without asking.\n`);
      return 1;
    }
    const typed = (await io.prompt(`Run enroller ${id} now? [y/N] `)).trim().toLowerCase();
    if (typed !== 'y' && typed !== 'yes') {
      io.stderr(err.rich ? `${err.dim('Nothing sent.')}\n` : 'siren: Nothing was sent.\n');
      return 1;
    }
  }
  let started: Record<string, unknown>;
  try {
    started = (await call(http, 'POST', `/enrollers/${id}/run-now`)).body as Record<string, unknown>;
  } catch (error) {
    throw fieldRefusal(gated(error, ENROLLERS), `Siren didn't run enroller ${id}.`, input.command('enrollers run --help'));
  }
  if (values.json === true) {
    run.print(JSON.stringify(started, null, 2));
    return 0;
  }
  const out = styleFor(io, 'stdout', values);
  if (started.jobId === null || started.jobId === undefined) {
    run.print(out.success(`Enroller ${id} will run once Siren has checked its condition set for the first time.`));
    return 0;
  }
  const matching = typeof started.matching === 'number' ? ` on the ${started.matching} ${started.matching === 1 ? 'person' : 'people'} who match now` : '';
  run.print(out.success(`Enroller ${id} is running${matching}, as job ${clean(String(started.jobId))}.`));
  printNext(input, out, [`enrollers log ${id}`]);
  return 0;
}

/** `siren enrollers create <file|->`: a new enroller from JSON, in the fields Siren's enroller routes take. */
export async function enrollersCreate(input: CommandInput): Promise<number> {
  const given = input.args[0]!;
  const enroller = await readJsonObject(input, given, 'an enroller', 'name, triggerId, triggerArgs and the programs, distributors or groups it adds people to');
  const { run, http } = await transportFor(input, 'enrollers create');
  let made: Record<string, unknown>;
  try {
    made = (await call(http, 'POST', '/enrollers', { body: enroller })).body as Record<string, unknown>;
  } catch (error) {
    throw fieldRefusal(gated(error, ENROLLERS), 'Siren refused the new enroller.', input.command('enrollers create --help'));
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(made, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const id = clean(String(made.id ?? ''));
  run.print(out.success(`Made enroller ${id}${typeof made.name === 'string' ? ` · ${clean(made.name)}` : ''}.`));
  printNext(input, out, [`enrollers get ${id}`]);
  return 0;
}
