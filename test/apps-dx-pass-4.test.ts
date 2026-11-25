import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import { AppHandlerError, AppSlowTellError, SignatureVerificationError, SirenError } from '../src/errors';
import { TELL_TIME_LIMIT_SECONDS, WebhookEventType } from '../src/index';
import type { AppLogger } from '../src/resources/app-request-handler';
import type { HttpResponse } from '../src/http';
import type { AppRequestDetail } from '../src/record-types';
import { appRequest, appRequestFromRecord, sampleEventData, webhookEvent } from '../src/testing';
import { EVENT_SAMPLES } from '../src/testing/event-samples';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * DX pass 4 (review/sdk-dx/pass-4-review.md and pass-4-builder-spec.md in
 * the apps run folder): errors, testing and local development. Finding 5's
 * logger first, since findings 1 and 3 write through it; finding 1, a
 * refused signature reaches the app's log; finding 2, the replay helper
 * and the README's local development; finding 3, a tell past Siren's 8
 * seconds; finding 4, signed webhook events for onEvent tests; and the
 * 422 line.
 */

const root = join(__dirname, '..');
const read = (name: string): string => readFileSync(join(root, name), 'utf8');
const SECRET = 'a-secret-for-pass-4';
const ID = 'apr_4e1b0c9d8a7f6e5d4c3b2a1908f7e6d5';

interface Lines {
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
}

function recorder(): { logger: AppLogger; lines: Lines } {
  const lines: Lines = { debug: [], info: [], warn: [], error: [] };
  const logger: AppLogger = {
    debug: (line: string) => lines.debug.push(line),
    info: (line: string) => lines.info.push(line),
    warn: (line: string) => lines.warn.push(line),
    error: (line: string) => lines.error.push(line),
  };
  return { logger, lines };
}

function setup(options: { replies?: Array<HttpResponse | Error>; onError?: (error: unknown) => void; logger?: AppLogger } = {}) {
  const http = new FakeHttpClient(options.replies ?? [reply(200, { status: 'accepted' })]);
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
  const answers = siren.apps.requestHandler({
    signingSecret: SECRET,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { http, siren, answers };
}

const tell = (options: { secret?: string; timestamp?: number } = {}) =>
  appRequest('postConversionAction', 'notify-crm', { secret: SECRET, baseUrl: BASE, id: ID, ...options });
const ask = () => appRequest('distributionResolver', 'split-by-score', { secret: SECRET, baseUrl: BASE, id: ID });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('finding 5: a logger option, levels and short lines', () => {
  it('refuses a logger without debug, info, warn and error', () => {
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]) });
    expect(() => siren.apps.requestHandler({ signingSecret: SECRET, logger: { error: () => undefined } as never })).toThrow(
      'apps.requestHandler() takes logger as an object with debug, info, warn and error functions, such as console or a pino logger.',
    );
  });

  it('writes one debug line per request handled, with its name, status and time', async () => {
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    answers.on('postConversionAction', 'notify-crm', () => undefined);
    await answers.handle(tell());
    expect(lines.debug).toHaveLength(1);
    expect(lines.debug[0]).toMatch(new RegExp(`^Siren request handler \\(postConversionAction notify-crm ${ID}\\): 200 in \\d+ ms$`));
  });

  it('prints no debug line by default, so a production log stays quiet', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { answers } = setup();
    answers.on('postConversionAction', 'notify-crm', () => undefined);
    await answers.handle(tell());
    expect(debug).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  it("writes a function's own throw with its stack, as one error entry", async () => {
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    answers.on('postConversionAction', 'notify-crm', () => {
      throw new Error('crm down');
    });
    await answers.handle(tell());
    expect(lines.error).toHaveLength(1);
    const [first, ...rest] = lines.error[0]!.split('\n');
    expect(first).toBe(`Siren request handler (postConversionAction notify-crm ${ID}): Error: crm down`);
    expect(rest[0]).toMatch(/^\s+at /);
  });

  it('writes a 401 on the answer post in at most two lines, with no stack and the cause folded in', async () => {
    const { logger, lines } = recorder();
    const refused = reply(401, { error: { message: 'Siren did not accept this key on the answer route.', code: 'app_answer_unauthorized', context: [] } });
    const { answers } = setup({ replies: [refused], logger });
    answers.on('distributionResolver', () => ({ outcome: 'allocated', units: 'USD', shares: { '41': 6000, '43': 4000 } }));
    await (await answers.handle(ask())).after!();
    expect(lines.error).toHaveLength(1);
    expect(lines.error[0]!.split('\n').length).toBeLessThanOrEqual(2);
    expect(lines.error[0]).not.toMatch(/\n\s+at /);
    expect(lines.error[0]).toContain('Siren did not accept this key on the answer route.');
    expect(lines.error[0]).toContain('app_answer_unauthorized');
  });

  it('keeps the debug line when onError replaces the default', async () => {
    const { logger, lines } = recorder();
    const errors: unknown[] = [];
    const { answers } = setup({ logger, onError: (error) => errors.push(error) });
    answers.on('postConversionAction', 'notify-crm', () => {
      throw new Error('crm down');
    });
    await answers.handle(tell());
    expect(errors).toHaveLength(1);
    expect(lines.error).toEqual([]);
    expect(lines.debug).toHaveLength(1);
  });

  it('writes nothing through the logger from simulate()', async () => {
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    answers.on('postConversionAction', 'notify-crm', () => {
      throw new Error('crm down');
    });
    await answers.simulate(tell());
    expect(lines).toEqual({ debug: [], info: [], warn: [], error: [] });
  });
});

describe('finding 1: a refused signature reaches onError and the log', () => {
  it('hands a wrong secret to onError as a SignatureVerificationError with its code, and still replies 401', async () => {
    const errors: unknown[] = [];
    const { answers } = setup({ onError: (error) => errors.push(error) });
    answers.on('postConversionAction', 'notify-crm', () => undefined);
    const result = await answers.handle(tell({ secret: 'the-old-secret' }));
    expect(result.status).toBe(401);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SignatureVerificationError);
    expect((errors[0] as SirenError).code).toBe('signature_mismatch');
  });

  it('writes one warn line that names SIREN_SIGNING_SECRET for a wrong secret', async () => {
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    await answers.handle(tell({ secret: 'the-old-secret' }));
    expect(lines.warn).toEqual([
      'Siren request handler: refused a request with 401. The request signature does not match. Pass the raw body exactly as received and the signing secret of this app. ' +
        "Check SIREN_SIGNING_SECRET: it must be this app's signing secret, and it changes when the secret is rotated.",
    ]);
    expect(lines.error).toEqual([]);
  });

  it("says to check a proxy for a missing header, and the clock for a stale time", async () => {
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    const request = tell();
    const { 'X-Siren-Signature-V2': _dropped, ...headers } = request.headers;
    await answers.handle({ ...request, headers });
    await answers.handle(tell({ timestamp: Math.floor(Date.now() / 1000) - 600 }));
    expect(lines.warn[0]).toBe(
      "Siren request handler: refused a request with 401. The request has no X-Siren-Signature-V2 header. Check that a proxy passes Siren's X-Siren-* headers through.",
    );
    expect(lines.warn[1]).toContain("from this machine's clock");
    expect(lines.warn[1]).toContain('Check the clock');
  });

  it('writes five lines a minute at most, then one line with the count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T20:00:00Z'));
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    for (let i = 0; i < 8; i += 1) await answers.handle(tell({ secret: 'the-old-secret' }));
    expect(lines.warn).toHaveLength(5);
    vi.setSystemTime(new Date('2026-11-24T20:01:01Z'));
    await answers.handle(tell({ secret: 'the-old-secret' }));
    expect(lines.warn).toHaveLength(7);
    expect(lines.warn[5]).toBe(
      '3 more requests failed the signature check in the last minute. When every request fails, SIREN_SIGNING_SECRET is wrong or was rotated.',
    );
    expect(lines.warn[6]).toContain('The request signature does not match.');
  });

  it("gives simulate() the refusal as its error", async () => {
    const { answers } = setup();
    const result = await answers.simulate(tell({ secret: 'the-old-secret' }));
    expect(result.status).toBe(401);
    expect(result.error).toBeInstanceOf(SignatureVerificationError);
  });
});

describe("finding 3: a tell past Siren's 8 seconds", () => {
  it('names the limit, cited to Siren', () => {
    expect(TELL_TIME_LIMIT_SECONDS).toBe(8);
  });

  const slow = (answers: ReturnType<typeof setup>['answers'], seconds: number) =>
    answers.on('postConversionAction', 'notify-crm', () => {
      vi.setSystemTime(Date.now() + seconds * 1000);
    });

  it('replies 200, and hands onError an AppSlowTellError that says the tell ran twice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const errors: unknown[] = [];
    const { answers } = setup({ onError: (error) => errors.push(error) });
    slow(answers, 9);
    const result = await answers.handle(tell());
    expect(result.status).toBe(200);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AppSlowTellError);
    expect(errors[0]).toBeInstanceOf(SirenError);
    expect((errors[0] as Error).message).toBe(
      'postConversionAction notify-crm took 9.0 s. Siren stops waiting at 8 s and sends the tell again, so it ran twice. ' +
        'Save what you need, hand the slow part to runLater or your own queue, and return.',
    );
  });

  it('writes the default as a warn line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { logger, lines } = recorder();
    const { answers } = setup({ logger });
    slow(answers, 9);
    await answers.handle(tell());
    expect(lines.warn).toHaveLength(1);
    expect(lines.warn[0]).toContain('took 9.0 s. Siren stops waiting at 8 s');
  });

  it('gives simulate() the same error, and nothing for a tell inside the limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { answers } = setup();
    slow(answers, 9);
    const late = await answers.simulate(tell());
    expect(late.status).toBe(200);
    expect(late.error).toBeInstanceOf(AppSlowTellError);

    const quick = setup().answers;
    slow(quick, 7.9);
    expect((await quick.simulate(tell())).error).toBeNull();
  });
});

describe('finding 4: signed webhook events for onEvent tests', () => {
  it("signs an event the way Siren signs one to an app's address, with Siren's sample data", async () => {
    const event = webhookEvent('conversion.approved', undefined, { secret: SECRET });
    expect(event.headers['X-Siren-Event']).toBe('conversion.approved');
    expect(event.headers['X-Siren-Delivery']).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(event.headers).not.toHaveProperty('Idempotency-Key');
    const t = event.headers['X-Siren-Timestamp']!;
    expect(event.headers['X-Siren-Signature-V2']).toBe(`t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${event.rawBody}`).digest('hex')}`);

    const seen: unknown[] = [];
    const { answers } = setup();
    answers.onEvent('conversion.approved', (received) => {
      seen.push(received);
    });
    const result = await answers.simulate(event);
    expect(result).toEqual({ status: 200, body: {}, answer: null, error: null });
    expect(seen).toEqual([expect.objectContaining({ type: 'conversion.approved', data: sampleEventData('conversion.approved') })]);
  });

  it('takes the data to send, and refuses an event it has no sample of, naming the documented ones', () => {
    const event = webhookEvent('credit.issued', { creditId: 7 }, { secret: SECRET });
    expect(JSON.parse(event.rawBody)).toEqual({ creditId: 7 });
    expect(() => sampleEventData('credit.issued')).toThrow(AppHandlerError);
    expect(() => sampleEventData('credit.issued')).toThrow(/has no sample of credit\.issued\. Pass the data/);
  });

  it("holds a sample for each event Siren documents, each one an event Siren sends", () => {
    const sent = new Set<string>(Object.values(WebhookEventType));
    expect(Object.keys(EVENT_SAMPLES).length).toBeGreaterThanOrEqual(60);
    for (const type of Object.keys(EVENT_SAMPLES)) expect(sent.has(type), type).toBe(true);
    expect(sampleEventData('sale.created')).toEqual({ opportunityId: 101, attributed: true, source: 'stripe', bindingId: 'example' });
  });

  it.skipIf(process.env.SIREN_CHECKOUT === undefined)("matches what Siren's docs/api/webhooks-events.md gives (set SIREN_CHECKOUT to run)", () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/siren-event-samples.mjs', process.env.SIREN_CHECKOUT!, '--check'], { cwd: root, stdio: 'pipe' }),
    ).not.toThrow();
  });
});

describe('finding 2: a stored request as a test input', () => {
  const detail: AppRequestDetail = {
    id: ID,
    appId: 12,
    feature: 'app:31',
    kind: 'distributionResolver',
    mode: 'ask',
    subject: { type: 'allocation', id: '77' },
    status: 'needs_attention',
    sendCount: 3,
    answerBy: '2026-11-24T21:00:00+00:00',
    answeredBy: null,
    answeredAt: null,
    lastError: 'The app replied 500.',
    createdAt: '2026-11-24T20:00:00+00:00',
    data: (JSON.parse(ask().rawBody) as { data: Record<string, unknown> }).data,
    answer: null,
    answeredByUser: null,
  };

  it("signs the record's id, kind, data and answerBy, with the key you give", async () => {
    const request = appRequestFromRecord(detail, { key: 'split-by-score', secret: SECRET, baseUrl: BASE });
    const body = JSON.parse(request.rawBody) as Record<string, unknown>;
    expect(body).toMatchObject({ id: ID, mode: 'ask', feature: { kind: 'distributionResolver', key: 'split-by-score', id: 'app:31' }, answerBy: detail.answerBy, data: detail.data });
    const seen: unknown[] = [];
    const { answers } = setup();
    answers.on('distributionResolver', 'split-by-score', (received) => {
      seen.push(received.id);
      return { outcome: 'allocated', units: 'USD', shares: { '41': 6000, '43': 4000 } };
    });
    expect((await answers.simulate(request)).error).toBeNull();
    expect(seen).toEqual([ID]);
  });

  it('takes the JSON text siren apps requests prints, and a raw request body that names its key', () => {
    const fromText = appRequestFromRecord(JSON.stringify(detail), { key: 'split-by-score', secret: SECRET, baseUrl: BASE });
    expect(JSON.parse(fromText.rawBody).id).toBe(ID);
    const envelope = JSON.parse(ask().rawBody) as Record<string, unknown>;
    const fromBody = appRequestFromRecord(envelope, { secret: SECRET, baseUrl: BASE });
    expect(JSON.parse(fromBody.rawBody).feature.key).toBe('split-by-score');
  });

  it('says where to find the key when the record has none', () => {
    expect(() => appRequestFromRecord(detail, { secret: SECRET })).toThrow(AppHandlerError);
    expect(() => appRequestFromRecord(detail, { secret: SECRET })).toThrow(
      "appRequestFromRecord() needs the feature's key: the record names its feature as app:31, without the key. Pass { key }, which `siren apps show <app>` lists beside each feature.",
    );
  });

  it('builds a tell with no answer address', () => {
    const request = appRequestFromRecord({ ...detail, kind: 'postConversionAction', mode: 'tell', answerBy: null, data: {} }, { key: 'notify-crm', secret: SECRET });
    const body = JSON.parse(request.rawBody) as Record<string, unknown>;
    expect(body.mode).toBe('tell');
    expect(body).not.toHaveProperty('answerUrl');
    expect(body).not.toHaveProperty('answerBy');
  });
});

describe('the 422 line', () => {
  it("says to reproduce the broken answer with simulate() instead of waiting for Siren to send it again", async () => {
    const { logger, lines } = recorder();
    const refused = reply(422, { error: { message: 'The shares add up to 13000, more than the pool of 10000.', code: 'app_answer_invalid', context: [] } });
    const { answers } = setup({ replies: [refused], logger });
    answers.on('distributionResolver', () => ({ outcome: 'allocated', units: 'USD', shares: { '41': 6500, '43': 6500 } }));
    await (await answers.handle(ask())).after!();
    expect(lines.error).toHaveLength(1);
    expect(lines.error[0]).toContain(
      `Your function's answer broke Siren's rule. Reproduce it with simulate() on this request's data, fix it, then resend with \`siren apps resend ${ID}\`.`,
    );
    expect(lines.error[0]).not.toContain('Siren sends it again');
    expect(lines.error[0]).toContain('ValidationError: The shares add up to 13000');
  });
});

describe('the README', () => {
  const readme = read('README.md');
  const section = (from: string): string => {
    const start = readme.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = readme.indexOf('\n## ', start + from.length);
    return readme.slice(start, end < 0 ? undefined : end);
  };

  it('teaches local development with siren listen and siren trigger, and no tunnel', () => {
    const text = section('## Develop on your machine');
    expect(text).toContain('siren listen --forward-to localhost:3000/siren');
    expect(text).toContain('siren trigger ask <app> <feature>');
    expect(text).toContain('`sk_test_`');
    expect(text).toContain('.env.sandbox');
    expect(text).toContain("arrive with the command-line tool's next release");
    expect(readme).not.toMatch(/ngrok|cloudflared/i);
  });

  it('documents the logger, the 8 seconds, runLater for a tell, the replay helper and webhookEvent', () => {
    expect(section('### Options and functions')).toContain('`logger`');
    expect(section('### What the handler replies')).toContain('A tell must finish within 8 seconds');
    expect(readme).toContain("A tell's function can call your `runLater` too");
    const testing = section('## Try it without Siren');
    expect(testing).toContain('appRequestFromRecord(');
    expect(testing).toContain('```js\n' + read('test/readme-samples/test-an-event.js').trimEnd() + '\n```');
  });

  it('runs the event sample as written', async () => {
    vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
    vi.stubEnv('SIREN_SIGNING_SECRET', 'a-test-secret');
    const name = 'test-an-event';
    await expect(import(`./readme-samples/${name}.js`)).resolves.toBeDefined();
    vi.unstubAllEnvs();
  });
});


describe('test requests (contract/devtools-trigger.md section 2: "test": true after mode)', () => {
  it('builds a test request with test after mode, and leaves the field out otherwise', () => {
    const marked = appRequest('payoutMethod', 'acme-ledger', { secret: SECRET, test: true });
    expect(Object.keys(JSON.parse(marked.rawBody) as object).slice(0, 5)).toEqual(['version', 'id', 'type', 'mode', 'test']);
    expect(JSON.parse(marked.rawBody).test).toBe(true);
    expect(JSON.parse(ask().rawBody)).not.toHaveProperty('test');
  });

  it('reads test as true on a test request and false when the field is absent', async () => {
    const seen: boolean[] = [];
    const { answers } = setup();
    answers.on('postConversionAction', 'notify-crm', (request) => {
      seen.push(request.test);
    });
    await answers.simulate(appRequest('postConversionAction', 'notify-crm', { secret: SECRET, test: true }));
    await answers.simulate(tell());
    expect(seen).toEqual([true, false]);
  });

  it('refuses a test that is not a boolean with a 400 naming the field', async () => {
    const { answers } = setup();
    answers.on('postConversionAction', 'notify-crm', () => undefined);
    const body = { ...(JSON.parse(tell().rawBody) as Record<string, unknown>), test: 'yes' };
    const t = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify(body);
    const headers = { ...tell().headers, 'X-Siren-Timestamp': String(t), 'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}` };
    const result = await answers.simulate({ method: 'POST', headers, rawBody: raw });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("The request's `test` must be true or false.");
  });

  it('carries test from a stored record', () => {
    const record = { id: ID, feature: 'app:31', kind: 'payoutMethod', mode: 'ask', test: true, answerBy: '2026-11-24T21:00:00+00:00', data: {} };
    expect(JSON.parse(appRequestFromRecord(record, { key: 'acme-ledger', secret: SECRET }).rawBody).test).toBe(true);
    const { test: _test, ...plain } = record;
    expect(JSON.parse(appRequestFromRecord(plain, { key: 'acme-ledger', secret: SECRET }).rawBody)).not.toHaveProperty('test');
  });

  it('says in the testing section that a handler must never move money or write records on a test request', () => {
    const readme = read('README.md');
    const testing = readme.slice(readme.indexOf('## Try it without Siren'), readme.indexOf('\n## ', readme.indexOf('## Try it without Siren') + 5));
    expect(testing).toContain('`request.test`');
    expect(testing).toContain('A handler must never move money or write records on a test request.');
  });
});
