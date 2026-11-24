import { readFileSync } from 'node:fs';

/*
 * The routes in openapi.json, Siren's generated spec, for the docs tests
 * that once read words from the hand-written openapi.yaml. The generated
 * spec carries routes, methods and schemas, not prose, so those tests now
 * check that each route they named is one Siren serves.
 */

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

/** Whether openapi.json has this method on this path. Path parameters match by position, so `{id}` matches `{app}`. */
export function specServes(method: string, path: string): boolean {
  const shape = (value: string) => value.replace(/\{[^}]+\}/g, '{}');
  return Object.entries(spec.paths).some(([key, methods]) => shape(key) === shape(path) && method.toLowerCase() in methods);
}

type Operation = {
  parameters?: Array<{ name: string; in: string }>;
  requestBody?: { content?: { 'application/json'?: { schema?: { properties?: Record<string, unknown> } } } };
};

function operationOf(method: string, path: string): Operation | undefined {
  const shape = (value: string) => value.replace(/\{[^}]+\}/g, '{}');
  const key = Object.keys(spec.paths).find((candidate) => shape(candidate) === shape(path));
  return key === undefined ? undefined : (spec.paths[key]![method.toLowerCase()] as Operation | undefined);
}

/** The query parameters openapi.json names on a route. */
export function specQuery(method: string, path: string): string[] {
  return (operationOf(method, path)?.parameters ?? []).filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name);
}

/** The body fields openapi.json names on a route. */
export function specBodyFields(method: string, path: string): string[] {
  return Object.keys(operationOf(method, path)?.requestBody?.content?.['application/json']?.schema?.properties ?? {});
}
