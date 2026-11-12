import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchHttpClient, HttpClientError, type HttpRequest } from '../src/index';

/*
 * Unit tests for the internals of FetchHttpClient.send that the P3
 * acceptance tests do not pin: the message and cause of a wrapped failure,
 * and the timeout timer being cleared once the body is read.
 */

const TOKEN = 'tok-secret-123';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    url: 'http://127.0.0.1:9/siren/v1/event/sale',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    body: '{}',
    timeout: 5_000,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FetchHttpClient internals', () => {
  it('keeps the fetch error itself as cause and quotes its message', async () => {
    const fault = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const fetchFn = vi.fn(async () => {
      throw fault;
    });

    const error = await rejection(new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request()));

    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).cause).toBe(fault);
    expect((error as HttpClientError).message).toContain('connect ECONNREFUSED 127.0.0.1:9');
  });

  it('quotes a rejection that is not an Error', async () => {
    const fetchFn = vi.fn(async () => {
      throw 'socket hang up';
    });

    const error = await rejection(new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request()));

    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).cause).toBe('socket hang up');
    expect((error as HttpClientError).message).toContain('socket hang up');
  });

  it('keeps the request headers out of the error message', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    const error = await rejection(new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request()));

    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).message).not.toContain(TOKEN);
  });

  it('wraps a failure while reading the body, with that failure as cause', async () => {
    const fault = new TypeError('terminated');
    const reply = {
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => {
        throw fault;
      },
    };
    const fetchFn = vi.fn(async () => reply);

    const error = await rejection(new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request()));

    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).cause).toBe(fault);
    expect((error as HttpClientError).message).toContain('terminated');
  });

  it('clears the timeout timer once the reply is read', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));

    await new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request());

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout timer when fetch rejects', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    await rejection(new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request()));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands fetch a signal that aborts when the timeout runs out', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const pending = rejection(
      new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request({ timeout: 250 })),
    );
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    const error = await pending;

    expect(seen?.aborted).toBe(true);
    expect(error).toBeInstanceOf(HttpClientError);
  });

  it('sends with redirect manual', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));

    await new FetchHttpClient(fetchFn as unknown as typeof fetch).send(request());

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('manual');
  });
});
