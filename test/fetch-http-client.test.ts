import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FetchHttpClient, HttpClientError, type HttpRequest } from '../src/index';

/*
 * Slice 2 acceptance tests for packet P3: FetchHttpClient.
 *
 * Integration shape (KB 568): the real client over the real global fetch,
 * against a real HTTP server on 127.0.0.1, so the method, headers, body and
 * timeout are checked where the server receives them.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else here.
 */

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let base: string;
let received: Received[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_req, res) => res.end();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  received = [];
  handler = (_req, res) => res.end();
  vi.unstubAllGlobals();
});

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    url: `${base}/siren/v1/event/sale?probe=1`,
    headers: {
      Authorization: 'Bearer tok-1',
      Accept: 'application/json',
      'User-Agent': 'siren-sdk-typescript/0.3.0',
      'Content-Type': 'application/json',
    },
    body: '{"source":"medusa","externalId":"order_1"}',
    timeout: 5_000,
    ...overrides,
  };
}

describe('P3: FetchHttpClient', () => {
  it.skip('sends the method, URL, headers and body as given', async () => {
    await new FetchHttpClient().send(request());

    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.method).toBe('POST');
    expect(got.url).toBe('/siren/v1/event/sale?probe=1');
    expect(got.headers.authorization).toBe('Bearer tok-1');
    expect(got.headers.accept).toBe('application/json');
    expect(got.headers['user-agent']).toBe('siren-sdk-typescript/0.3.0');
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.body).toBe('{"source":"medusa","externalId":"order_1"}');
  });

  it.skip('sends a GET with no body', async () => {
    await new FetchHttpClient().send(
      request({ method: 'GET', url: `${base}/siren/v1/conversions/7`, body: undefined }),
    );

    expect(received[0]!.method).toBe('GET');
    expect(received[0]!.body).toBe('');
  });

  it.skip('answers with the status, status text, lower-case headers and body text', async () => {
    handler = (_req, res) => {
      res.writeHead(201, 'Made It', { 'X-Siren-OID': '42', 'Content-Type': 'application/json' });
      res.end('{"status":"created"}');
    };

    const response = await new FetchHttpClient().send(request());

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Made It');
    expect(response.headers['x-siren-oid']).toBe('42');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.body).toBe('{"status":"created"}');
  });

  it.skip('answers 4xx and 5xx replies instead of rejecting', async () => {
    let status = 401;
    handler = (_req, res) => {
      res.writeHead(status, { 'Retry-After': '3' });
      res.end('{"error":"nope"}');
    };
    const client = new FetchHttpClient();

    const unauthorized = await client.send(request());
    status = 503;
    const unavailable = await client.send(request());

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toBe('{"error":"nope"}');
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('3');
  });

  it.skip('answers an empty body as an empty string', async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };

    const response = await new FetchHttpClient().send(request());

    expect(response.status).toBe(204);
    expect(response.body).toBe('');
  });

  it.skip('rejects with HttpClientError, carrying the fetch error as cause, when nothing answers', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = await new FetchHttpClient()
      .send(request({ url: `http://127.0.0.1:${port}/siren/v1/ping` }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).cause).toBeInstanceOf(Error);
  });

  it.skip('rejects with HttpClientError when the timeout runs out', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('late'), 2_000).unref();
    };

    const started = Date.now();
    const error = await new FetchHttpClient()
      .send(request({ timeout: 100 }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(HttpClientError);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it.skip('calls the fetch it was given, with the headers as the same plain object', async () => {
    const given = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const built = request();

    const response = await new FetchHttpClient(given as unknown as typeof fetch).send(built);

    expect(given).toHaveBeenCalledTimes(1);
    const [url, init] = given.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(built.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(built.headers);
    expect(init.headers).not.toBeInstanceOf(Headers);
    expect(init.body).toBe(built.body);
    expect(response.body).toBe('{"ok":true}');
    expect(received).toHaveLength(0);
  });

  it.skip('reads the global fetch at send time when none was given', async () => {
    const client = new FetchHttpClient();
    const replaced = vi.fn(async () => new Response('late-bound', { status: 200 }));
    vi.stubGlobal('fetch', replaced);

    const response = await client.send(request());

    expect(replaced).toHaveBeenCalledTimes(1);
    expect(response.body).toBe('late-bound');
    expect(received).toHaveLength(0);
  });
});
