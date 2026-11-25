import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveryLine, failureReason, forwardAddress } from '../src/cli/commands/listen';
import { runCli } from '../src/cli/run';
import { Style } from '../src/cli/style';
import type { ListenDelivery } from '../src/cli/commands/listen';
import { LIVE_BASE_URL } from '../src/cli/targets';
import { verifyAppRequest } from '../src/resources/app-requests';
import { appMissing, appRecord } from './apps-siren-answers';
import { NOW_S, harness, session } from './cli-fakes';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';

/*
 * `siren listen` (contract/devtools-listen.md, section 6) against a fake
 * Siren and a real handler on this machine. The handler checks each
 * delivery with the SDK's own verifyRequest, so a header or a byte the
 * command changed fails the test.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8')) as {
  secret: string;
  body: string;
  headers: Record<string, string>;
  eventId: string;
  idempotencyKey: string;
};
const REQUEST = fixture.idempotencyKey;
const KEY = 'acme-payouts';
const SESSION = 'lsn_4k2m9q0a7c1e5b3d8f6a2c4e';
const SECRET = '5e'.repeat(32);

function opened(overrides: Record<string, unknown> = {}) {
  return reply(201, {
    session: {
      id: SESSION,
      app: KEY,
      address: 'https://acme.example/siren',
      events: null,
      forwardTo: 'http://localhost:8787/siren',
      openedAt: '2026-11-24T19:02:11+00:00',
      idleTimeoutSeconds: 30,
      nextPollMs: 1000,
    },
    replaced: false,
    ...overrides,
  });
}

function delivery(overrides: Partial<ListenDelivery> = {}): ListenDelivery {
  return {
    deliveryId: 812,
    claim: 'c_7f1e2a9b4c6d8e0f1a2b3c4d',
    claimedUntil: '2026-11-24T19:02:42+00:00',
    eventType: 'app.request',
    eventId: fixture.eventId,
    attempt: 1,
    request: { id: REQUEST, mode: 'ask', kind: 'payoutMethod', feature: 'acme-ledger' },
    headers: fixture.headers,
    body: fixture.body,
    ...overrides,
  };
}

const polled = (deliveries: ListenDelivery[], answers: unknown[] = []) => reply(200, { deliveries, answers, nextPollMs: 1000 });
const reported = (status = 'delivered', nextRetryAt: string | null = null) => reply(200, { delivery: { id: 812, status, attemptCount: 1, nextRetryAt } });
const closed = (returned = 0) => reply(200, { closed: true, returned });

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server | undefined;

/** A handler on this machine that checks each request with the SDK and answers as `answer` says. */
async function handler(answer: (received: Received) => { status: number; body: string; delayMs?: number }): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      received.push(entry);
      const { status, body, delayMs } = answer(entry);
      setTimeout(() => res.writeHead(status, { 'Content-Type': 'application/json' }).end(body), delayMs ?? 0);
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/siren`, received };
}

afterEach(async () => {
  if (server !== undefined) await new Promise((done) => server!.close(done));
  server = undefined;
});

/** Ctrl-C at the first wait between polls. */
const stopAtFirstWait = { onSleep: (count: number, abort: () => void) => (count === 1 ? abort() : undefined) };

describe('siren listen', () => {
  it("forwards Siren's exact bytes and headers, which the SDK's verifyRequest accepts, and reports the handler's reply", async () => {
    const local = await handler(({ headers, body }) => {
      const checked = verifyAppRequest(body, headers as Record<string, string>, fixture.secret, { now: NOW_S }, 300);
      return { status: checked.id === REQUEST ? 200 : 500, body: '{"received":true}' };
    });
    const h = harness([opened(), polled([delivery()]), reported(), closed()], stopAtFirstWait);
    h.signedIn();

    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url]), h.err()).toBe(0);

    expect(local.received).toHaveLength(1);
    expect(local.received[0]!.body).toBe(fixture.body);
    expect(local.received[0]!.headers['x-siren-signature-v2']).toBe(fixture.headers['X-Siren-Signature-V2']);
    expect(h.paths()).toEqual(['POST /listen-sessions', `POST /listen-sessions/${SESSION}/poll`, `POST /listen-sessions/${SESSION}/results`, `DELETE /listen-sessions/${SESSION}`]);
    expect(bodyOf(h.http.requests[0])).toEqual({ app: KEY, forwardTo: local.url });
    expect(bodyOf(h.http.requests[1])).toEqual({ max: 4 });
    expect(bodyOf(h.http.requests[2])).toMatchObject({ deliveryId: 812, claim: 'c_7f1e2a9b4c6d8e0f1a2b3c4d', httpStatus: 200, body: '{"received":true}', error: null });

    const out = h.out();
    expect(out).toContain(`Listening for ${KEY} in`);
    expect(out).not.toContain('✓');
    expect(out).toMatch(/\d\d:\d\d:\d\d {2}ask {5}acme-ledger {9}200 +\d+ms {2}apr_b79943ff\n/);
    expect(out).toContain(`Stopped listening for ${KEY}`);
    expect(out).toContain('Forwarded   1 delivery, 1 answered 2xx');
    expect(out).toMatch(new RegExp(`Next\\n  1  siren apps requests --app ${KEY} +what Siren did next\\n`));
    for (const line of out.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('prints a ✗ line with the reason and the resend command for a 500, and for a handler that is not running', async () => {
    const local = await handler(() => ({ status: 500, body: '{"error":"The function for payoutMethod acme-ledger failed"}' }));
    const h = harness([opened(), polled([delivery()]), reported('failed', '2026-11-24T19:03:15+00:00'), closed()], stopAtFirstWait);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url]), h.err()).toBe(0);
    expect(h.out()).toMatch(/ask {5}acme-ledger {9}500 /);
    expect(h.out().replace(/\s+/g, ' ')).toContain('The handler answered 500: The function for payoutMethod acme-ledger failed');
    for (const line of h.out().split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    expect(h.out()).toContain(`siren apps resend ${REQUEST}`);
    expect(bodyOf(h.http.requests[2])).toMatchObject({ httpStatus: 500 });

    const gone = harness([opened(), polled([delivery()]), reported('failed'), closed()], stopAtFirstWait);
    gone.signedIn();
    const port = (server!.address() as AddressInfo).port;
    await new Promise((done) => server!.close(done));
    server = undefined;
    expect(await gone.run(['listen', '--app', KEY, '--forward-to', `localhost:${port}/siren`]), gone.err()).toBe(0);
    expect(gone.out()).toMatch(/ask {5}acme-ledger {9}--- /);
    expect(gone.out()).toContain(`Nothing answered at localhost:${port} (connection refused).`);
    expect(gone.out()).toContain('Is your server running?');
    expect(bodyOf(gone.http.requests[2])).toMatchObject({ httpStatus: null, error: `Nothing answered at localhost:${port} (connection refused).` });
  });

  it("shows an ask's answer on the next poll, and a webhook event by its type", async () => {
    const local = await handler(() => ({ status: 200, body: '{}' }));
    const event = delivery({ eventType: 'sale.created', eventId: 'evt_6a1f9c2e00', request: null, headers: { 'Content-Type': 'application/json' }, body: '{"id":1}' });
    const h = harness([opened(), polled([delivery(), event], [{ request: REQUEST, status: 'answered', answeredBy: 'app:12', answeredAt: '2026-11-24T19:02:12+00:00' }]), reported(), reported(), closed()], stopAtFirstWait);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url]), h.err()).toBe(0);
    expect(h.out()).toMatch(/event {3}sale\.created {8}200 .*evt_6a1f9c2e\n/);
    expect(h.out()).toMatch(/answer {2}acme-ledger {9}answered {5}apr_b79943ff\n/);
  });

  it('opens a new session when Siren ended one for silence, and stops with 1 when another listen took over', async () => {
    const local = await handler(() => ({ status: 200, body: '{}' }));
    const idle = reply(410, { error: { code: 'listen_session_ended', message: 'This listen session ended because Siren heard nothing from it for 30 seconds.', context: { reason: 'listen_session_ended', endedBecause: 'idle' } } });
    const h = harness([opened(), idle, opened(), polled([]), closed()], stopAtFirstWait);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /listen-sessions', `POST /listen-sessions/${SESSION}/poll`, 'POST /listen-sessions', `POST /listen-sessions/${SESSION}/poll`, `DELETE /listen-sessions/${SESSION}`]);
    expect(h.out()).toContain('a new one is open');

    const replaced = reply(409, { error: { code: 'listen_session_replaced', message: 'Another siren listen took over this app, so this session ended.', context: { reason: 'listen_session_replaced' } } });
    const taken = harness([opened(), replaced]);
    taken.signedIn();
    expect(await taken.run(['listen', '--app', KEY, '--forward-to', local.url])).toBe(1);
    expect(taken.err()).toContain('Another siren listen took over this app');
  });

  it('stops with what happened, why and what to do when listen was turned off on this Siren', async () => {
    const local = await handler(() => ({ status: 200, body: '{}' }));
    const off = reply(410, {
      error: {
        code: 'listen_session_ended',
        message: "This listen session ended because siren listen was turned off on this Siren. Its deliveries go to the app's address.",
        context: { reason: 'listen_session_ended', endedBecause: 'listen_off' },
      },
    });
    const h = harness([opened(), off]);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url])).toBe(1);
    expect(h.paths()).toEqual(['POST /listen-sessions', `POST /listen-sessions/${SESSION}/poll`]);
    expect(h.err()).toContain(`Siren ended the listen session for ${KEY}.`);
    expect(h.err()).toContain("siren listen was turned off on this Siren, so Siren sends this app's requests to its address now.");
    expect(h.err()).toContain(`Run siren apps requests --app ${KEY} to see where they went.`);
    expect(h.err()).toContain('SIREN_LISTEN_ALLOWED=1');
    expect(h.err()).not.toContain('a new one is open');
  });

  it("reports a result again when Siren could not record it, and warns without stopping when it never can", async () => {
    const local = await handler(() => ({ status: 200, body: '{}' }));
    const failed = () => reply(500, { error: { code: 'internal_error', message: 'Siren could not reach its listen records. Try again.', context: {} } });
    const results = `POST /listen-sessions/${SESSION}/results`;

    const h = harness([opened(), polled([delivery()]), failed(), reported(), closed()], { onSleep: (count: number, abort: () => void) => (count === 2 ? abort() : undefined) });
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /listen-sessions', `POST /listen-sessions/${SESSION}/poll`, results, results, `DELETE /listen-sessions/${SESSION}`]);
    expect(bodyOf(h.http.requests[3])).toEqual(bodyOf(h.http.requests[2]));
    expect(local.received).toHaveLength(1);
    expect(h.out()).toMatch(/ask\s+acme-ledger\s+200/);
    expect(h.err()).toBe('');

    const never = harness([opened(), polled([delivery()]), failed(), failed(), failed(), closed()], { onSleep: (count: number, abort: () => void) => (count === 3 ? abort() : undefined) });
    never.signedIn();
    expect(await never.run(['listen', '--app', KEY, '--forward-to', local.url]), never.err()).toBe(0);
    expect(never.paths().filter((path) => path === results)).toHaveLength(3);
    expect(never.err()).toContain('Siren could not record delivery 812 after 3 tries.');
    expect(never.err()).toContain('Siren counts a failed attempt and sends it again');
  });

  it('in a terminal: a ✓ report to start and stop, ✓ and ✗ lines, and nothing from Siren or the handler reaches the screen raw', async () => {
    const local = await handler(() => ({ status: 500, body: JSON.stringify({ error: 'boom\u001b[2J\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 here' }) }));
    const sly = delivery({ request: { id: `${REQUEST}\u001b[31m`, mode: 'ask', kind: 'payoutMethod', feature: 'acme\u001b[2Jledger\u0007' } });
    const event = delivery({ eventType: 'sale\u001b[1A.created', eventId: 'evt_\u009b2J6a1f', request: null, headers: { 'Content-Type': 'application/json' }, body: '{"id":1}' });
    const h = harness(
      [
        opened({ session: { id: SESSION, app: KEY, address: 'https://acme.example/\u001b[2Jsiren', events: null, forwardTo: null, openedAt: '', idleTimeoutSeconds: 30, nextPollMs: 1000 } }),
        polled([sly, event], [{ request: `${REQUEST}\u001b[31m`, status: 'answered\u001b[5m', answeredBy: 'app:12', answeredAt: null }]),
        reported('failed', '2026-11-24T19:03:15+00:00'),
        reported('failed'),
        closed(),
      ],
      stopAtFirstWait,
    );
    h.signedIn();
    const io = { ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } };
    expect(await runCli(['listen', '--app', KEY, '--forward-to', local.url], io), h.err()).toBe(0);

    const out = h.out();
    // Only the style module's own color codes are left, and no other control character.
    const bare = out.replace(/\u001b\[[\d;]*m/g, '');
    expect(bare).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(bare).toMatch(/^✓ Listening for acme-payouts in /);
    expect(bare).toMatch(/✗ \d\d:\d\d:\d\d {2}ask {5}acmeledger {10}500 /);
    expect(bare).toContain('The handler answered 500: boomclick here');
    expect(bare).toMatch(/› siren apps resend apr_b79943ff/);
    expect(bare).toMatch(/✗ \d\d:\d\d:\d\d {2}event {3}sale\.created/);
    expect(bare).toMatch(/✓ \d\d:\d\d:\d\d {2}answer {2}acmeledger {10}answered {5}apr_b79943ff/);
    expect(bare).toContain('✓ Stopped listening for acme-payouts');
    expect(bare).toContain('Next');
    expect(bare).toContain('https://acme.example/siren');
    for (const line of bare.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  });

  it('prints one JSON object per line with --json', async () => {
    const local = await handler(() => ({ status: 200, body: '{}' }));
    const h = harness([opened(), polled([delivery()]), reported(), closed(2)], stopAtFirstWait);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url, '--json']), h.err()).toBe(0);
    const lines = h.out().trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.type)).toEqual(['session', 'delivery', 'closed']);
    expect(lines[1]).toMatchObject({ kind: 'ask', feature: 'acme-ledger', featureKind: 'payoutMethod', request: REQUEST, deliveryId: 812, httpStatus: 200, ok: true });
    expect(lines[2]).toEqual({ type: 'closed', forwarded: 1, ok: 1, returned: 2 });
  });

  it("writes the signing secret Siren gives an app with no address to .env.sandbox, and never prints it", async () => {
    const local = await handler(() => ({ status: 200, body: '{}' }));
    const h = harness([opened({ signingSecret: SECRET, session: { id: SESSION, app: KEY, address: null, events: null, forwardTo: null, openedAt: '', idleTimeoutSeconds: 30, nextPollMs: 1000 } }), polled([]), closed()], stopAtFirstWait);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', local.url]), h.err()).toBe(0);
    expect(h.file('.env.sandbox')).toContain(`SIREN_SIGNING_SECRET=${SECRET}`);
    expect(h.printed()).not.toContain(SECRET);
    expect(h.out()).toContain('The app has no address');
  });

  it('refuses a bad --forward-to, a missing one with no localhost url, and a missing app, before sending anything', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['listen', '--app', KEY, '--forward-to', 'ftp://x'])).toBe(2);
    expect(await h.run(['listen', '--app', KEY])).toBe(2);
    expect(await h.run(['listen', '--forward-to', 'localhost:8787'])).toBe(2);
    expect(h.paths()).toEqual([]);

    const local = await handler(() => ({ status: 200, body: '{}' }));
    const fromFile = harness([opened(), polled([]), closed()], stopAtFirstWait);
    fromFile.signedIn();
    fromFile.write('siren.app.json', JSON.stringify({ version: 1, apps: { [KEY]: { name: 'Acme', url: local.url, features: { 'acme-ledger': { kind: 'payoutMethod', name: 'Ledger', currencies: ['USD'] } } } } }));
    expect(await fromFile.run(['listen']), fromFile.err()).toBe(0);
    expect(bodyOf(fromFile.http.requests[0])).toEqual({ app: KEY, forwardTo: local.url });
  });

  it('applies an app with SIREN_APP_URL unset on a sandbox, saves its key and secret, and names siren listen next', async () => {
    const rawKey = `sk_test_${'0a'.repeat(32)}`;
    const app = appRecord({ apiKeyPrefix: rawKey.slice(0, 16) });
    const file = JSON.stringify({ version: 1, apps: { [KEY]: { name: 'Acme', url: '${SIREN_APP_URL}', features: { 'acme-ledger': { kind: 'payoutMethod', name: 'Ledger', currencies: ['USD'] } } } } });
    const h = harness([appMissing(), reply(201, { ...app, rawKey, signingSecret: SECRET })]);
    h.signedIn();
    h.write('siren.app.json', file);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests[1])).not.toHaveProperty('url');
    expect(h.file('.env.sandbox')).toContain(`SIREN_SIGNING_SECRET=${SECRET}`);
    expect(h.out()).toContain('SIREN_APP_URL is not set');
    expect(h.out()).toContain('siren listen --forward-to localhost:<port>/<path>');
    expect(h.printed()).not.toContain(SECRET);

    const live = harness([], { edition: 'production' });
    live.signedIn({ [LIVE_BASE_URL]: session({ edition: 'production' }) });
    live.write('siren.app.json', file);
    expect(await live.run(['apps', 'apply', '--yes', '--live'])).toBe(1);
    expect(live.err()).toContain('needs the environment variable SIREN_APP_URL');
    expect(live.paths()).toEqual([]);
  });

  it('reads an address with no scheme as http, cuts a long reason, and keeps lines within 80 columns', () => {
    expect(forwardAddress('localhost:8787/siren')).toBe('http://localhost:8787/siren');
    expect(forwardAddress('https://dev.acme.example/hook')).toBe('https://dev.acme.example/hook');
    expect(failureReason({ httpStatus: 502, body: 'x'.repeat(200), error: null, durationMs: 1 })).toHaveLength('The handler answered 502: '.length + 60);
    const long = delivery({ request: { id: REQUEST, mode: 'tell', kind: 'postConversionAction', feature: 'a-very-long-feature-key-indeed-yes' } });
    expect(deliveryLine(new Style({ tty: false, env: {} }), 0, long, { httpStatus: null, body: '', error: 'x', durationMs: 8000 }).length).toBeLessThanOrEqual(80);
  });
});
