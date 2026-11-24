import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRequest } from '@novatorius/siren/testing';
import { TEST_API_KEY } from './helpers';

/*
 * The README's mount samples, one per server, run as written. Each file in
 * test/mount-samples mounts the handler that test/mount-samples/answers.js
 * builds, and the README carries each file word for word
 * (test/docs-apps-request-handler.test.ts holds the two equal).
 *
 * Only what a sample leaves to the developer is stubbed: `addToCrm`, the two
 * environment variables, and `listen(3000)`, which listens on a free port of
 * 127.0.0.1 instead. The SDK runs from source, node:http and Fastify are
 * real, and the fake Siren behind the global fetch takes the answer an ask
 * posts to Siren Cloud's address, api.sirenaffiliates.com.
 */

const servers = vi.hoisted(() => [] as Array<{ close: () => unknown }>);
const listening = vi.hoisted(() => [] as Array<() => Promise<number>>);

vi.mock('node:http', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('node:http');
  const createServer = ((...args: Parameters<typeof real.createServer>) => {
    const server = real.createServer(...args);
    const listen = server.listen.bind(server);
    // The sample's listen(3000) listens on a free port of 127.0.0.1 instead.
    server.listen = (() => {
      servers.push({ close: () => new Promise((resolve) => server.close(resolve)) });
      listening.push(
        () =>
          new Promise((resolve) => {
            const port = (): void => resolve((server.address() as AddressInfo).port);
            if (server.listening) port();
            else server.once('listening', port);
          }),
      );
      return listen(0, '127.0.0.1');
    }) as typeof server.listen;
    return server;
  }) as typeof real.createServer;
  return { ...real, default: { ...real, createServer }, createServer };
});

vi.mock('fastify', async (importOriginal) => {
  type App = { listen: (options: object) => Promise<string>; server: Server; close: () => Promise<unknown> };
  const real = ((await importOriginal()) as { default: (...args: unknown[]) => App }).default;
  const wrapped = Object.assign((...args: unknown[]) => {
    const app = real(...args);
    const listen = app.listen.bind(app);
    // The sample's port 3000 becomes a free port of 127.0.0.1.
    app.listen = async (options: object) => {
      servers.push({ close: () => app.close() });
      const address = await listen({ ...options, port: 0, host: '127.0.0.1' });
      listening.push(async () => (app.server.address() as AddressInfo).port);
      return address;
    };
    return app;
  }, real);
  return { default: wrapped };
});

// Each sample loads the SDK from source on its first import, which can pass
// Vitest's 5 seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown>; answer: Record<string, unknown> | null }>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const SECRET = 'test-signing-secret-for-the-mount-samples';
const ID = 'apr_9c60190a4501399d0ae55f041c237b39';
const ANSWER_URL = `https://api.sirenaffiliates.com/siren/v1/apps/requests/${ID}/answer`;

let posted: Array<{ url: string; body: unknown }> = [];
let addToCrm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  posted = [];
  vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
  vi.stubEnv('SIREN_SIGNING_SECRET', SECRET);
  addToCrm = vi.fn(async () => undefined);
  vi.stubGlobal('addToCrm', addToCrm);
  const loopback = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname !== 'api.sirenaffiliates.com') return loopback(input, init);
    posted.push({ url, body: JSON.parse(String(init?.body)) as unknown });
    return new Response(JSON.stringify({ status: 'accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  listening.splice(0);
});

/**
 * Siren's request for `kind`, signed by appRequest() from the package's
 * testing entry, the helper the README hands developers, with the
 * fixture's id, app and feature key.
 */
function signed(kind: string): { raw: string; headers: Record<string, string> } {
  const request = features.kinds[kind]!.request as { app: string; item: { key: string } };
  const { rawBody, headers } = appRequest(kind, request.item.key, { id: ID, app: request.app });
  return { raw: rawBody, headers };
}

function webRequest(kind: string): Request {
  const { raw, headers } = signed(kind);
  return new Request('https://acme.example/siren', { method: 'POST', headers, body: raw });
}

async function postTo(port: number, kind: string): Promise<{ status: number; body: unknown }> {
  const { raw, headers } = signed(kind);
  const response = await fetch(`http://127.0.0.1:${port}/siren`, { method: 'POST', headers, body: raw });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function eventually(check: () => void): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (tries > 200) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Imports one mount sample as it is, by name. */
function sample(name: string): Promise<unknown> {
  return import(`./mount-samples/${name}.js`);
}

/** Imports the Next.js sample, which sits where a Next.js app keeps its route. */
function nextRoute(name: string): Promise<unknown> {
  return import(`./mount-samples/app/siren/${name}.js`);
}

const tellData = features.kinds.postConversionAction!.request.data as Record<string, unknown>;
const askAnswer = features.kinds.distributionResolver!.answer;

describe("apps-docs: the README's mount samples, run as written", () => {
  it('node:http: http.createServer(answers) answers a tell and an ask', async () => {
    await sample('node-http');
    const port = await listening.at(-1)!();
    expect(await postTo(port, 'postConversionAction')).toEqual({ status: 200, body: {} });
    expect(addToCrm).toHaveBeenCalledWith(ID, tellData.conversion, tellData.reward);
    expect(await postTo(port, 'distributionResolver')).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toEqual([{ url: ANSWER_URL, body: askAnswer }]));
  });

  it('Fastify: app.register(answers.fastify, { path }) answers a tell and an ask', async () => {
    await sample('fastify');
    const port = await listening.at(-1)!();
    expect(await postTo(port, 'postConversionAction')).toEqual({ status: 200, body: {} });
    expect(addToCrm).toHaveBeenCalledWith(ID, tellData.conversion, tellData.reward);
    expect(await postTo(port, 'distributionResolver')).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toEqual([{ url: ANSWER_URL, body: askAnswer }]));
  });

  it('Next.js: export const POST = answers takes a Request and answers a Response', async () => {
    const { POST } = (await nextRoute('route')) as { POST: (request: Request) => Promise<Response> };
    const tell = await POST(webRequest('postConversionAction'));
    expect([tell.status, await tell.json()]).toEqual([200, {}]);
    expect(addToCrm).toHaveBeenCalledWith(ID, tellData.conversion, tellData.reward);
    const ask = await POST(webRequest('distributionResolver'));
    expect(ask.status).toBe(200);
    await eventually(() => expect(posted).toEqual([{ url: ANSWER_URL, body: askAnswer }]));
  });

  it("Workers: export default { fetch: answers } hands an ask's work to ctx.waitUntil", async () => {
    const worker = (await sample('worker')) as {
      default: { fetch: (request: Request, env: unknown, ctx: { waitUntil: (work: Promise<unknown>) => void }) => Promise<Response> };
    };
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (work: Promise<unknown>) => void waited.push(work) };
    const tell = await worker.default.fetch(webRequest('postConversionAction'), {}, ctx);
    expect(tell.status).toBe(200);
    expect(waited).toHaveLength(0);
    const ask = await worker.default.fetch(webRequest('distributionResolver'), {}, ctx);
    expect(ask.status).toBe(200);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(posted).toEqual([{ url: ANSWER_URL, body: askAnswer }]);
  });

  it('handle(): sends the reply first, then the ask is answered by after()', async () => {
    const { serve } = (await sample('handle')) as {
      serve: (method: string, headers: Record<string, string>, rawBody: string, send: (status: number, headers: Record<string, string>, body: string) => void) => Promise<void>;
    };
    const sent: Array<{ status: number; body: string; postedBefore: number }> = [];
    const send = (status: number, _headers: Record<string, string>, body: string): void => void sent.push({ status, body, postedBefore: posted.length });
    const ask = signed('distributionResolver');
    await serve('POST', ask.headers, ask.raw, send);
    expect(sent).toEqual([{ status: 200, body: '{}', postedBefore: 0 }]);
    expect(posted).toEqual([{ url: ANSWER_URL, body: askAnswer }]);
  });
});
