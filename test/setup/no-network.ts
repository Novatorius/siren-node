import { afterEach, beforeEach, expect, vi } from 'vitest';

/*
 * No test may reach the network. Every test file runs with this guard in
 * place of the global fetch: a request to this machine (127.0.0.1, ::1 or
 * localhost) goes through, as the FetchHttpClient tests need, and any other
 * request throws and fails the test after it ends, even when the code under
 * test caught the throw. A test that installs its own fetch replaces the
 * guard for that test only.
 *
 * It covers only the global fetch, the one way the SDK sends today. A
 * packet that adds another way to send, such as `node:https`, extends it.
 */

const realFetch = globalThis.fetch;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const offMachine = vi.fn((_host: string) => undefined);

function hostOf(input: unknown): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string } | undefined)?.url;
  try {
    return new URL(String(href)).hostname;
  } catch {
    return '';
  }
}

/** The hosts the guard refused in the current test, cleared as it reads them. Only the guard's own test calls it. */
export function takeRefusedHosts(): string[] {
  const hosts = offMachine.mock.calls.map(([host]) => host);
  offMachine.mockClear();
  return hosts;
}

function install(): void {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    if (LOOPBACK.has(hostOf(input))) return realFetch(input as string, init);
    offMachine(hostOf(input));
    throw new Error('A test called the global fetch for a host off this machine. No test may reach the network.');
  });
}

// At load, so module scope and beforeAll in the test file see the guard too.
install();

beforeEach(() => {
  install();
});

afterEach(() => {
  const hosts = takeRefusedHosts();
  vi.unstubAllGlobals();
  install();
  expect(hosts, 'hosts a test tried to reach through the global fetch').toEqual([]);
});
