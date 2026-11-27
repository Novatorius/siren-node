import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import type { HttpClient, HttpRequest } from '../src/http';
import { reply } from './http-fakes';

/*
 * Every request the SDK's resources send names a route in openapi.json,
 * Siren's spec. Each resource method is called with a few plain argument
 * lists, and the requests that leave are recorded. Path parameters match
 * by position, so `/programs/1` matches `/programs/{id}`.
 *
 * KNOWN_UNSERVED lists the calls Siren does not serve and the SDK still
 * makes, each with why it stays. The test holds the list exact, so a new
 * drift fails here and a fixed one must leave the list.
 */

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };

const routes = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.keys(methods).map((method) => ({ method: method.toUpperCase(), pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`) })),
);

/** Whether Siren's spec has this method on this path. */
function served(method: string, path: string): boolean {
  return routes.some((route) => route.method === method && route.pattern.test(path));
}

/**
 * Calls the SDK makes that Siren does not serve, as `METHOD /path` with
 * `{id}` for any one segment. Each stays for the reason beside it.
 */
const KNOWN_UNSERVED: Record<string, string> = {
};

/** The known entry a sent line falls under, if any. */
function knownAs(line: string): string | undefined {
  return Object.keys(KNOWN_UNSERVED).find((known) => new RegExp(`^${known.replace(/\{id\}/g, '[^/]+')}$`).test(line));
}

/** Argument lists tried on each method, until one sends. */
const ATTEMPTS: unknown[][] = [[], [1], [1, {}], ['acme-app'], ['acme-app', {}], [{}], [1, 1], ['apr_0123456789abcdef0123456789abcdef'], [{ name: 'x' }], [[1]], ['sale', {}], ['acme-app', 'acme-ledger'], ['acme-app', { kind: 'payoutMethod', key: 'acme-ledger', name: 'Ledger' }], ['acme-app', 'acme-ledger', { name: 'Ledger' }], ['acme-app', 1], ['acme-app', 1, { name: 'Ledger' }]];

function methodsOf(target: object): string[] {
  const names = new Set<string>();
  for (let proto = Object.getPrototypeOf(target); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && typeof (target as Record<string, unknown>)[name] === 'function') names.add(name);
    }
  }
  return [...names];
}

/** The SDK's resources, nested ones such as apps.requests included, by their path from the client. */
function resources(siren: Siren): Array<[string, object]> {
  const found: Array<[string, object]> = [];
  const walk = (prefix: string, value: object, depth: number) => {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'http' || typeof child !== 'object' || child === null || Array.isArray(child)) continue;
      if (Object.getPrototypeOf(child) === Object.prototype) continue;
      const name = prefix ? `${prefix}.${key}` : key;
      found.push([name, child]);
      if (depth < 2) walk(name, child, depth + 1);
    }
  };
  walk('', siren, 0);
  return found;
}

async function probe(): Promise<{ sent: Map<string, string>; silent: string[] }> {
  const sent = new Map<string, string>();
  const silent: string[] = [];
  let current = '';
  const client: HttpClient = {
    send: async (request: HttpRequest) => {
      const path = new URL(request.url).pathname.replace(/^\/siren\/v1/, '');
      const line = `${request.method} ${path}`;
      if (!sent.has(line)) sent.set(line, current);
      return reply(200, {});
    },
  };
  const siren = new Siren({ accessToken: 'token', httpClient: client, baseUrl: 'https://siren.example.com/siren/v1', maxRetries: 0 });

  for (const [name, resource] of resources(siren)) {
    for (const method of methodsOf(resource)) {
      current = `${name}.${method}`;
      const before = sent.size;
      let reached = false;
      for (const args of ATTEMPTS) {
        const count = sent.size;
        try {
          const result = (resource as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
          if (result instanceof Promise) await Promise.race([result.catch(() => undefined), new Promise((done) => setTimeout(done, 50))]);
        } catch {
          // A refusal before sending: try the next argument list.
        }
        if (sent.size > count) reached = true;
      }
      if (!reached && sent.size === before) silent.push(current);
    }
  }
  return { sent, silent };
}

describe("the SDK's requests against Siren's spec", () => {
  it('sends only routes Siren serves, apart from the known list', async () => {
    const { sent } = await probe();
    const unserved = [...sent.keys()].filter((line) => {
      const [method, path] = line.split(' ') as [string, string];
      return !served(method, path);
    });
    const unknown = unserved.filter((line) => knownAs(line) === undefined).map((line) => `${line} (${sent.get(line)})`);
    expect(unknown, `The SDK sends routes Siren's spec lacks:\n${unknown.join('\n')}`).toEqual([]);
    expect(Object.keys(KNOWN_UNSERVED).filter((known) => !unserved.some((line) => knownAs(line) === known)), 'KNOWN_UNSERVED names a call that is now served or no longer sent. Remove it.').toEqual([]);
  });

  it('reaches most of the SDK with the probe', async () => {
    const { sent } = await probe();
    expect(sent.size).toBeGreaterThan(60);
  });
});
