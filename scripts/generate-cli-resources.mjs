#!/usr/bin/env node
/**
 * Writes src/cli/resources.generated.ts from openapi.json, Siren's spec.
 *
 * Each tag in the spec is a resource, and the command `siren <resource> <op>`
 * sends one of five routes when the spec has it:
 *
 *   list    GET    /<resource>
 *   get     GET    /<resource>/{param}
 *   create  POST   /<resource>
 *   update  PUT or PATCH /<resource>/{param}
 *   delete  DELETE /<resource>/{param}
 *
 * Only routes the spec marks as running on Siren Cloud (`x-siren-platforms`)
 * become commands, so WordPress-only routes such as /settings do not. Tags
 * that hand-written commands own (apps, auth, notes, condition sets, enrollers and the developer tools) are left
 * out, as are tags whose name is already a command. Siren keeps operator and sandbox routes out of
 * the public spec, and the operator mark is still checked here.
 *
 * DELETE_ROUTES lists every DELETE route with the parameter that names its
 * record, so `siren delete <path>` can tell which part of a path is the id.
 *
 * Usage: node scripts/generate-cli-resources.mjs [--check]
 *
 * test/cli-resources-generated.test.ts runs generate() and fails when the
 * checked-in file differs, so a new openapi.json needs this script run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tags whose commands are written by hand, or that name a command already.
 * The developer tools own their routes: `siren listen` the listen sessions,
 * `siren logs tail` the log feed, `siren trigger` and `siren simulate` the
 * test activity and simulation routes, and `siren sandbox` and `siren seed`
 * the sandbox routes. A generated command beside them would shadow the word
 * or send the same route a second way.
 */
export const SKIPPED_TAGS = [
  'apps', 'auth', 'get', 'post', 'put', 'patch', 'delete', 'help', 'version', 'login', 'logout', 'signup', 'whoami', 'orgs', 'use',
  'listen', 'listen-sessions', 'logs', 'trigger', 'test-activity', 'simulate', 'simulations', 'fixtures', 'sandbox', 'seed',
  'notes', 'condition-sets', 'enrollers', 'enroller-triggers', 'recipes', 'resources',
];

const OPS = ['list', 'get', 'create', 'update', 'delete'];

/** The names of a path's `{params}`. */
function params(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/** Whether a command may send this operation: Siren Cloud has it, and it is not for operators. */
function runsOnCloud(operation) {
  return (operation['x-siren-platforms'] ?? []).includes('cloud') && operation['x-siren-operator-only'] !== true;
}

/** Every DELETE route, with the last path parameter, which names the record it deletes. */
function deleteRoutes(spec) {
  return Object.keys(spec.paths)
    .filter((path) => spec.paths[path].delete !== undefined && spec.paths[path].delete['x-siren-operator-only'] !== true)
    .sort()
    .map((path) => {
      const names = params(path);
      return names.length > 0 ? { path, param: names[names.length - 1] } : { path };
    });
}

/** The query parameters the tool sends from its own flags: --limit, --offset and --fields. */
const CONTROL_QUERY = ['number', 'offset', 'fields'];

/** The bulk route of a resource, `POST /<tag>/bulk {action, ids}`, with the actions it takes. */
function bulkRoute(spec, tag) {
  const path = `/${tag}/bulk`;
  const operation = spec.paths[path]?.post;
  if (!operation || !runsOnCloud(operation)) return undefined;
  const actions = operation.requestBody?.content?.['application/json']?.schema?.properties?.action?.enum;
  return Array.isArray(actions) && actions.length > 0 ? { path, actions: [...actions] } : undefined;
}

/** One route as the generated file holds it. */
function route(method, path, operation) {
  const entry = { method, path };
  const [param] = params(path);
  if (param !== undefined) entry.param = param;
  const query = (operation.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
  if (query.length > 0) entry.query = query;
  if (query.includes('number') && query.includes('offset')) entry.paginated = true;
  // A read's query parameters, with the type or values openapi gives, become the list's filter flags.
  if (method === 'GET') {
    const filters = (operation.parameters ?? [])
      .filter((p) => p.in === 'query' && !CONTROL_QUERY.includes(p.name))
      .map((p) => {
        const values = Array.isArray(p.schema?.enum) ? [...new Set(p.schema.enum.map(String))] : undefined;
        const type = ['integer', 'number', 'boolean'].includes(p.schema?.type) ? p.schema.type : 'string';
        return values ? { name: p.name, type, values } : { name: p.name, type };
      });
    if (filters.length > 0) entry.filters = filters;
  }
  const body = operation.requestBody?.content?.['application/json']?.schema;
  if (body?.properties) entry.fields = Object.keys(body.properties);
  if (body?.required?.length) entry.required = [...body.required];
  return entry;
}

/** The generated file's text for this spec text. */
export function generate(specText) {
  const spec = JSON.parse(specText);
  const resources = [];
  for (const tag of (spec.tags ?? []).map((t) => t.name).sort()) {
    if (SKIPPED_TAGS.includes(tag)) continue;
    const ops = {};
    const one = Object.keys(spec.paths).filter((path) => new RegExp(`^/${tag}/\\{[^}/]+\\}$`).test(path));
    const pick = (path, method) => {
      const operation = spec.paths[path]?.[method];
      return operation && runsOnCloud(operation) ? route(method.toUpperCase(), path, operation) : undefined;
    };
    const candidates = {
      list: () => pick(`/${tag}`, 'get'),
      get: () => one.map((path) => pick(path, 'get')).find(Boolean),
      create: () => pick(`/${tag}`, 'post'),
      update: () => one.map((path) => pick(path, 'put') ?? pick(path, 'patch')).find(Boolean),
      delete: () => one.map((path) => pick(path, 'delete')).find(Boolean),
    };
    for (const op of OPS) {
      const found = candidates[op]();
      if (found) ops[op] = found;
    }
    const bulk = bulkRoute(spec, tag);
    if (Object.keys(ops).length > 0) resources.push({ name: tag, ops, ...(bulk ? { bulk } : {}) });
  }

  const deletes = deleteRoutes(spec);

  return [
    '// Generated by scripts/generate-cli-resources.mjs from openapi.json. Do not edit by hand.',
    '// Run node scripts/generate-cli-resources.mjs after openapi.json changes.',
    '',
    '/** One route a generated command sends, as openapi.json describes it. */',
    'export interface ResourceRoute {',
    "  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';",
    '  /** The path after /siren/v1, with its parameter in braces. */',
    '  readonly path: string;',
    '  /** The path parameter the id fills, when the path has one. */',
    '  readonly param?: string;',
    '  /** The query parameters Siren reads on this route. */',
    '  readonly query?: readonly string[];',
    '  /** True when the route pages its list with number and offset. */',
    '  readonly paginated?: boolean;',
    "  /** A read's query parameters, each with its type or the values it takes, which become a list's filter flags. */",
    "  readonly filters?: readonly { readonly name: string; readonly type: 'string' | 'integer' | 'number' | 'boolean'; readonly values?: readonly string[] }[];",
    '  /** The body fields Siren validates. */',
    '  readonly fields?: readonly string[];',
    '  /** The body fields Siren requires. */',
    '  readonly required?: readonly string[];',
    '}',
    '',
    '/** The operations of one generated resource command. */',
    "export type ResourceOp = 'list' | 'get' | 'create' | 'update' | 'delete';",
    '',
    '/** One resource: `siren <name> <op>`. */',
    'export interface ResourceCommand {',
    '  readonly name: string;',
    '  readonly ops: Readonly<Partial<Record<ResourceOp, ResourceRoute>>>;',
    '  /** `POST /<name>/bulk {action, ids}`, when Siren has one, with the actions it takes. */',
    '  readonly bulk?: { readonly path: string; readonly actions: readonly string[] };',
    '}',
    '',
    `/** Every generated resource, by name, from openapi.json (${resources.length} resources). */`,
    `export const RESOURCE_COMMANDS: readonly ResourceCommand[] = ${JSON.stringify(resources, null, 2)};`,
    '',
    '/** One DELETE route, with the path parameter that names the record it deletes, when it has one. */',
    'export interface DeleteRoute {',
    '  readonly path: string;',
    '  readonly param?: string;',
    '}',
    '',
    `/** Every DELETE route in openapi.json (${deletes.length} routes). */`,
    `export const DELETE_ROUTES: readonly DeleteRoute[] = ${JSON.stringify(deletes, null, 2)};`,
    '',
  ].join('\n');
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
export const SPEC_PATH = join(root, 'openapi.json');
export const OUTPUT_PATH = join(root, 'src', 'cli', 'resources.generated.ts');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = generate(readFileSync(SPEC_PATH, 'utf8'));
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT_PATH, 'utf8');
    if (current !== text) {
      process.stderr.write('src/cli/resources.generated.ts differs from openapi.json. Run node scripts/generate-cli-resources.mjs.\n');
      process.exit(1);
    }
    process.stdout.write('src/cli/resources.generated.ts matches openapi.json.\n');
  } else {
    writeFileSync(OUTPUT_PATH, text);
    process.stdout.write(`Wrote ${OUTPUT_PATH}.\n`);
  }
}
