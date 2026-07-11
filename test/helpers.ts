import { vi, type Mock } from 'vitest';
import { Siren } from '../src/client';
import type { SirenOptions } from '../src/types';

export const TEST_API_KEY = `sk_live_${'a'.repeat(64)}`;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function emptyResponse(status = 200, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string | undefined;
}

export interface TestContext {
  client: Siren;
  fetchMock: Mock;
  calls: () => FetchCall[];
  lastCall: () => FetchCall;
}

/**
 * Build a Siren client backed by a mocked global `fetch` that replays the
 * given responses in order (repeating the last one if exhausted).
 */
export function makeClient(
  responses: Array<Response | Error>,
  options: Partial<SirenOptions> = {},
): TestContext {
  let index = 0;
  const fetchMock = vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('makeClient: no responses configured');
    if (next instanceof Error) throw next;
    // Response bodies are single-use; clone so repeated reads never collide.
    return next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);

  const client = new Siren({ apiKey: TEST_API_KEY, ...options });

  const calls = (): FetchCall[] =>
    fetchMock.mock.calls.map((args) => {
      const [url, init] = args as unknown as [string, RequestInit];
      const rawBody = typeof init?.body === 'string' ? init.body : undefined;
      return {
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: rawBody !== undefined ? (JSON.parse(rawBody) as unknown) : undefined,
        rawBody,
      };
    });

  return {
    client,
    fetchMock,
    calls,
    lastCall: () => {
      const all = calls();
      if (all.length === 0) throw new Error('fetch was never called');
      return all[all.length - 1]!;
    },
  };
}
