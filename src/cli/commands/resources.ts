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
import { DELETE_ROUTES, RESOURCE_COMMANDS } from '../resources.generated';
import type { DeleteRoute, ResourceCommand, ResourceOp, ResourceRoute } from '../resources.generated';
import { fieldProblems, fieldsLine } from '../validation';
import { CliRefusal, CliUsageError } from '../targets';
import { clean, styleFor } from '../style';
import { cell, recordRows, table } from './resource-output';
import { recordView } from '../record-view';
import { recordLink, resourceTypeOf } from '../links';
import { nearest } from '../suggest';
import { READ_STATUSES, WRITE_NOTES, WRITE_VALUES } from '../record-values';
import { FORMATTED_SUFFIX, currenciesFor, holdsMoney, withMoney, withMoneyText } from '../money';

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
  ids: { type: 'boolean' },
  fields: { type: 'string' },
};

const FLAG = {
  d: ['-d <key=value>', 'A field, repeatable: a query parameter on a read, a body field on a write, a[b]=1 nested'],
  data: ['--data <json or @file>', 'A JSON body, or @file.json to read one, under any -d fields'],
  json: ['--json', "Print Siren's answer as JSON, and nothing else"],
  limit: ['--limit <n>', 'How many records a page holds, sent as number'],
  offset: ['--offset <n>', 'How many records to skip, sent as offset'],
  all: ['--all', 'Read every page of the list'],
  'dry-run': ['--dry-run', 'Print the request and send nothing'],
  confirm: ['--confirm <id>', 'The id of the record a live delete removes, when there is no terminal to type it in'],
  ids: ['--ids', 'Print one id a line and nothing else'],
  fields: ['--fields <a,b,c>', 'Show only these fields, in the table and in --json'],
} as const satisfies Record<string, readonly [string, string]>;

/** A command line's shape, as `runCli` reads it. The same fields as its own command table. */
export interface ResourceSpec {
  usage: string;
  summary: string;
  group: 'Records';
  /** The few words help prints beside it, with no full stop. */
  short: string;
  options: Options;
  flags: Readonly<Record<string, readonly [string, string]>>;
  examples: readonly string[];
  /** A write's body fields as help lists them: the name, and its type, allowed values and need. */
  fields?: ReadonlyArray<readonly [string, string]>;
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
  if (list) keys.push('limit', 'offset', 'all', 'ids', 'fields');
  keys.push('json', 'dry-run');
  if (method === 'DELETE') keys.push('confirm');
  return {
    options: Object.fromEntries(keys.map((key) => [key, OPTIONS[key]!])),
    flags: Object.fromEntries(keys.map((key) => [key, FLAG[key]])),
  };
}

/** The flags a filter can't take, since a record command or every command already has them. */
const RESERVED_FLAGS = new Set([...Object.keys(FLAG), 'sandbox', 'live', 'base-url', 'quiet', 'verbose', 'org', 'help', 'yes', 'stdin']);

type Filter = NonNullable<ResourceRoute['filters']>[number];

/** A filter's flag: its name in kebab case, and `s` as `search`. */
function filterFlag(filter: Filter, route: ResourceRoute): string {
  const name = filter.name === 's' && !route.filters?.some((other) => other.name === 'search') ? 'search' : filter.name;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** A filter's values as help and refusals show them: each once, lowercase where both cases are listed. */
function shownValues(filter: Filter): string[] {
  const values = filter.values ?? [];
  return values.filter((value) => !(value !== value.toLowerCase() && values.includes(value.toLowerCase())));
}

/**
 * The list's filter flags, each with its query parameter, leaving out any
 * whose flag another option has. A `status` filter openapi leaves as plain
 * text takes the words Siren stores for that resource ({@link READ_STATUSES}),
 * so a wrong word is refused before anything is sent (review round 1, C11).
 */
function filtersOf(route: ResourceRoute, resource?: ResourceCommand): Array<{ filter: Filter; flag: string; aliases?: Readonly<Record<string, string>>; note?: string }> {
  const extra = resource !== undefined && resource.ops.list === route ? (PAGED_BY_PAGE[resource.name]?.filters ?? []) : [];
  return [...(route.filters ?? []), ...extra]
    .map((given) => {
      const words = given.name === 'status' && given.values === undefined && resource !== undefined ? READ_STATUSES[resource.name] : undefined;
      const filter: Filter = words === undefined ? given : { ...given, values: [...words.values, ...Object.keys(words.aliases ?? {})] };
      return { filter, flag: filterFlag(filter, route), ...(words?.aliases === undefined ? {} : { aliases: words.aliases }), ...(words?.note === undefined ? {} : { note: words.note }) };
    })
    .filter(({ flag }) => !RESERVED_FLAGS.has(flag));
}

/** A filter's help line: `--status <pending|complete|…>`, `--program-id <n>`, `--order <asc|desc>`. */
function filterHelp(filter: Filter, flag: string, note?: string): readonly [string, string] {
  const values = shownValues(filter);
  const listed = values.join('|');
  const placeholder = values.length > 0 ? (listed.length <= 50 ? listed : 'value') : filter.type === 'integer' ? 'n' : filter.type === 'number' ? 'number' : filter.type === 'boolean' ? 'true|false' : 'text';
  const also = values.length > 0 && listed.length > 50 ? `: ${values.join(', ')}` : '';
  return [`--${flag} <${placeholder}>`, `Sent as ${filter.name}${also}${note === undefined ? '' : `. ${note}`}`];
}

/** "a, b or c". */
function orList(values: readonly string[]): string {
  return values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

/**
 * The lists Siren pages by `page` and `perPage` in place of `offset` and
 * `number`, with the filters openapi.json leaves out, from the route's
 * controller. GET /applications (ListApplications) takes status, formId,
 * page and perPage, at most 100 a page, so --limit sends perPage
 * (review round 1, C28).
 */
const PAGED_BY_PAGE: Readonly<Record<string, { most: number; filters: readonly Filter[] }>> = {
  applications: {
    most: 100,
    filters: [
      { name: 'status', type: 'string', values: ['waiting', 'approved', 'declined', 'all'] },
      { name: 'formId', type: 'integer' },
    ],
  },
};

/**
 * A query that pages by `page` and `perPage`, from the `number` and
 * `offset` --limit and --offset set, or `CliUsageError` for an offset that
 * starts no page.
 */
function byPage(query: Record<string, string>, most: number): Record<string, string> {
  const { number, offset, ...rest } = query;
  const perPage = number === undefined ? undefined : Number(number);
  if (perPage !== undefined && perPage > most) throw new CliUsageError(`--limit takes ${most} or fewer here, since Siren sends at most ${most} a page, and got ${perPage}.`);
  const size = perPage ?? 25;
  if (offset !== undefined && Number(offset) % size !== 0) throw new CliUsageError(`--offset takes a multiple of --limit here (${size}), since Siren pages this list by page, and got ${offset}.`);
  return { ...rest, ...(perPage === undefined ? {} : { perPage: String(perPage) }), ...(offset === undefined || Number(offset) === 0 ? {} : { page: String(Number(offset) / size + 1) }) };
}

/** The query parameters the filter flags send, each value checked against its type, or `CliUsageError`. */
function filterQuery(input: CommandInput, route: ResourceRoute, resource?: ResourceCommand): Record<string, string> {
  const query: Record<string, string> = {};
  for (const { filter, flag, aliases } of filtersOf(route, resource)) {
    const typed = (input.values as Record<string, unknown>)[flag];
    if (typeof typed !== 'string') continue;
    if (filter.values !== undefined && !filter.values.includes(typed)) throw new CliUsageError(`--${flag} takes ${orList(shownValues(filter))}, and ${JSON.stringify(typed)} isn't one.`);
    const given = aliases?.[typed] ?? typed;
    if (filter.type === 'integer' && !/^-?\d+$/.test(given)) throw new CliUsageError(`--${flag} takes a whole number, and ${JSON.stringify(given)} isn't one.`);
    if (filter.type === 'number' && !Number.isFinite(Number(given))) throw new CliUsageError(`--${flag} takes a number, and ${JSON.stringify(given)} isn't one.`);
    if (filter.type === 'boolean' && given !== 'true' && given !== 'false') throw new CliUsageError(`--${flag} takes true or false, and ${JSON.stringify(given)} isn't either.`);
    query[filter.name] = given;
  }
  return query;
}

/** True when a list route takes both orderBy and order, so the tool can ask for newest first. */
function ordersNewestFirst(route: ResourceRoute): boolean {
  return route.query?.includes('orderBy') === true && route.query.includes('order');
}

/**
 * The fields a list asks Siren for, where Siren's own default leaves out
 * what the table needs (review round 1, C13): a transaction's total and
 * currency, a conversion's program, an obligation's collaborator. The rest
 * are Siren's defaults, from each route's DEFAULT_FIELDS, so --fields can
 * name any of them and an unknown one is caught against a real record.
 */
const LIST_FIELDS: Readonly<Record<string, readonly string[]>> = {
  transactions: ['id', 'status', 'totalValue', 'currency', 'dateCreated'],
  conversions: ['id', 'engagementId', 'transactionId', 'obligationId', 'collaboratorName', 'amount', 'obligationAwardType', 'isTest', 'status', 'type', 'programId', 'programName', 'dateCreated', 'dateModified'],
  obligations: ['id', 'collaboratorId', 'collaboratorName', 'status', 'awardType', 'value', 'payoutId', 'dateCreated', 'dateModified'],
  collaborators: ['id', 'status', 'fullName', 'nickname', 'email', 'createdDate', 'modifiedDate'],
  programs: ['id', 'name', 'description', 'status', 'units', 'incentiveType', 'incentiveResolverType', 'createdDate', 'modifiedDate'],
};

/**
 * What a list adds to the query it sends, the same for `siren programs
 * list` and `siren get /programs` (review round 1, C26): newest first where
 * the route takes an order, and the fields {@link LIST_FIELDS} names with
 * any --fields beside them. A query parameter the line names itself wins.
 */
function listDefaults(input: CommandInput, resource: ResourceCommand, route: ResourceRoute, query: Readonly<Record<string, string>>, fields: readonly string[] | undefined): Record<string, string> {
  const named = [...pairs(input).map(([key]) => key), ...Object.keys(query)];
  const added: Record<string, string> = {};
  if (ordersNewestFirst(route) && !named.includes('orderBy') && !named.includes('order')) Object.assign(added, { orderBy: 'id', order: 'desc' });
  if (named.includes('fields')) return added;
  const wanted = LIST_FIELDS[resource.name];
  if (wanted !== undefined) added.fields = [...new Set([...wanted, ...(fields ?? [])])].join(',');
  else if (fields !== undefined && route.query?.includes('fields')) added.fields = fields.join(',');
  return added;
}

/** What a generated command does, in a sentence: "List programs, newest first.", "Show one program.", "Create a program." */
function sentenceOf(resource: ResourceCommand, op: ResourceOp, route: ResourceRoute): string {
  const one = singular(resource.name).replace(/-/g, ' ');
  const a = /^[aeiou]/.test(one) ? 'an' : 'a';
  const words = resource.name.replace(/-/g, ' ');
  if (op === 'list') return `List ${words}${ordersNewestFirst(route) ? ', newest first' : ''}.`;
  if (op === 'get') return `Show one ${one}.`;
  if (op === 'create') return `Create ${a} ${one}.`;
  if (op === 'update') return `Change ${a} ${one}.`;
  return `Delete ${a} ${one}.`;
}

/** The fields `--fields` names, or undefined without it. */
function fieldsOf(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const fields = [...new Set(value.split(',').map((field) => field.trim()).filter((field) => field !== ''))];
  if (fields.length === 0) throw new CliUsageError('--fields takes field names joined by commas, such as --fields id,name,status.');
  return fields;
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
    return {
      name: 'resources',
      spec: { usage: 'resources', summary: "List the record commands generated from Siren's API.", short: 'List the record commands', group: 'Records', options: {}, flags: {}, examples: ['siren resources'], positionals: [0, 0], offline: true, run: listResources },
    };
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
        short: `Send ${method} to any route`,
        group: 'Records',
        options,
        flags,
        examples: [method === 'GET' ? 'siren get /programs --limit 5' : method === 'DELETE' ? 'siren delete /programs/12' : `siren ${verb} /programs${method === 'POST' ? '' : '/12'} -d name="Referral program"`],
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
      spec: {
        usage: `${resource.name} <${ops.join('|')}>`,
        summary: `Read and change ${resource.name} on Siren.`,
        short: `Read and change ${resource.name}`,
        group: 'Records',
        options: {},
        flags: {},
        examples: [`siren ${resource.name} ${ops[0]}`],
        positionals: [0, 0],
        offline: true,
        run: (input) => resourceHelp(input, resource),
      },
    };
  }

  if (second === 'bulk' && resource.bulk !== undefined) return bulkSpec(resource, resource.bulk);
  if (second === 'add' && MEMBER_ADD[resource.name] !== undefined) return addSpec(resource, MEMBER_ADD[resource.name]!);

  const op = second as ResourceOp;
  const route = resource.ops[op];
  if (route === undefined) {
    throw new CliUsageError(`siren ${resource.name} has no ${second}. It has ${ops.join(', ')}.`);
  }

  const takesId = route.param !== undefined;
  const shaped = optionsFor(route.method, op === 'list' && (route.paginated === true || PAGED_BY_PAGE[resource.name] !== undefined));
  // A list's query parameters are flags of their own (lean output, section 5).
  const filters = op === 'list' ? filtersOf(route, resource) : [];
  const options: Options = { ...shaped.options, ...Object.fromEntries(filters.map(({ flag }) => [flag, { type: 'string' as const }])) };
  const flags: Record<string, readonly [string, string]> = { ...shaped.flags, ...Object.fromEntries(filters.map(({ filter, flag, note }) => [flag, filterHelp(filter, flag, note)])) };
  const writes = op === 'create' || op === 'update';
  const example = `siren ${resource.name} ${op}${takesId ? ' 12' : ''}${writes ? ` -d ${exampleField(resource, route)}` : ''}`;
  return {
    name: `${resource.name} ${op}`,
    spec: {
      usage: `${resource.name} ${op}${takesId ? ' <id>' : ''}${Object.keys(flags).length > 0 ? ' [options]' : ''}`,
      summary: `${sentenceOf(resource, op, route)} Sends ${route.method} ${route.path}.${route.required?.length ? ` Siren requires ${route.required.join(', ')}.` : ''}`,
      short: sentenceOf(resource, op, route).replace(/\.$/, '').replace(/, newest first$/, ''),
      group: 'Records',
      options,
      flags,
      examples: [example],
      ...(writes ? { fields: fieldRows(resource, route) } : {}),
      positionals: takesId ? [1, 1] : [0, 0],
      readsOnly: route.method === 'GET',
      run: (input) => sendResource(input, resource, op, route),
    },
  };
}

/** The values a body field takes: openapi's enum, else the words {@link WRITE_VALUES} names, else none. */
function fieldValues(resource: ResourceCommand | undefined, route: ResourceRoute, field: string): readonly string[] | undefined {
  return route.enums?.[field] ?? (resource === undefined ? undefined : WRITE_VALUES[`${resource.name} ${route.method}`]?.[field]);
}

/** A field's type in words, as help names it. */
function typeWords(type: string | undefined): string | undefined {
  const base = type?.replace(/\|null$/, '');
  const words = base === 'integer' ? 'a whole number' : base === 'number' ? 'a number' : base === 'boolean' ? 'true or false' : base === 'string' ? 'text' : undefined;
  return words === undefined ? undefined : `${words}${type?.endsWith('|null') ? ', or null to clear it' : ''}`;
}

/**
 * A write's body fields as help lists them, from openapi.json: each name,
 * then the values it takes or its type, and whether Siren requires it
 * (review round 1, C20). Nested fields, such as incentiveTypeArgs.x, keep
 * their dotted name, which -d takes as incentiveTypeArgs[x].
 */
function fieldRows(resource: ResourceCommand, route: ResourceRoute): Array<readonly [string, string]> {
  return (route.fields ?? []).map((field) => {
    const values = fieldValues(resource, route, field);
    const parts = [values !== undefined ? `One of ${orList(values)}` : typeWords(route.types?.[field]), route.required?.includes(field) ? 'required' : undefined, WRITE_NOTES[resource.name]?.[field]];
    const said = parts.filter((part): part is string => part !== undefined && part !== '');
    const text = said.length === 0 ? 'Any value Siren takes' : said.map((part, at) => (at === 0 ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part)).join('. ');
    return [field.includes('.') ? field.replace(/\.(.+)$/, '[$1]') : field, `${text}.`.replace(/\.\.$/, '.')] as const;
  });
}

/** A real `-d key=value` for a write's example: a field with values, such as status=approved, else a required field with a value of its type. */
function exampleField(resource: ResourceCommand, route: ResourceRoute): string {
  const fields = route.fields ?? [];
  const valued = fields.find((field) => fieldValues(resource, route, field) !== undefined);
  if (valued !== undefined) {
    const values = fieldValues(resource, route, valued)!;
    return `${valued}=${values.includes('approved') ? 'approved' : values.includes('active') ? 'active' : values[0]}`;
  }
  const field = route.required?.[0] ?? fields.find((candidate) => !candidate.includes('.')) ?? 'name';
  const type = route.types?.[field]?.replace(/\|null$/, '');
  const sample = type === 'integer' || type === 'number' ? '1' : type === 'boolean' ? 'true' : field === 'name' ? '"Referral program"' : field === 'email' ? 'ana@example.com' : 'value';
  return `${field}=${sample}`;
}

/** The global flags {@link commandLine} adds again, or that a hint leaves off. */
const HINT_DROPS = new Set(['sandbox', 'live', 'base-url', 'quiet', 'verbose', 'help', 'dry-run', 'json']);

/** One word of a command line, quoted for a shell when it holds anything but plain characters. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./[\]-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command as typed: `words`, its arguments, and each flag but the
 * global ones, such as `collaborators update 99999 -d nickname=x`, so a
 * hint offers the same line again (review round 1, C10).
 */
export function typedLine(input: Partial<Pick<CommandInput, 'args' | 'values'>>, words: string): string {
  const parts = [words, ...(input.args ?? []).map(shellWord)];
  for (const [key, value] of Object.entries(input.values ?? {})) {
    if (HINT_DROPS.has(key) || value === undefined || value === false) continue;
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    for (const one of Array.isArray(value) ? (value as unknown[]) : [value]) parts.push(one === true ? flag : `${flag} ${shellWord(String(one))}`);
  }
  return parts.join(' ');
}

/** `siren resources`: every generated resource and its operations. */
async function listResources(input: CommandInput): Promise<number> {
  const style = styleFor(input.io, 'stdout', {});
  const width = Math.max(...RESOURCE_COMMANDS.map((resource) => resource.name.length));
  if (!style.rich) {
    // Through a pipe, standard output holds one resource a line with its operations, and the rest goes to standard error (review round 1, C12).
    input.io.stdout(`${RESOURCE_COMMANDS.map((resource) => `${resource.name.padEnd(width)}  ${RESOURCE_OPS.filter((op) => resource.ops[op]).join(' ')}`).join('\n')}\n`);
    input.io.stderr(`${RESOURCE_COMMANDS.length} resources, generated from Siren's API\n\nNext\n  1  siren programs list\n\nsiren get <path> reaches any other route.\n`);
    return 0;
  }
  const lines = [
    style.success(`${style.bold(String(RESOURCE_COMMANDS.length))} resources, generated from Siren's API`),
    '',
    ...RESOURCE_COMMANDS.map((resource) => style.fold(`  ${style.bold(resource.name.padEnd(width))}  ${RESOURCE_OPS.filter((op) => resource.ops[op]).join(' ')}`)),
    '',
    style.bold('Next'),
    `  ${style.command(`siren ${RESOURCE_COMMANDS.find((resource) => resource.name === 'programs')?.name ?? RESOURCE_COMMANDS[0]?.name ?? 'programs'} list`)}`,
    '',
    style.next(style.dim('siren get <path> reaches any other route.')),
  ];
  input.io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

/** `siren <resource>`: its operations, each with the route it sends. */
async function resourceHelp(input: CommandInput, resource: ResourceCommand): Promise<number> {
  const style = styleFor(input.io, 'stdout', {});
  const ops = RESOURCE_OPS.filter((op) => resource.ops[op]);
  const rows = [
    ...ops.map((op) => [`siren ${resource.name} ${op}${resource.ops[op]!.param ? ' <id>' : ''}`, `${resource.ops[op]!.method} ${resource.ops[op]!.path}`] as const),
    ...(resource.bulk === undefined ? [] : [[`siren ${resource.name} bulk <action>`, `POST ${resource.bulk.path}`] as const]),
    ...(MEMBER_ADD[resource.name] === undefined ? [] : [[`siren ${resource.name} add <id>`, `POST ${MEMBER_ADD[resource.name]!.path}`] as const]),
  ];
  const width = Math.max(...rows.map(([left]) => left.length)) + 3;
  input.io.stdout(
    [
      `Read and change ${resource.name} on Siren.`,
      '',
      style.bold('USAGE'),
      `  siren ${resource.name} <${ops.join('|')}> [flags]`,
      '',
      style.bold('COMMANDS'),
      ...rows.map(([left, right]) => style.fold(`  ${style.bold(left)}${' '.repeat(width - left.length)}${right}`)),
      '',
      style.bold('LEARN MORE'),
      `  Run ${style.command(`siren ${resource.name} <command> --help`)} for its flags and an example.`,
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
  /** The command's words, for an error's fix: `programs get` or `get`. */
  words: string;
  /** `--ids`: one id a line and nothing else. */
  ids?: boolean;
  /** `--fields`: the fields the table and --json show. */
  fields?: readonly string[];
}

/** `siren get|post|put|patch|delete <path>`. */
async function sendRaw(input: CommandInput, method: HttpMethod): Promise<number> {
  const { path, query } = apiPath(input.args[0]!);
  const deleteId = method === 'DELETE' ? recordIdOf(path) : undefined;
  const matched = routeOf(method, path);
  if (matched !== undefined && method !== 'GET' && method !== 'DELETE') checkFieldValues(input, matched.resource, matched.route, `${method.toLowerCase()} ${path}`.replace(/^(\S+) .*$/, '$1'));
  const fields = method === 'GET' ? fieldsOf(input.values.fields) : undefined;
  const listing = method === 'GET' && matched?.op === 'list' ? listDefaults(input, matched.resource, matched.route, query, fields) : {};
  const outgoing = await outgoingOf(input, method, path, { ...query, ...listing }, typesOf(method, path));
  return send(input, {
    outgoing,
    ...(method === 'GET' && input.values.ids === true ? { ids: true } : {}),
    ...(fields === undefined ? {} : { fields }),
    json: input.values.json === true,
    dryRun: input.values['dry-run'] === true,
    all: input.values.all === true,
    ...(deleteId !== undefined ? { deleteId } : {}),
    words: method.toLowerCase(),
  });
}

/**
 * The id of the record a raw delete removes: the value at the last parameter
 * of the DELETE route in openapi.json that the path matches. A path that
 * matches no DELETE route, or one whose route has no parameter, names no
 * record, and is refused before anything is asked or sent.
 */
export function recordIdOf(path: string): string {
  const given = path.split('/').filter(Boolean);
  const matches = DELETE_ROUTES.filter((route) => {
    const parts = route.path.split('/').filter(Boolean);
    return parts.length === given.length && parts.every((part, i) => /^\{[^}]+\}$/.test(part) || part === given[i]);
  });
  // A route with more fixed segments is the closer match.
  const fixed = (route: DeleteRoute) => route.path.split('/').filter((part) => part !== '' && !part.startsWith('{')).length;
  const route = matches.sort((a, b) => fixed(b) - fixed(a))[0];
  const at = route?.param === undefined ? -1 : route.path.split('/').filter(Boolean).indexOf(`{${route.param}}`);
  if (route === undefined || at < 0) {
    throw new CliUsageError(
      `siren delete needs a path that names one record, such as /programs/7. ${route === undefined ? `Siren has no DELETE route at ${path}` : `${path} names no record`}, so nothing was sent.`,
    );
  }
  try {
    return decodeURIComponent(given[at]!);
  } catch {
    return given[at]!;
  }
}

/** `siren <resource> <op> [id]`. */
async function sendResource(input: CommandInput, resource: ResourceCommand, op: ResourceOp, route: ResourceRoute): Promise<number> {
  const id = input.args[0];
  if (id !== undefined && /^\.{1,2}$/.test(fullyDecoded(id))) throw new CliUsageError(`${JSON.stringify(id)} is not a record id. Give the id Siren lists, such as 7.`);
  const path = route.param !== undefined && id !== undefined ? route.path.replace(`{${route.param}}`, encodeURIComponent(id)) : route.path;
  const fields = op === 'list' ? fieldsOf(input.values.fields) : undefined;
  const base: Record<string, string> = {};
  if (op === 'list') {
    Object.assign(base, filterQuery(input, route, resource));
    Object.assign(base, listDefaults(input, resource, route, base, fields));
  }
  if (route.method !== 'GET' && route.method !== 'DELETE') checkFieldValues(input, resource, route, `${resource.name} ${op}`);
  const sent = await outgoingOf(input, route.method, path, base, route.types);
  const paged = op === 'list' ? PAGED_BY_PAGE[resource.name] : undefined;
  const outgoing = paged === undefined ? sent : { ...sent, query: byPage(sent.query, paged.most) };
  return send(input, {
    outgoing,
    ...(op === 'list' && input.values.ids === true ? { ids: true } : {}),
    ...(fields === undefined ? {} : { fields }),
    json: input.values.json === true,
    dryRun: input.values['dry-run'] === true,
    all: input.values.all === true,
    ...(op === 'delete' && id !== undefined ? { deleteId: id } : {}),
    resource,
    words: `${resource.name} ${op}`,
  });
}

/**
 * A path as the tool sends it: after /siren/v1, with a leading slash, and
 * its query string split off. A full address is refused, since the session
 * goes only to the Siren the command targets, and so is a path whose `..`
 * segments climb out of /siren/v1 (see {@link insideApi}).
 */
export function apiPath(given: string): { path: string; query: Record<string, string> } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
    throw new CliUsageError(`Give a path such as /programs, not an address. The tool sends it to the Siren you target, with --base-url to choose another.`);
  }
  const [rawPath, search = ''] = given.split('?', 2) as [string, string?];
  let path = `/${rawPath.replace(/^[/\\]+/, '')}`.replace(/\/+$/, '') || '/';
  path = path.replace(/^\/siren\/v1(?=\/|$)/, '') || '/';
  return { path: insideApi(path, given), query: Object.fromEntries(new URLSearchParams(search)) };
}

/** A path segment decoded until it stops changing, so `%252e` reads as `.`. */
function fullyDecoded(segment: string): string {
  let current = segment;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * The path with its `.` and `..` segments resolved, the way a URL parser and
 * a web server would. A dot written as `%2e`, or encoded twice, counts, and
 * so does a backslash or an encoded slash between segments. A path that
 * climbs above /siren/v1 is refused, since the bearer token would go to
 * whatever else the host serves, such as WordPress's own REST API.
 */
export function insideApi(path: string, given: string = path): string {
  const kept: string[] = [];
  for (const segment of path.split(/[/\\]/)) {
    const pieces = fullyDecoded(segment).split(/[/\\]/);
    if (pieces.length > 1 && pieces.some((piece) => piece === '.' || piece === '..')) {
      throw new CliUsageError(`${given} leaves /siren/v1 through an encoded slash, so nothing was sent. Give a path such as /programs/7.`);
    }
    const decoded = pieces[0]!;
    if (decoded === '' || decoded === '.') continue;
    if (decoded === '..') {
      if (kept.length === 0) throw new CliUsageError(`${given} leaves /siren/v1, so nothing was sent. Give a path under it, such as /programs/7.`);
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return `/${kept.join('/')}`;
}

/**
 * A `-d` value as Siren gets it: a JSON number, true, false or null as that,
 * anything else as text. Where openapi types the field, the type decides, so
 * a name such as 2026 stays text (review of PR 94). `null` clears a field
 * openapi marks nullable, and is refused for a typed field it doesn't, since
 * Siren would store the word.
 */
export function fieldValue(text: string, type?: string, key = 'The field'): unknown {
  const nullable = type === undefined || type.endsWith('|null');
  const base = type?.replace(/\|null$/, '');
  if (text === 'null') {
    if (nullable) return null;
    throw new CliUsageError(`${key} can't be cleared with null, since Siren's route takes a ${base === 'string' ? 'text' : base} value there. Give it a value.`);
  }
  if (base === 'string') return text;
  if ((base === 'integer' || base === 'number') && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  if (base === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && Number.isSafeInteger(Math.trunc(Number(text)))) return Number(text);
  return text;
}

/** The generated route a raw call reaches, such as POST /programs, with its resource, or undefined. */
function routeOf(method: HttpMethod, path: string): { resource: ResourceCommand; route: ResourceRoute; op: ResourceOp } | undefined {
  const bare = path.split('?')[0]!.replace(/\/+$/, '');
  for (const resource of RESOURCE_COMMANDS) {
    for (const [op, route] of Object.entries(resource.ops) as Array<[ResourceOp, ResourceRoute | undefined]>) {
      if (route === undefined || route.method !== method) continue;
      const pattern = new RegExp(`^${route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`);
      if (pattern.test(bare)) return { resource, route, op };
    }
  }
  return undefined;
}

/** The body field types of the generated route a raw call reaches, such as POST /programs, or none. */
function typesOf(method: HttpMethod, path: string): Readonly<Record<string, string>> {
  for (const resource of RESOURCE_COMMANDS) {
    for (const route of Object.values(resource.ops)) {
      if (route === undefined || route.method !== method || route.types === undefined) continue;
      const pattern = new RegExp(`^${route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`);
      if (pattern.test(path.split('?')[0]!.replace(/\/+$/, ''))) return route.types;
    }
  }
  return {};
}

/**
 * Refuses, before anything is sent, a `-d` value a field doesn't take, such
 * as status=complete on a conversion, naming the values it does and the
 * help that lists every field (review round 1, C11).
 */
function checkFieldValues(input: CommandInput, resource: ResourceCommand | undefined, route: ResourceRoute, words: string): void {
  for (const [key, value] of pairs(input)) {
    const field = key.replace(/\[([^\]]*)\]/g, '.$1').replace(/^\./, '');
    const values = fieldValues(resource, route, field);
    if (values === undefined || values.includes(value) || value === 'null') continue;
    const note = resource === undefined ? undefined : WRITE_NOTES[resource.name]?.[field];
    const hint = note !== undefined && value === 'complete' && values.includes('approved') ? ` ${note} Send ${field}=approved to approve one.` : '';
    throw new CliUsageError(`${field} takes ${orList(values)}, and ${JSON.stringify(value)} isn't one.${hint} siren ${words} --help lists every field.`);
  }
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
  // A key that reaches an object's prototype would change every object in the tool (review of PR 94).
  const unsafe = parts.find((part) => part === '__proto__' || part === 'constructor' || part === 'prototype');
  if (unsafe !== undefined) throw new CliUsageError(`-d can't set ${unsafe}. Use --data with a JSON body for a field Siren really names that.`);
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
async function outgoingOf(input: CommandInput, method: HttpMethod, given: string, query: Record<string, string>, types: Readonly<Record<string, string>> = {}): Promise<Outgoing> {
  const path = insideApi(given);
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
      throw new CliRefusal(`Couldn't read ${data.slice(1)}.`, { why: 'A path after @ starts from this folder.', fixText: 'Check the path, then run it again.' });
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
  for (const [key, value] of fields) setNested(body, key, fieldValue(value, types[key.replace(/\[([^\]]*)\]/g, '.$1').replace(/^\./, '')], key));
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
      return 0;
    }
    const style = styleFor(input.io, 'stdout', {});
    input.io.stdout(
      style.report({
        headline: `Would send ${style.bold(`${outgoing.method} ${url}`)}`,
        ...(outgoing.body !== undefined ? { rows: [['body', JSON.stringify(outgoing.body)]] } : {}),
        // Through a pipe the note goes to standard error, as every list's does (review round 1, C12).
        ...(style.rich ? { tips: ['Nothing was sent.'] } : {}),
      }),
    );
    if (!style.rich) input.io.stderr('Nothing was sent.\n');
    return 0;
  }

  await run.signedIn();
  if (plan.deleteId !== undefined && (await run.targetEdition()) === 'production') await confirmLiveDelete(input, run, plan, plan.deleteId);

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
      const paged = plan.resource === undefined ? undefined : PAGED_BY_PAGE[plan.resource.name];
      body = await allPages(body, outgoing.query, async (query) => (await request(paged === undefined ? query : byPage(query, paged.most))).body);
    }
    // Amounts beside a currency print as money, read with the organization's currencies. --json keeps Siren's integers and adds the text beside each (review round 1, C4). --ids prints ids alone.
    const definitions = () => currenciesFor(input.io.configDir, `${run.target.baseUrl} ${run.current().orgId}`, input.io.now(), async () => parseJsonBody(await transport.request({ method: 'GET', path: '/registries/currencies', retriable: true }))).catch(() => undefined);
    const shown = plan.ids || !holdsMoney(body) ? body : plan.json ? withMoneyText(body, await definitions()) : withMoney(body, await definitions());
    // A record read names its page in Siren's app: the last line of the view, and `url` in --json.
    const linkType = plan.resource !== undefined && plan.words === `${plan.resource.name} get` ? resourceTypeOf(plan.resource.name) : undefined;
    const current = run.current();
    // Only a plain id goes into an address, so nothing Siren sends can make the link say something else.
    const link = linkType !== undefined && isObject(body) && /^\d+$/.test(String(body.id ?? '')) ? recordLink(run.target.baseUrl, input.io.env, current.orgSlug || String(current.orgId), linkType, String(body.id), { fulfillmentId: body.fulfillmentId }) : undefined;
    print(input, plan, status, shown, outgoing.method === 'GET' ? undefined : orgLabel(run), link);
    return 0;
  } catch (error) {
    if (!(error instanceof SirenError) || error.statusCode === undefined) throw error;
    const refusal = refusalOf(error, plan, input, orgSlug(run));
    if (!plan.json) throw refusal;
    const fix = refusal.parts.fix === undefined ? null : `${refusal.parts.fix}${refusal.parts.fixWords === undefined ? '' : ` ${refusal.parts.fixWords}`}`;
    // Siren's context goes through untouched, so a script sees each failed field (failedValidations) and any other detail.
    input.io.stderr(`${JSON.stringify({ error: { message: error.message.replace(/^Siren: /, ''), status: error.statusCode, code: error.code ?? null, fix, context: error.data ?? null } }, null, 2)}\n`);
    return 1;
  }
}

/**
 * Asks the person to type the id before a delete on a live organization.
 * With no terminal, `--confirm <id>` must name it. A wrong id sends nothing.
 */
async function confirmLiveDelete(input: CommandInput, run: CommandContext, plan: Plan, id: string): Promise<void> {
  const again = input.command(`${plan.words} ${plan.words.includes(' ') ? id : plan.outgoing.path} --confirm ${id}`);
  const confirm = input.values.confirm;
  if (typeof confirm === 'string') {
    if (confirm !== id) throw new CliRefusal('Nothing was deleted.', { why: `--confirm names ${JSON.stringify(confirm)}, and the record is ${JSON.stringify(id)}.`, fix: again });
    return;
  }
  if (!input.io.interactive) {
    throw new CliRefusal('Nothing was deleted.', { why: `Deleting from ${orgLabel(run)} needs the record's id typed, and there is no terminal to ask in.`, fix: again });
  }
  const typed = (await input.io.prompt(`This deletes ${id} from ${orgLabel(run)}. Type ${id} to delete it: `)).trim();
  if (typed !== id) throw new CliRefusal('Nothing was deleted.', { why: `You typed ${JSON.stringify(typed)}, not ${JSON.stringify(id)}.`, fix: again });
}

/** The organization this run acts in, as apply names it: `Acme (acme), live`. */
/** The organization's slug, or its id, as a refusal names it, or undefined with no session to read it from. */
function orgSlug(run: CommandContext): string | undefined {
  try {
    const session = run.current();
    return session.orgSlug === undefined ? `organization ${clean(String(session.orgId))}` : clean(session.orgSlug);
  } catch {
    return undefined;
  }
}

function orgLabel(run: CommandContext): string {
  const session = run.current();
  return `${clean(session.orgName)} (${session.orgSlug === undefined ? session.orgId : clean(session.orgSlug)}), ${session.edition === 'production' ? 'live' : 'sandbox'}`;
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
/** The most pages --all reads, so a route that never says it has ended can't read forever. */
const MAX_PAGES = 1000;

async function allPages(first: Envelope, query: Record<string, string>, read: (query: Record<string, string>) => Promise<unknown>): Promise<Envelope> {
  const items = [...first.items];
  const perPage = first.perPage ?? first.items.length;
  let offset = Number(query.offset ?? 0) + first.items.length;
  let page = first.page ?? 1;
  const last = first.totalPages ?? Infinity;
  const seen = new Set(first.items.map((item) => JSON.stringify(item)));
  while (perPage > 0 && items.length < (first.total ?? Infinity) && page < last && page < MAX_PAGES) {
    const next = await read({ ...query, number: String(perPage), offset: String(offset) });
    if (!isEnvelope(next) || next.items.length === 0) break;
    // A route that ignores offset sends the same page again. Stop there rather than read forever (review of PR 94).
    if (next.items.every((item) => seen.has(JSON.stringify(item)))) break;
    for (const item of next.items) seen.add(JSON.stringify(item));
    items.push(...next.items);
    offset += next.items.length;
    page += 1;
    if (next.items.length < perPage) break;
  }
  return { items, total: first.total ?? items.length, page: 1, perPage: items.length, totalPages: 1 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prints Siren's answer: JSON, a table, a record, or one line. A record read ends with its page in Siren's app. */
function print(input: CommandInput, plan: Plan, status: number, body: unknown, org?: string, link?: string): void {
  const out = (text: string) => input.io.stdout(text.endsWith('\n') ? text : `${text}\n`);
  const listed = isEnvelope(body) ? body.items : Array.isArray(body) ? body : undefined;
  const listedRecords = (listed ?? []).filter(isObject);
  if (plan.fields !== undefined && listedRecords.length > 0) {
    const known = [...new Set(listedRecords.flatMap((record) => Object.keys(record)))];
    const unknown = plan.fields.filter((field) => !known.includes(field));
    if (unknown.length > 0) {
      // A typo names the field it was near, such as email for emial (review round 1, C10).
      const meant = unknown.map((field) => nearest(field, known)).filter((field): field is string => field !== undefined);
      const fixed = meant.length === unknown.length ? ` Did you mean --fields ${plan.fields.map((field) => (unknown.includes(field) ? nearest(field, known)! : field)).map(clean).join(',')}?` : '';
      throw new CliUsageError(`${unknown.map((field) => clean(field)).join(', ')} ${unknown.length === 1 ? "isn't a field" : "aren't fields"} of these records. They have ${known.map((field) => clean(field)).join(', ')}.${fixed}`);
    }
  }
  if (plan.ids && listed !== undefined) {
    for (const record of listedRecords) out(cell(record.id ?? record.key));
    return;
  }
  if (plan.json) {
    // --fields cuts each record to the fields named, and keeps the answer's shape.
    // A money field named keeps its text beside it.
    const pick = (record: unknown) => (plan.fields !== undefined && isObject(record) ? Object.fromEntries(plan.fields.flatMap((field) => [field, `${field}${FORMATTED_SUFFIX}`]).filter((field) => field in record).map((field) => [field, record[field]])) : record);
    const items = isEnvelope(body) ? body.items.map(pick) : Array.isArray(body) ? body.map(pick) : undefined;
    const shaped = items === undefined ? body : isEnvelope(body) ? { ...body, items } : items;
    out(JSON.stringify(link !== undefined && isObject(shaped) && !('url' in shaped) ? { ...shaped, url: link } : (shaped ?? null), null, 2));
    return;
  }

  const style = styleFor(input.io, 'stdout', {});
  const name = plan.resource?.name ?? (plan.outgoing.path.split('/').filter(Boolean)[0] ?? 'records');
  const rows = isEnvelope(body) ? body.items : Array.isArray(body) ? body : undefined;
  if (rows !== undefined) {
    const records = rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row));
    const paged = isEnvelope(body) && body.totalPages !== undefined && body.totalPages > 1;
    const page = paged ? style.dim(`  page ${(body as Envelope).page ?? 1} of ${(body as Envelope).totalPages}`) : '';
    const headline = style.success(`${style.bold(`${rows.length} ${rows.length === 1 ? singular(name) : name}`)}${page}`);
    const dated = { zone: input.io.env.TZ, now: input.io.now(), ...(plan.fields === undefined ? {} : { keys: plan.fields }) };
    const firstId = records[0]?.id;
    const hints: string[] = [];
    if (firstId !== undefined && firstId !== null) {
      const next = plan.resource?.ops.get ? `${name} get ${cell(firstId)}` : `get ${plan.outgoing.path}/${cell(firstId)}`;
      hints.push('', style.bold('Next'), `  ${style.command(input.command(next))}`);
    }
    const tip = `--json prints the answer as JSON.${paged ? ' --all reads every page.' : ''} --ids prints the ids alone. --fields picks the columns.`;
    if (!style.rich) {
      // Through a pipe, standard output carries the table alone, and the count, Next and tip go to standard error (lean output, section 5).
      const shown = records.length === rows.length ? table(style, records, { ...dated, indent: false }) : rows.map((row) => cell(row));
      if (shown.length > 0) out(shown.join('\n'));
      input.io.stderr(`${[headline, ...hints, '', tip].join('\n')}\n`);
      return;
    }
    const lines = [headline];
    const shown = records.length === rows.length ? table(style, records, dated) : rows.map((row) => style.fold(`  ${cell(row)}`));
    if (shown.length > 0) lines.push('', ...shown);
    lines.push(...hints, '', style.next(style.dim(tip)));
    out(lines.join('\n'));
    return;
  }

  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const id = record.id;
    if (plan.outgoing.method !== 'GET') {
      const what = `${singular(name)}${id !== undefined && id !== null ? ` ${cell(id)}` : ''}`;
      out(style.report({ headline: `${style.bold(what)} ${pastTense(plan.outgoing.method)} in ${org}`, rows: recordRows(style, record) }));
      return;
    }
    // A record read prints as a record view (lean-output.md, section 1).
    const view = recordView(style, record, { what: singular(name), words: name, zone: input.io.env.TZ, resources: RESOURCE_COMMANDS.filter((resource) => resource.ops.get !== undefined).map((resource) => resource.name) });
    const next = view.next;
    out([...view.lines, ...(link === undefined ? [] : ['', link])].join('\n'));
    if (next.length > 0) {
      const steps = ['', style.bold('Next'), ...next.map((words, at) => `  ${next.length === 1 ? '' : `${at + 1}  `}${style.command(input.command(words))}`)].join('\n');
      // Through a pipe, Next goes to standard error, so standard output carries the record alone.
      if (style.rich) out(steps);
      else input.io.stderr(`${steps}\n`);
    }
    return;
  }

  out(style.report({ headline: `${plan.outgoing.method} ${plan.outgoing.path} answered ${status}${org === undefined ? '' : ` in ${org}`}.`, ...(body !== undefined && body !== null ? { rows: [['answer', cell(body)]] } : {}) }));
}

function pastTense(method: HttpMethod): string {
  return method === 'POST' ? 'saved' : method === 'DELETE' ? 'deleted' : 'updated';
}

/**
 * Siren's refusal as the three-part error: what was refused, what Siren
 * said, and the command that helps. Its status and code are the detail
 * --verbose shows.
 */
export function refusalOf(error: SirenError, plan: Pick<Plan, 'outgoing' | 'resource' | 'words'>, input: Pick<CommandInput, 'command'> & Partial<Pick<CommandInput, 'args' | 'values'>>, org?: string): CliRefusal {
  const { method, path } = plan.outgoing;
  // The line as typed, -d and all, so a hint that offers it again runs as printed (review round 1, C10).
  const again = typedLine(input, plan.words);
  const problems = fieldProblems(error);
  if (problems.length > 0) {
    // A validation failure: what was refused, how many fields, then one row a field (lean output, "Validation failures").
    const op = plan.resource === undefined ? undefined : plan.words.slice(plan.resource.name.length + 1);
    const thing = plan.resource === undefined ? '' : singular(plan.resource.name);
    const what =
      op === 'create' ? `the new ${thing}` : op === 'update' ? `the change to ${thing} ${clean(decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? ''))}` : `${method} ${path}`;
    const them = problems.length === 1 ? 'it' : 'them';
    return new CliRefusal(`Siren refused ${what}.`, {
      why: fieldsLine(problems),
      problems,
      problemsAs: 'rows',
      ...(plan.resource === undefined ? { fixText: `Fix ${them} and run again.` } : { fixLead: `Fix ${them} and run again.`, fix: `siren ${plan.words} --help`, fixWords: 'lists the fields' }),
      detail: [`HTTP status: ${error.statusCode ?? 400}`, ...(error.code === undefined ? [] : [`Error code: ${error.code}`])],
    });
  }
  const status = error.statusCode ?? 0;
  const said = clean(error.message.replace(/^Siren: /, '')).replace(/\.?$/, '.');
  const fields = error instanceof BadRequestError && error.fieldErrors.length > 0 ? ` ${error.fieldErrors.map((field) => `${clean(field.field)}: ${clean(field.message)}`).join(' ')}` : '';
  const why = `Siren answered ${status}${error.code ? ` ${clean(error.code)}` : ''}: ${said}${fields}`;
  // A raw call on a route no generated list reaches, such as get /nope, points to siren resources, never to the same failing call.
  const listed = plan.resource ?? routeOf('GET', `/${path.split('/').filter(Boolean)[0] ?? ''}`)?.resource;
  const list = listed?.ops.list !== undefined ? `${listed.name} list` : 'resources';
  const help = `${plan.words} --help`;
  const typedId = plan.resource !== undefined && input.args?.[0] !== undefined ? input.args[0] : undefined;
  if (status === 404 && typedId !== undefined && plan.resource !== undefined) {
    // A record that isn't there is named the way siren explain names it (review round 1, C16).
    return new CliRefusal(`Siren has no ${singular(plan.resource.name)} ${clean(typedId)}${org === undefined ? '' : ` in ${org}`}.`, {
      why,
      fix: input.command(list),
      fixWords: `to list the ${plan.resource.name.replace(/-/g, ' ')} there`,
      detail: [`HTTP status: ${status}`, ...(error.code === undefined ? [] : [`Error code: ${error.code}`])],
    });
  }
  if (status === 404 && plan.resource === undefined && listed === undefined) {
    return new CliRefusal(`Siren has no route at ${method} ${path}.`, {
      why,
      fix: input.command('resources'),
      fixWords: 'to see the records this tool reads and writes',
      detail: [`HTTP status: ${status}`, ...(error.code === undefined ? [] : [`Error code: ${error.code}`])],
    });
  }
  const fix: { fix: string; fixWords: string } =
    status === 401
      ? { fix: input.command('login'), fixWords: 'to log in again' }
      : status === 403
        ? { fix: input.command('whoami'), fixWords: 'to see your role' }
        : status === 404
          ? { fix: input.command(list), fixWords: 'to see what is there' }
          : status === 400 || status === 422
            ? { fix: `siren ${help}`, fixWords: 'for the fields it takes' }
            : status === 405
              ? { fix: `siren ${help}`, fixWords: `to see the methods, since Siren serves no ${method} on ${path}` }
              : status >= 500
                ? { fix: input.command(`${again} --dry-run`), fixWords: 'to see what was sent, and try again in a minute' }
                : { fix: input.command(`${again} --dry-run`), fixWords: 'to see what was sent' };
  return new CliRefusal(`Siren refused ${method} ${path}.`, {
    why,
    ...fix,
    detail: [`HTTP status: ${status}`, ...(error.code === undefined ? [] : [`Error code: ${error.code}`])],
  });
}

/*
 * Pipes, both ends (lean output, section 5): --ids prints ids, and --stdin
 * reads them, so one command's list feeds another's bulk change, as
 * `siren conversions list --status pending --ids | siren conversions bulk approve --stdin --yes`.
 */

/** The most ids one bulk request carries. */
const BULK_CHUNK = 1000;

/** The member routes `siren <name> add <id>` sends: the path, and the key each member's id goes under. */
const MEMBER_ADD: Readonly<Record<string, { path: string; key: string; max: number }>> = {
  'collaborator-groups': { path: '/collaborator-groups/{id}/members', key: 'collaboratorId', max: 5000 },
};

const PIPE_OPTIONS: Options = { stdin: { type: 'boolean' }, yes: { type: 'boolean' }, d: OPTIONS.d!, json: OPTIONS.json!, 'dry-run': OPTIONS['dry-run']! };
const PIPE_FLAGS = {
  stdin: ['--stdin', 'Read the ids from standard input, one a line, as --ids prints them'],
  yes: ['--yes', 'Send it without asking'],
  d: ['-d <key=value>', 'Another field the request takes, such as programId=4, repeatable'],
  json: FLAG.json,
  'dry-run': FLAG['dry-run'],
} as const;

/** `siren <name> bulk <action> [ids…]`. */
function bulkSpec(resource: ResourceCommand, bulk: NonNullable<ResourceCommand['bulk']>): { name: string; spec: ResourceSpec } {
  return {
    name: `${resource.name} bulk`,
    spec: {
      usage: `${resource.name} bulk <action> [<id>…] [--stdin] [options]`,
      summary: `Run one action on many ${resource.name} at once: ${orList(bulk.actions)}. Sends POST ${bulk.path}, ${BULK_CHUNK} ids a request.`,
      short: `Run one action on many ${resource.name}`,
      group: 'Records',
      options: PIPE_OPTIONS,
      flags: PIPE_FLAGS,
      examples: [`siren ${resource.name} list --ids | siren ${resource.name} bulk ${bulk.actions[0]} --stdin --yes`],
      positionals: [1, 100000],
      run: (input) => sendBulk(input, resource, bulk),
    },
  };
}

/** `siren <name> add <id> [ids…]`: people into a group. */
function addSpec(resource: ResourceCommand, route: { path: string; key: string; max: number }): { name: string; spec: ResourceSpec } {
  return {
    name: `${resource.name} add`,
    spec: {
      usage: `${resource.name} add <id> [<collaborator id>…] [--stdin] [options]`,
      summary: `Add people to one of the ${resource.name} by their ids, in one request. Sends POST ${route.path}.`,
      short: `Add people to one of the ${resource.name}`,
      group: 'Records',
      options: PIPE_OPTIONS,
      flags: PIPE_FLAGS,
      examples: [`siren collaborators list --ids | siren ${resource.name} add 5 --stdin --yes`],
      positionals: [1, 100000],
      run: (input) => sendAdd(input, resource, route),
    },
  };
}

/** The ids typed after the command, then those read from standard input with --stdin, each a whole number. */
async function idsOf(input: CommandInput, typed: readonly string[], words: string): Promise<number[]> {
  const piped = input.values.stdin === true ? (await input.io.readStdin()).split(/\s+/) : [];
  const given = [...typed, ...piped].map((id) => id.trim()).filter((id) => id !== '');
  for (const id of given) if (!/^\d+$/.test(id)) throw new CliUsageError(`${JSON.stringify(id)} is not a record id. Give the ids Siren lists, such as 7.`);
  if (given.length === 0) throw new CliUsageError(`Give the ids, or pipe them in with --stdin, as siren ${words.split(' ')[0]} list --ids prints them.`);
  return [...new Set(given.map(Number))];
}

/** A yes for a change to many records: --yes, or a typed yes in a terminal. Standard input that carried ids is no terminal. */
async function confirmMany(input: CommandInput, run: CommandContext, question: string, again: string): Promise<void> {
  if (input.values.yes === true) return;
  if (input.values.stdin === true || !input.io.interactive) {
    throw new CliRefusal('Nothing was sent.', { why: 'A change to many records needs a yes, and there is no terminal to ask in.', fix: run.command(again), fixWords: 'to send it without asking' });
  }
  const typed = (await input.io.prompt(`${question} [y/N] `)).trim().toLowerCase();
  if (typed !== 'y' && typed !== 'yes') throw new CliRefusal('Nothing was sent.', { why: "You didn't answer yes.", fix: run.command(again), fixWords: 'to send it without asking' });
}

/** The -d fields as a body, each read by its type. */
function extraFields(input: CommandInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of pairs(input)) setNested(body, key, fieldValue(value));
  return body;
}

/** The line to run again with --yes. */
function againLine(input: CommandInput, words: string, lead: readonly string[], typedIds: readonly string[]): string {
  const ids = input.values.stdin === true ? ' --stdin' : typedIds.length > 0 ? ` ${typedIds.join(' ')}` : '';
  const extra = pairs(input).map(([key, value]) => ` -d ${shellWord(`${key}=${value}`)}`).join('');
  return `${words}${lead.length > 0 ? ` ${lead.join(' ')}` : ''}${ids}${extra} --yes`;
}

/** Prints the requests a --dry-run would send. */
function printDryRun(input: CommandInput, run: CommandContext, bodies: ReadonlyArray<{ path: string; body: Record<string, unknown> }>): void {
  if (input.values.json === true) {
    run.print(JSON.stringify(bodies.map(({ path, body }) => ({ method: 'POST', url: urlOf(run.target.baseUrl, { method: 'POST', path, query: {}, body }), body })), null, 2));
    return;
  }
  const style = styleFor(input.io, 'stdout', {});
  for (const { path, body } of bodies) input.io.stdout(`Would send ${style.bold(`POST ${urlOf(run.target.baseUrl, { method: 'POST', path, query: {}, body })}`)}\n  ${JSON.stringify(body)}\n`);
  // What would go out is the answer, on standard output, and the note beside it is chatter, on standard error (review round 1, C12).
  input.io.stderr('Nothing was sent.\n');
}

function transportOf(input: CommandInput, run: CommandContext) {
  return createHttpTransport({
    accessToken: new CallbackAccessTokenSource(
      () => run.accessToken(),
      () => run.refresh(),
    ),
    httpClient: input.io.httpClient,
    baseUrl: run.target.baseUrl,
  });
}

/** Siren's refusal of a pipe write, as the record commands give it. */
function pipeRefusal(error: unknown, input: CommandInput, resource: ResourceCommand, path: string, words: string): never {
  if (!(error instanceof SirenError) || error.statusCode === undefined) throw error;
  throw refusalOf(error, { outgoing: { method: 'POST', path, query: {}, body: undefined }, resource, words }, input);
}

async function sendBulk(input: CommandInput, resource: ResourceCommand, bulk: NonNullable<ResourceCommand['bulk']>): Promise<number> {
  const run = contextOf(input);
  const [action, ...typed] = input.args as [string, ...string[]];
  const words = `${resource.name} bulk`;
  if (!bulk.actions.includes(action)) throw new CliUsageError(`${words} takes ${orList(bulk.actions)}, and ${JSON.stringify(action)} isn't one.`);
  const ids = await idsOf(input, typed, words);
  const extra = extraFields(input);
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  for (let at = 0; at < ids.length; at += BULK_CHUNK) bodies.push({ path: bulk.path, body: { action, ids: ids.slice(at, at + BULK_CHUNK), ...extra } });
  if (input.values['dry-run'] === true) {
    printDryRun(input, run, bodies);
    return 0;
  }
  await run.signedIn();
  const many = `${ids.length} ${ids.length === 1 ? singular(resource.name) : resource.name}`;
  await confirmMany(input, run, `Run ${action} on ${many} in ${orgLabel(run)}?`, againLine(input, words, [action], typed));
  const transport = transportOf(input, run);
  const answers: unknown[] = [];
  let changed: number | undefined = 0;
  for (const { path, body } of bodies) {
    try {
      const answer = await parseJsonBody(await transport.request({ method: 'POST', path, body, retriable: false }));
      answers.push(answer);
      const affected = isObject(answer) && typeof answer.affected === 'number' ? answer.affected : undefined;
      changed = changed === undefined || affected === undefined ? undefined : changed + affected;
    } catch (error) {
      if (answers.length > 0) input.io.stderr(`siren: ${answers.length} of ${bodies.length} requests went through before Siren refused one.\n`);
      pipeRefusal(error, input, resource, path, words);
    }
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(answers, null, 2));
    return 0;
  }
  const requests = bodies.length > 1 ? `, in ${bodies.length} requests` : '';
  run.print(`Siren ran ${action} on ${many}${requests}${changed === undefined ? '.' : `, and ${changed} changed.`}`);
  return 0;
}

async function sendAdd(input: CommandInput, resource: ResourceCommand, route: { path: string; key: string; max: number }): Promise<number> {
  const run = contextOf(input);
  const [id, ...typed] = input.args as [string, ...string[]];
  if (!/^\d+$/.test(id)) throw new CliUsageError(`${JSON.stringify(id)} is not a record id. Give the id Siren lists, such as 7.`);
  const words = `${resource.name} add`;
  const ids = await idsOf(input, typed, 'collaborators add');
  if (ids.length > route.max) throw new CliUsageError(`Siren adds at most ${route.max} people a request, and ${ids.length} were given. Split them, or pipe them in parts.`);
  const path = route.path.replace('{id}', id);
  const body = { members: ids.map((member) => ({ [route.key]: member })), ...extraFields(input) };
  if (input.values['dry-run'] === true) {
    printDryRun(input, run, [{ path, body }]);
    return 0;
  }
  await run.signedIn();
  const what = `${singular(resource.name).replace(/-/g, ' ')} ${id}`;
  await confirmMany(input, run, `Add ${ids.length} ${ids.length === 1 ? 'person' : 'people'} to ${what} in ${orgLabel(run)}?`, againLine(input, words, [id], typed));
  let answer: unknown;
  try {
    answer = await parseJsonBody(await transportOf(input, run).request({ method: 'POST', path, body, retriable: false }));
  } catch (error) {
    pipeRefusal(error, input, resource, path, words);
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(answer, null, 2));
    return 0;
  }
  const added = Array.isArray(answer) ? answer.length : isObject(answer) && Array.isArray(answer.data) ? answer.data.length : undefined;
  if (added === undefined) {
    run.print(`Added ${ids.length} ${ids.length === 1 ? 'person' : 'people'} to ${what}.`);
    return 0;
  }
  const already = ids.length - added;
  run.print(`Added ${added} ${added === 1 ? 'person' : 'people'} to ${what}.${already > 0 ? ` ${already} ${already === 1 ? 'was' : 'were'} in it already.` : ''}`);
  return 0;
}
