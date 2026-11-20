import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import { SirenError } from '../src/errors';
import type { AppRequestHandlerOptions } from '../src/resources/app-request-handler';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf, pathOf } from './record-fakes';

/*
 * The ways to mount `apps.requestHandler()`, packet apps-answer-handler.
 * Contract: docs/architecture/apps-request-handler.md, "Mounting it" and
 * "Where the work after the reply runs". Each server is real and listens on
 * 127.0.0.1, or is Fastify's own inject(), so nothing leaves the machine.
 * Siren's answer route is the FakeHttpClient behind the client.
 */

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown>; answer: Record<string, unknown> | null }>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const SECRET = (
  JSON.parse(readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8')) as { secret: string }
).secret;
const ID = 'apr_9c60190a4501399d0ae55f041c237b39';

function body(kind: string): string {
  return JSON.stringify(features.kinds[kind]!.request);
}

function signed(raw: string, event = 'app.request'): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  return {
    'Content-Type': 'application/json',
    'X-Siren-Event': event,
    'X-Siren-Timestamp': String(t),
    'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`,
  };
}

function setup(options: Partial<AppRequestHandlerOptions> = {}) {
  const http = new FakeHttpClient([reply(200, { status: 'accepted' })]);
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http });
  const errors: unknown[] = [];
  const tells: unknown[] = [];
  const answers = siren.apps
    .requestHandler({ signingSecret: SECRET, onError: (error) => errors.push(error), ...options })
    .on('postConversionAction', 'tell-the-crm', ({ id }) => {
      tells.push(id);
    })
    .on('distributionResolver', 'split-by-score', () => features.kinds.distributionResolver!.answer as never);
  return { http, answers, errors, tells };
}

/** Waits until `check` passes, for the work an ask does after its reply. */
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

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/siren`;
}

async function post(url: string, raw: string, headers = signed(raw)) {
  const response = await fetch(url, { method: 'POST', headers, body: raw });
  return { status: response.status, headers: response.headers, body: (await response.json()) as unknown };
}

describe('apps-answer-handler: mounts', () => {
  it('node:http: http.createServer(answers) reads the stream, answers a tell, and posts an ask after the reply', async () => {
    const { http, answers, tells } = setup();
    const url = await listen(createServer(answers));
    const tell = await post(url, body('postConversionAction'));
    expect(tell).toMatchObject({ status: 200, body: {} });
    expect(tell.headers.get('cache-control')).toBe('no-store');
    expect(tell.headers.get('content-type')).toBe('application/json');
    expect(tells).toEqual([ID]);
    expect(await post(url, body('distributionResolver'))).toMatchObject({ status: 200, body: {} });
    await eventually(() => expect(http.requests).toHaveLength(1));
    expect(pathOf(http.requests[0])).toBe(`/apps/requests/${ID}/answer`);
    expect(bodyOf(http.requests[0])).toEqual(features.kinds.distributionResolver!.answer);
    const get = await fetch(url);
    expect(get.status).toBe(405);
  });

  it('node:http: answers 413 for a body past 1 MiB without reading the rest', async () => {
    const { answers, tells } = setup();
    const url = await listen(createServer(answers));
    const raw = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
    const result = await post(url, raw);
    expect(result.status).toBe(413);
    expect(tells).toHaveLength(0);
  });

  it("Express: app.post('/siren', express.raw(...), answers) answers from the raw Buffer", async () => {
    const { http, answers, tells } = setup();
    const app = express();
    app.post('/siren', express.raw({ type: 'application/json' }), answers);
    const url = await listen(createServer(app));
    expect(await post(url, body('postConversionAction'))).toMatchObject({ status: 200, body: {} });
    expect(tells).toEqual([ID]);
    expect(await post(url, body('distributionResolver'))).toMatchObject({ status: 200, body: {} });
    await eventually(() => expect(http.requests).toHaveLength(1));
  });

  it('Express: with no body parser, the handler reads the stream itself', async () => {
    const { answers, tells } = setup();
    const app = express();
    app.post('/siren', answers);
    const url = await listen(createServer(app));
    expect(await post(url, body('postConversionAction'))).toMatchObject({ status: 200, body: {} });
    expect(tells).toEqual([ID]);
  });

  it('Express: behind express.json(), which already ate the body, answers 500 with how to mount it', async () => {
    const { answers, errors, tells } = setup();
    const app = express();
    app.use(express.json());
    app.post('/siren', answers);
    const url = await listen(createServer(app));
    const result = await post(url, body('postConversionAction'));
    expect(result.status).toBe(500);
    const words = (result.body as { error: string }).error;
    expect(words).toContain('Mount the Siren handler before the JSON body parser, or give its route a raw body');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SirenError);
    expect((errors[0] as Error).message).toBe(words);
    expect(tells).toHaveLength(0);
  });

  it("Fastify: fastify.register(answers.fastify, { path: '/siren' }) reads raw bytes in its own scope only", async () => {
    const { http, answers, tells } = setup();
    const fastify = Fastify();
    fastify.register(answers.fastify, { path: '/siren' });
    fastify.post('/other', async (request) => ({ parsed: request.body }));
    const tell = await fastify.inject({ method: 'POST', url: '/siren', headers: signed(body('postConversionAction')), payload: body('postConversionAction') });
    expect(tell.statusCode).toBe(200);
    expect(tell.json()).toEqual({});
    expect(tell.headers['cache-control']).toBe('no-store');
    expect(tells).toEqual([ID]);
    const ask = await fastify.inject({ method: 'POST', url: '/siren', headers: signed(body('distributionResolver')), payload: body('distributionResolver') });
    expect(ask.statusCode).toBe(200);
    await eventually(() => expect(http.requests).toHaveLength(1));
    // The parent's routes still get parsed JSON.
    const other = await fastify.inject({ method: 'POST', url: '/other', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' });
    expect(other.json()).toEqual({ parsed: { a: 1 } });
    const get = await fastify.inject({ method: 'GET', url: '/siren' });
    expect(get.statusCode).toBe(405);
    await fastify.close();
  });

  it('Web Request: answers(request) returns a Response, as a Next.js app route or Bun calls it', async () => {
    const { http, answers, tells } = setup();
    const raw = body('postConversionAction');
    const response = await answers(new Request('https://app.example.invalid/siren', { method: 'POST', headers: signed(raw), body: raw }));
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({});
    expect(tells).toEqual([ID]);
    const askRaw = body('distributionResolver');
    const ask = await answers(new Request('https://app.example.invalid/siren', { method: 'POST', headers: signed(askRaw), body: askRaw }));
    expect(ask.status).toBe(200);
    await eventually(() => expect(http.requests).toHaveLength(1));
  });

  it('Web Request: a body already read gets the 500', async () => {
    const { answers, errors } = setup();
    const raw = body('postConversionAction');
    const request = new Request('https://app.example.invalid/siren', { method: 'POST', headers: signed(raw), body: raw });
    await request.json();
    const response = await answers(request);
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
  });

  it("Workers: { fetch: answers } hands the ask's work to ctx.waitUntil on the third argument", async () => {
    const { http, answers } = setup();
    const worker = { fetch: answers };
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };
    const raw = body('distributionResolver');
    const response = await worker.fetch(new Request('https://app.example.invalid/siren', { method: 'POST', headers: signed(raw), body: raw }), {}, ctx);
    expect(response.status).toBe(200);
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(http.requests).toHaveLength(1);
  });

  it('runLater: takes the work instead, for Node and Web, and nothing runs until it calls the work', async () => {
    const queued: Array<() => Promise<void>> = [];
    const { http, answers } = setup({ runLater: (work) => void queued.push(work) });
    const url = await listen(createServer(answers));
    expect((await post(url, body('distributionResolver'))).status).toBe(200);
    const raw = body('distributionResolver');
    const waitUntil = vi.fn();
    expect((await answers(new Request('https://app.example.invalid/siren', { method: 'POST', headers: signed(raw), body: raw }), {}, { waitUntil })).status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(http.requests).toHaveLength(0);
    expect(queued).toHaveLength(2);
    await Promise.all(queued.map((work) => work()));
    expect(http.requests).toHaveLength(2);
  });

  it('handle(): answers { status, headers, body, after } for any other server, and after() does the posting', async () => {
    const { http, answers } = setup();
    const raw = body('distributionResolver');
    const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    expect(result).toEqual({ status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: '{}', after: expect.any(Function) });
    expect(http.requests).toHaveLength(0);
    await result.after!();
    expect(http.requests).toHaveLength(1);
  });
});
