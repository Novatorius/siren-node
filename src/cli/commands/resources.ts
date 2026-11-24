import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import { CallbackAccessTokenSource } from '../../auth/callback-access-token-source';
import { createHttpTransport } from '../../client';
import { BadRequestError, SirenError } from '../../errors';
import { parseJsonBody } from '../../http';
import type { HttpMethod } from '../../http';
import { contextOf } from '../context';
import type { CommandContext, CommandHandler, CommandInput } from '../context';
import { RESOURCE_COMMANDS } from '../resources.generated';
import type { ResourceCommand, ResourceOp, ResourceRoute } from '../resources.generated';
import { CliRefusal, CliUsageError } from '../targets';
import { block, clip, errorLines, table, WIDTH } from './resource-output';
import type { ErrorParts } from './resource-output';

/*
 * `siren <resource> <op>`, generated from Siren's openapi.json into
 * src/cli/resources.generated.ts, and `siren get|post|put|patch|delete
 * <path>`, which send any route. Contract: contract/devtools-resources.md in
 * the devtools run folder, section 4.
 */

type Options = NonNullable<ParseArgsConfig['options']>;

/** The raw request commands, in the order help lists them. */
export const RAW_VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type RawVerb = (typeof RAW_VERBS)[number];

/** The operations a resource command may have, in the order help lists them. */
export const RESOURCE_OPS: readonly ResourceOp[] = ['list', 'get', 'create', 'update', 'delete'];

/** The options the record commands take. `runCli` adds them to the first, loose read. */
export const OPTIONS: Options = {
  d: { type: 'string', short: 'd', multiple: true },
  data: { type: 'string' },
  json: { type: 'boolean' },
  limit: { type: 'string' },
  offset: { type: 'string' },
  all: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  confirm: { type: 'string' },
};

const FLAG = {
  d: ['-d <key=value>', 'A field, repeatable. A query parameter on a read, a body field on a write. a[b]=1 nests.'],
  data: ['--data <json or @file>', 'A JSON body, or @file.json to read one. -d fields go over it.'],
  json: ['--json', "Print Siren's answer as JSON, and nothing else."],
  limit: ['--limit <n>', 'How many records a page holds, sent as number.'],
  offset: ['--offset <n>', 'How many records to skip, sent as offset.'],
  all: ['--all', 'Read every page of the list.'],
  'dry-run': ['--dry-run', 'Print the request and send nothing.'],
  confirm: ['--confirm <id>', 'The id of the record a live delete removes, when there is no terminal to type it in.'],
} as const satisfies Record<string, readonly [string, string]>;

/** A command line's shape, as `runCli` reads it. The same fields as its own command table. */
export interface ResourceSpec {
  usage: string;
  summary: string;
  group: 'Records';
  options: Options;
  flags: Readonly<Record<string, readonly [string, string]>>;
  example: string;
  positionals: readonly [number, number];
  offline?: boolean;
  readsOnly?: boolean;
  run: CommandHandler;
}

/** The generated resource a name names, or undefined. */
export function resourceNamed(name: string | undefined): ResourceCommand | undefined {
  return RESOURCE_COMMANDS.find((resource) => resource.name === name);
}

/** The options of a route's command, and their help lines. */
function optionsFor(method: HttpMethod, list: boolean): { options: Options; flags: Record<string, readonly [string, string]> } {
  const keys: Array<keyof typeof FLAG> = ['d'];
  if (method !== 'GET' && method !== 'DELETE') keys.push('data');
  if (list) keys.push('limit', 'offset', 'all');
  keys.push('json', 'dry-run');
  if (method === 'DELETE') keys.push('confirm');
  return {
    options: Object.fromEntries(keys.map((key) => [key, OPTIONS[key]!])),
    flags: Object.fromEntries(keys.map((key) => [key, FLAG[key]])),
  };
}

/** Singular, for a one-record headline: program-groups is program-group. */
function singular(name: string): string {
  return name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : name;
}

/**
 * The record command a line's words name, with its name and its line, or
 * undefined when they name none. `siren <resource>` alone and `siren
 * resources` list what there is. A resource with an operation it lacks is a
 * usage error that names the ones it has.
 */
export function commandFor(words: readonly string[]): { name: string; spec: ResourceSpec } | undefined {
  const [first, second] = words;
  if (first === 'resources') {
    return { name: 'resources', spec: { usage: 'resources', summary: 'List the record commands generated from Siren\'s API.', group: 'Records', options: {}, flags: {}, example: 'siren resources', positionals: [0, 0], offline: true, run: listResources } };
  }

  if ((RAW_VERBS as readonly string[]).includes(first ?? '')) {
    const verb = first as RawVerb;
    const method = verb.toUpperCase() as HttpMethod;
    const { options, flags } = optionsFor(method, method === 'GET');
    return {
      name: verb,
      spec: {
        usage: `${verb} <path> ${method === 'GET' ? '[-d key=value] [--limit <n>] [--all]' : method === 'DELETE' ? '[--confirm <id>]' : '[-d key=value] [--data <json or @file>]'} [--json] [--dry-run]`,
        summary: `Send ${method} to any of Siren's routes, such as /programs.`,
        group: 'Records',
        options,
        flags,
        example: method === 'GET' ? 'siren get /programs --limit 5' : method === 'DELETE' ? 'siren delete /programs/12' : `siren ${verb} /programs${method === 'POST' ? '' : '/12'} -d name="Referral program"`,
        positionals: [1, 1],
        readsOnly: method === 'GET',
        run: (input) => sendRaw(input, method),
      },
    };
  }

  const resource = resourceNamed(first);
  if (resource === undefined) return undefined;
  const ops = RESOURCE_OPS.filter((op) => resource.ops[op] !== undefined);
  if (second === undefined) {
    return {
      name: resource.name,
      spec: { usage: `${resource.name} <${ops.join('|')}>`, summary: `Read and change ${resource.name} on Siren.`, group: 'Records', options: {}, flags: {}, example: `siren ${resource.name} ${ops[0]}`, positionals: [0, 0], offline: true, run: (input) => resourceHelp(input, resource) },
    };
  }

  const op = second as ResourceOp;
  const route = resource.ops[op];
  if (route === undefined) {
    throw new CliUsageError(`siren ${resource.name} has no ${second}. It has ${ops.join(', ')}.`);
  }

  const takesId = route.param !== undefined;
  const { options, flags } = optionsFor(route.method, op === 'list' && route.paginated === true);
  const example = `siren ${resource.name} ${op}${takesId ? ' 12' : ''}${op === 'create' || op === 'update' ? ` -d ${route.required?.[0] ?? route.fields?.[0] ?? 'name'}=value` : ''}`;
  return {
    name: `${resource.name} ${op}`,
    spec: {
      usage: `${resource.name} ${op}${takesId ? ' <id>' : ''}${Object.keys(flags).length > 0 ? ' [options]' : ''}`,
      summary: `${route.method} ${route.path}${route.required?.length ? `. Siren requires ${route.required.join(', ')}.` : '.'}`,
      group: 'Records',
      options,
      flags,
      example,
      positionals: takesId ? [1, 1] : [0, 0],
      readsOnly: route.method === 'GET',
      run: (input) => sendResource(input, resource, op, route),
    },
  };
}

/** `siren resources`: every generated resource and its operations. */
async function listResources(input: CommandInput): Promise<number> {
  const width = Math.max(...RESOURCE_COMMANDS.map((resource) => resource.name.length));
  input.io.stdout(
    [
      `✓ ${RESOURCE_COMMANDS.length} resources, generated from Siren's API`,
      ...RESOURCE_COMMANDS.map((resource) => clip(`  ${resource.name.padEnd(width)}  ${RESOURCE_OPS.filter((op) => resource.ops[op]).join(' ')}`, WIDTH)),
      '',
      'Next',
      `  1. siren ${RESOURCE_COMMANDS[0]?.name ?? 'programs'} list`,
      '› siren get <path> reaches any other route.',
      '',
    ].join('\n'),
  );
  return 0;
}

/** `siren <resource>`: its operations, each with the route it sends. */
async function resourceHelp(input: CommandInput, resource: ResourceCommand): Promise<number> {
  const ops = RESOURCE_OPS.filter((op) => resource.ops[op]);
  input.io.stdout(
    [
      `Usage: siren ${resource.name} <${ops.join('|')}>`,
      '',
      ...ops.map((op) => {
        const route = resource.ops[op]!;
        return clip(`  siren ${resource.name} ${op}${route.param ? ' <id>' : ''}`.padEnd(36) + `${route.method} ${route.path}`, WIDTH);
      }),
      '',
      `Run siren help ${resource.name} <op> for its options and an example.`,
      '',
    ].join('\n'),
  );
  return 0;
}

/** What one record command sends. */
interface Outgoing {
  method: HttpMethod;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** The parts of a command line that say what to send and how to print it. */
interface Plan {
  outgoing: Outgoing;
  json: boolean;
  dryRun: boolean;
  all: boolean;
  /** The id a live delete asks to be typed, or undefined for anything but a delete. */
  deleteId?: string;
  /** Names the record command, for the hints a list or an error prints. */
  resource?: ResourceCommand;
  /** The line that ran, for an error's fix: `siren programs get` or `siren get`. */
  line: string;
}

/** `siren get|post|put|patch|delete <path>`. */
async function sendRaw(input: CommandInput, method: HttpMethod): Promise<number> {
  const { path, query } = apiPath(input.args[0]!);
  const outgoing = await outgoingOf(input, method, path, query);
  const last = path.split('/').filter(Boolean).pop();
  return send(input, {
    outgoing,
    json: input.values.json === true,
    dryRun: input.values['dry-run'] === true,
    all: input.values.all === true,
    ...(method === 'DELETE' && last !== undefined ? { deleteId: decodeURIComponent(last) } : {}),
    line: `siren ${method.toLowerCase()} ${path}`,
  });
}

/** `siren <resource> <op> [id]`. */
async function sendResource(input: CommandInput, resource: ResourceCommand, op: ResourceOp, route: ResourceRoute): Promise<number> {
  const id = input.args[0];
  const path = route.param !== undefined && id !== undefined ? route.path.replace(`{${route.param}}`, encodeURIComponent(id)) : route.path;
  const outgoing = await outgoingOf(input, route.method, path, {});
  return send(input, {
    outgoing,
    json: input.values.json === true,
    dryRun: input.values['dry-run'] === true,
    all: input.values.all === true,
    ...(op === 'delete' && id !== undefined ? { deleteId: id } : {}),
    resource,
    line: `siren ${resource.name} ${op}`,
  });
}

/**
 * A path as the tool sends it: after /siren/v1, with a leading slash, and
 * its query string split off. A full address is refused, since the session
 * goes only to the Siren the command targets.
 */
export function apiPath(given: string): { path: string; query: Record<string, string> } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
    throw new CliUsageError(`Give a path such as /programs, not an address. The tool sends it to the Siren you target, with --base-url to choose another.`);
  }
  const [rawPath, search = ''] = given.split('?', 2) as [string, string?];
  let path = `/${rawPath.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  path = path.replace(/^\/siren\/v1(?=\/|$)/, '') || '/';
  return { path, query: Object.fromEntries(new URLSearchParams(search)) };
}

/** A `-d` value as Siren gets it: a JSON number, true, false or null as that, anything else as text. */
export function fieldValue(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && Number.isSafeInteger(Math.trunc(Number(text)))) return Number(text);
  return text;
}

/** `-d` pairs as written, each split at its first `=`. */
function pairs(input: CommandInput): Array<[string, string]> {
  const raw = (input.values as Record<string, unknown>).d;
  const given = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  return given.map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) throw new CliUsageError(`-d takes key=value, and ${JSON.stringify(pair)} has no key or no =.`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
}

/** Sets `a[b][c]` in `target`, making the objects on the way. */
export function setNested(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(/\[|\]\[|\]/).filter((part) => part !== '');
  if (parts.length === 0) throw new CliUsageError(`-d needs a key, and ${JSON.stringify(key)} names none.`);
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/** A whole number of 0 or more from a flag, or `CliUsageError` naming it. */
function count(flag: string, value: unknown, least: number): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^\d+$/.test(text) || Number(text) < least) throw new CliUsageError(`${flag} takes a whole number of ${least} or more, and got ${JSON.stringify(text)}.`);
  return Number(text);
}

/** What a command line sends: the method, path, query and body its flags make. */
async function outgoingOf(input: CommandInput, method: HttpMethod, path: string, query: Record<string, string>): Promise<Outgoing> {
  const fields = pairs(input);
  const limit = count('--limit', input.values.limit, 1);
  const offset = count('--offset', input.values.offset, 0);
  if (method === 'GET' || method === 'DELETE') {
    const outQuery = { ...query };
    for (const [key, value] of fields) outQuery[key] = value;
    if (limit !== undefined) outQuery.number = String(limit);
    if (offset !== undefined) outQuery.offset = String(offset);
    return { method, path, query: outQuery, body: undefined };
  }

  let body: Record<string, unknown> = {};
  const data = input.values.data;
  if (typeof data === 'string') {
    const text = data.startsWith('@') ? await readFile(resolve(input.io.cwd, data.slice(1)), 'utf8').catch(() => {
      throw new CliRefusal(`The tool could not read ${data.slice(1)}. Check the path, which starts from this folder.`);
    }) : data;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliUsageError(`--data must be JSON, such as '{"name":"Referral program"}', or @file.json.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CliUsageError('--data must be a JSON object, with the fields as its keys.');
    body = parsed as Record<string, unknown>;
  }
  for (const [key, value] of fields) setNested(body, key, fieldValue(value));
  return { method, path, query, body };
}

/** The address a request goes to, with its query, as `--dry-run` prints it. */
function urlOf(baseUrl: string, outgoing: Outgoing): string {
  const search = new URLSearchParams(outgoing.query).toString();
  return `${baseUrl}${outgoing.path}${search ? `?${search}` : ''}`;
}

/** Sends one plan, after the live guard, and prints the answer. */
async function send(input: CommandInput, plan: Plan): Promise<number> {
  const run = contextOf(input);
  const { outgoing } = plan;
  if (plan.dryRun) {
    const url = urlOf(run.target.baseUrl, outgoing);
    if (plan.json) {
      run.print(JSON.stringify({ method: outgoing.method, url, ...(outgoing.body !== undefined ? { body: outgoing.body } : {}) }, null, 2));
    } else {
      run.print(`✓ Would send ${outgoing.method} ${url}`);
      if (outgoing.body !== undefined) run.print(`  ${JSON.stringify(outgoing.body)}`);
      run.print('› Nothing was sent.');
    }
    return 0;
  }

  await run.signedIn();
  if (plan.deleteId !== undefined && (await run.targetEdition()) === 'production') await confirmLiveDelete(input, run, plan.deleteId);

  const transport = createHttpTransport({
    accessToken: new CallbackAccessTokenSource(
      () => run.accessToken(),
      () => run.refresh(),
    ),
    httpClient: input.io.httpClient,
    baseUrl: run.target.baseUrl,
  });

  const request = async (query: Record<string, string>) => {
    const response = await transport.request({
      method: outgoing.method,
      path: outgoing.path,
      query,
      ...(outgoing.body !== undefined ? { body: outgoing.body } : {}),
      retriable: outgoing.method === 'GET',
    });
    return { status: response.status, body: await parseJsonBody(response) };
  };

  try {
    let { status, body } = await request(outgoing.query);
    if (plan.all && outgoing.method === 'GET' && isEnvelope(body)) {
      body = await allPages(body, outgoing.query, async (query) => (await request(query)).body);
    }
    print(input, run, plan, status, body);
    return 0;
  } catch (error) {
    if (!(error instanceof SirenError) || error.statusCode === undefined) throw error;
    const parts = errorParts(error, plan, run);
    if (plan.json) input.io.stderr(`${JSON.stringify({ error: { message: error.message, status: error.statusCode, code: error.code ?? null, fix: parts.fix } }, null, 2)}\n`);
    else input.io.stderr(errorLines(parts));
    return 1;
  }
}

/**
 * Asks the person to type the id before a delete on a live organization.
 * With no terminal, `--confirm <id>` must name it. A wrong id sends nothing.
 */
async function confirmLiveDelete(input: CommandInput, run: CommandContext, id: string): Promise<void> {
  const confirm = input.values.confirm;
  if (typeof confirm === 'string') {
    if (confirm !== id) throw new CliRefusal(`--confirm names ${JSON.stringify(confirm)}, and the record is ${JSON.stringify(id)}, so nothing was deleted.`);
    return;
  }
  if (!input.io.interactive) {
    throw new CliRefusal(`Deleting from a live organization needs the record's id typed. There is no terminal to ask in, so pass --confirm ${id}.`);
  }
  const typed = (await input.io.prompt(`This deletes ${id} from ${run.current().orgName}, a live organization. Type ${id} to delete it: `)).trim();
  if (typed !== id) throw new CliRefusal(`You typed ${JSON.stringify(typed)}, not ${JSON.stringify(id)}, so nothing was deleted.`);
}

/** A list in Siren's page envelope: `{items, total, page, perPage, totalPages}`. */
interface Envelope {
  items: unknown[];
  total?: number;
  page?: number;
  perPage?: number;
  totalPages?: number;
}

function isEnvelope(body: unknown): body is Envelope {
  return typeof body === 'object' && body !== null && Array.isArray((body as Envelope).items);
}

/**
 * Every page of a list, read with `offset` one page further each time, until
 * a page comes back short or the envelope's last page is read. Answers the
 * items in one envelope whose `page` is 1 and `totalPages` 1.
 */
async function allPages(first: Envelope, query: Record<string, string>, read: (query: Record<string, string>) => Promise<unknown>): Promise<Envelope> {
  const items = [...first.items];
  const perPage = first.perPage ?? first.items.length;
  let offset = Number(query.offset ?? 0) + first.items.length;
  let page = first.page ?? 1;
  const last = first.totalPages ?? Infinity;
  while (perPage > 0 && items.length < (first.total ?? Infinity) && page < last) {
    const next = await read({ ...query, number: String(perPage), offset: String(offset) });
    if (!isEnvelope(next) || next.items.length === 0) break;
    items.push(...next.items);
    offset += next.items.length;
    page += 1;
    if (next.items.length < perPage) break;
  }
  return { items, total: first.total ?? items.length, page: 1, perPage: items.length, totalPages: 1 };
}

/** Prints Siren's answer: JSON, a table, a record, or one line. */
function print(input: CommandInput, run: CommandContext, plan: Plan, status: number, body: unknown): void {
  if (plan.json) {
    run.print(JSON.stringify(plan.all && isEnvelope(body) ? body.items : (body ?? null), null, 2));
    return;
  }

  const name = plan.resource?.name ?? (plan.outgoing.path.split('/').filter(Boolean)[0] ?? 'records');
  const rows = isEnvelope(body) ? body.items : Array.isArray(body) ? body : undefined;
  if (rows !== undefined) {
    const records = rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row));
    const paging = isEnvelope(body) && body.totalPages !== undefined && body.totalPages > 1 ? `  page ${body.page ?? 1} of ${body.totalPages}` : '';
    run.print(`✓ ${rows.length} ${rows.length === 1 ? singular(name) : name}${paging}`);
    const lines = records.length === rows.length ? table(records) : rows.map((row) => clip(`  ${JSON.stringify(row)}`, WIDTH));
    for (const line of lines) run.print(line);
    const firstId = records[0]?.id;
    if (firstId !== undefined && firstId !== null) {
      run.print('');
      run.print('Next');
      run.print(`  1. ${plan.resource?.ops.get ? `siren ${name} get ${String(firstId)}` : `siren get ${plan.outgoing.path}/${String(firstId)}`}`);
    }
    run.print(`› --json prints the answer as JSON.${paging ? ' --all reads every page.' : ''}`);
    return;
  }

  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const id = record.id;
    run.print(`✓ ${singular(name)}${id !== undefined && id !== null ? ` ${String(id)}` : ''}${plan.outgoing.method === 'GET' ? '' : ` ${pastTense(plan.outgoing.method)}`}`);
    for (const line of block(record)) run.print(line);
    return;
  }

  run.print(`✓ ${plan.outgoing.method} ${plan.outgoing.path} answered ${status}.`);
  if (body !== undefined) run.print(`  ${cellLine(body)}`);
}

function cellLine(value: unknown): string {
  return clip(typeof value === 'string' ? value : JSON.stringify(value), WIDTH - 2);
}

function pastTense(method: HttpMethod): string {
  return method === 'POST' ? 'saved' : method === 'DELETE' ? 'deleted' : 'updated';
}

/** An error's three parts: what was refused, what Siren said, and the command that helps. */
export function errorParts(error: SirenError, plan: Pick<Plan, 'outgoing' | 'resource' | 'line'>, run: Pick<CommandContext, 'command'>): ErrorParts {
  const { method, path } = plan.outgoing;
  const status = error.statusCode ?? 0;
  const said = error.message.replace(/^Siren: /, '');
  const fields = error instanceof BadRequestError && error.fieldErrors.length > 0 ? ` ${error.fieldErrors.map((field) => `${field.field}: ${field.message}`).join(' ')}` : '';
  const why = `Siren says: ${said}${fields} (${status}${error.code ? `, ${error.code}` : ''})`;
  const list = plan.resource?.ops.list ? `siren ${plan.resource.name} list` : `siren get /${path.split('/').filter(Boolean)[0] ?? ''}`;
  const fix =
    status === 401
      ? `Run ${run.command('login')} to sign in again.`
      : status === 403
        ? `Run ${run.command('whoami')} to see your role. An admin of the organization can do this.`
        : status === 404
          ? `Run ${list} to see what is there.`
          : status === 400 || status === 422
            ? `Run siren help ${plan.line.replace(/^siren /, '')} for the fields, or add --dry-run to see what was sent.`
            : status === 405
              ? `Siren serves no ${method} on ${path}. Run siren help ${plan.line.replace(/^siren /, '')} to see the methods.`
              : status >= 500
                ? `Try again in a minute. Add --dry-run to see what was sent.`
                : `Add --dry-run to see what was sent.`;
  return { what: `Siren refused ${method} ${path}.`, why, fix };
}
