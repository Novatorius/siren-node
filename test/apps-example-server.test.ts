import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAcmeApp, createRequestListener } from '../examples/apps/acme/handler.mjs';
import { Siren } from '../src/client';
import type { HttpResponse } from '../src/http';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * The example app keeps serving when one request goes wrong. An ask it
 * cannot answer gets an error status and a logged line saying why, and no
 * guessed answer, so Siren sends it again on its deadline and then marks it
 * as needing attention. The server's request listener answers 500 for
 * anything the handler throws, and the next request is served as usual.
 */

interface SignedFixture {
  secret: string;
  timestamp: number;
  body: string;
  headers: Record<string, string>;
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8'),
) as SignedFixture;
const BAD_ID = 'apr_0123456789abcdef0123456789abcdef';

/** Siren's fixture with its feature and data changed, signed again with the fixture's secret. */
function signed(change: (request: Record<string, unknown>) => void): { body: string; headers: Record<string, string> } {
  const request = JSON.parse(fixture.body) as Record<string, unknown>;
  change(request);
  const body = JSON.stringify(request);
  const v1 = createHmac('sha256', fixture.secret).update(`${fixture.timestamp}.${body}`).digest('hex');
  return { body, headers: { ...fixture.headers, 'X-Siren-Signature-V2': `t=${fixture.timestamp},v1=${v1}`, 'X-Siren-Delivery': `${BAD_ID}.1` } };
}

function acme(replies: Array<HttpResponse | Error>) {
  const http = new FakeHttpClient(replies);
  const lines: string[] = [];
  const siren = new Siren({ apiKey: `sk_test_${'0a'.repeat(32)}`, baseUrl: BASE, httpClient: http, maxRetries: 0 });
  const app = createAcmeApp({ siren, signingSecret: fixture.secret, now: () => fixture.timestamp, log: (line) => lines.push(line) });
  return { http, app, lines };
}

/** Drives a node:http request listener with a body and headers, and answers what it wrote. */
async function serve(listener: ReturnType<typeof createRequestListener>, body: string, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { headers });
  return new Promise<{ status: number; body: string }>((resolve) => {
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(text?: string) {
        resolve({ status, body: text ?? '' });
      },
    };
    listener(req as never, res as never);
  });
}

describe('apps-cli: the example app keeps serving', () => {
  it('answers an ask it cannot answer with 500 and a line that says why, posts no guess, and serves the next request', async () => {
    const { http, app, lines } = acme([reply(200, { status: 'accepted' })]);
    const pool = signed((request) => {
      request.id = BAD_ID;
      request.feature = { kind: 'distributionResolver', key: 'acme-split', id: 'app:13' };
      request.data = { amount: 1000, currency: 'USD' };
    });
    const first = await app.handle(pool.body, pool.headers);
    expect(first.status).toBe(500);
    expect(lines.join('\n')).toContain(BAD_ID);
    expect(lines.join('\n')).toMatch(/metrics/);

    const payout = signed((request) => {
      request.id = BAD_ID;
      request.data = { amount: { value: 2500, units: 'USD' } };
    });
    expect((await app.handle(payout.body, payout.headers)).status).toBe(500);
    expect(lines.join('\n')).toMatch(/data\.payout\.id/);

    expect((await app.handle(pool.body, pool.headers)).status).toBe(500);
    expect(http.requests).toHaveLength(0);

    const ask = signed((request) => {
      request.data = { payout: { id: 88, fulfillmentId: 31, attempt: 1 }, amount: { value: 2500, units: 'USD' } };
    });
    const good = await app.handle(ask.body, ask.headers);
    expect(good.status).toBe(200);
    await good.answered;
    expect(http.requests).toHaveLength(1);
  });

  it("the server's listener answers 500 for a request the handler throws on, logs why, and keeps serving", async () => {
    const lines: string[] = [];
    let calls = 0;
    const app = {
      async handle() {
        calls += 1;
        if (calls === 1) throw new Error('the store is down');
        return { status: 200, body: '{"received":true}' };
      },
    };
    const listener = createRequestListener(app, (line: string) => lines.push(line));
    const broken = await serve(listener, fixture.body, fixture.headers);
    expect(broken.status).toBe(500);
    expect(lines.join('\n')).toContain('the store is down');
    const next = await serve(listener, fixture.body, fixture.headers);
    expect(next).toEqual({ status: 200, body: '{"received":true}' });
  });
});
