import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PermissionError,
  SignatureVerificationError,
  SirenError,
  ValidationError,
} from '../src/errors';
import type { HttpResponse } from '../src/http';
import type { AppRequest } from '../src/record-types';
import type { AppRequestHandlerOptions, AppRequestReply } from '../src/resources/app-request-handler';
import type { WebhookEvent } from '../src/types';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, bodyOf, networkDown, pathOf, unavailable } from './record-fakes';

/*
 * `apps.requestHandler()`, packet apps-answer-handler. Contract:
 * docs/architecture/apps-request-handler.md, sections "What the handler does
 * with one request" (the design's table 3.1) and "How an ask's answer is
 * posted" (3.2). One test, or one group, per row and per step, in the
 * design's order.
 *
 * Requests are Siren's own: the questions in
 * test/fixtures/apps-feature-contracts/requests.json (Siren's pkt/apps-c16-2
 * at f97b42820), signed with the secret of
 * test/fixtures/apps-exchange/signed-request.json as
 * WebhookSignature::headers() signs them, at this machine's time.
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
const ANSWER_PATH = `/apps/requests/${ID}/answer`;
const ACCEPTED = () => reply(200, { status: 'accepted' });

/**
 * Siren's request for `kind`, with its answerUrl on the test client's base
 * address, since the handler refuses an answer address on another Siren.
 */
function body(kind: string): string {
  return JSON.stringify(features.kinds[kind]!.request).replaceAll('https://cloud.example.com/siren/v1', BASE);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Headers as Siren's WebhookSignature::headers() builds them, with any replaced or removed. */
function signed(raw: string, event = 'app.request', t = now(), change: Record<string, string | undefined> = {}): Record<string, string> {
  const v1 = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Siren-Signature': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    'X-Siren-Event': event,
    'X-Siren-Delivery': `${ID}.1`,
    'User-Agent': 'Siren-Webhooks/1.0',
    'X-Siren-Timestamp': String(t),
    'X-Siren-Signature-V2': `t=${t},v1=${v1}`,
    'Idempotency-Key': ID,
  };
  for (const [name, value] of Object.entries(change)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

function setup(replies: Array<HttpResponse | Error> = [ACCEPTED()], options: Partial<AppRequestHandlerOptions> = {}) {
  const http = new FakeHttpClient(replies);
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 2 });
  const errors: Array<{ error: unknown; request: AppRequest | WebhookEvent | undefined }> = [];
  const answers = siren.apps.requestHandler({
    signingSecret: SECRET,
    onError: (error, request) => errors.push({ error, request }),
    ...options,
  });
  return { http, siren, answers, errors };
}

function parsed(result: AppRequestReply): unknown {
  return JSON.parse(result.body) as unknown;
}

/** Every reply is JSON, never cached, and never holds the secret or the request body. */
function expectJsonReply(result: AppRequestReply, status: number, raw?: string): void {
  expect(result.status).toBe(status);
  expect(result.headers['Content-Type']).toBe('application/json');
  expect(result.headers['Cache-Control']).toBe('no-store');
  expect(result.body).not.toContain(SECRET);
  if (raw !== undefined) expect(result.body).not.toContain(raw);
  const value = parsed(result);
  if (status === 200) expect(value).toEqual({});
  else expect(typeof (value as { error?: unknown }).error).toBe('string');
}

describe('apps-answer-handler: apps.requestHandler() options', () => {
  it('refuses a missing signing secret and a tolerance outside 1 to 3600 when it is made', () => {
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]) });
    expect(() => siren.apps.requestHandler({ signingSecret: undefined })).toThrow(SirenError);
    expect(() => siren.apps.requestHandler({ signingSecret: '' })).toThrow(/signing secret/);
    for (const toleranceSeconds of [0, 3601, 1.5]) {
      expect(() => siren.apps.requestHandler({ signingSecret: SECRET, toleranceSeconds })).toThrow(/toleranceSeconds/);
    }
    expect(() => siren.apps.requestHandler(undefined as never)).toThrow(SirenError);
  });

  it('refuses a function that is not one, and a feature named twice', () => {
    const { answers } = setup();
    expect(() => answers.on('payoutMethod', 'acme-ledger', 'nope' as never)).toThrow(SirenError);
    expect(() => answers.on('' as never, 'acme-ledger', (() => undefined) as never)).toThrow(SirenError);
    expect(() => answers.onEvent('conversion.approved', 3 as never)).toThrow(SirenError);
    answers.on('payoutMethod', 'acme-ledger', () => answers.later());
    expect(() => answers.on('payoutMethod', 'acme-ledger', () => answers.later())).toThrow(/already/);
    answers.on('payoutMethod', () => answers.later());
    expect(() => answers.on('payoutMethod', () => answers.later())).toThrow(/already/);
    answers.onEvent('conversion.approved', () => undefined);
    expect(() => answers.onEvent('conversion.approved', () => undefined)).toThrow(/already/);
  });

  it('chains on() and onEvent()', () => {
    const { answers } = setup();
    expect(answers.on('payoutMethod', 'a', () => answers.later()).on('payoutMethod', () => answers.later()).onEvent('x', () => undefined)).toBe(answers);
  });
});

describe('apps-answer-handler: table 3.1, one request', () => {
  it('row 1: answers 405 for a method other than POST, and calls nothing', async () => {
    const { answers, http, errors } = setup();
    const fn = vi.fn();
    answers.on('postConversionAction', 'tell-the-crm', fn);
    const raw = body('postConversionAction');
    for (const method of ['GET', 'PUT', 'HEAD', 'OPTIONS', 'get']) {
      const result = await answers.handle({ method, headers: signed(raw), rawBody: raw });
      expectJsonReply(result, 405);
      expect(result.headers.Allow).toBe('POST');
    }
    expect(fn).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('row 1: reads a missing method as POST, for a caller with only the body and headers', async () => {
    const { answers } = setup();
    answers.on('postConversionAction', 'tell-the-crm', () => undefined);
    const raw = body('postConversionAction');
    expectJsonReply(await answers.handle({ headers: signed(raw), rawBody: raw }), 200);
  });

  it('row 2: answers 500 for a body a parser already turned into an object, and tells onError how to mount it', async () => {
    const { answers, errors } = setup();
    const fn = vi.fn();
    answers.on('postConversionAction', 'tell-the-crm', fn);
    const raw = body('postConversionAction');
    const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: JSON.parse(raw) as unknown });
    expectJsonReply(result, 500);
    const words = (parsed(result) as { error: string }).error;
    expect(words).toContain('before the JSON body parser');
    expect(words).toContain('raw body');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(SirenError);
    expect((errors[0]!.error as Error).message).toBe(words);
    expect(fn).not.toHaveBeenCalled();
  });

  it('row 2: answers the same 500 for no body at all', async () => {
    const { answers, errors } = setup();
    const raw = body('postConversionAction');
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(raw), rawBody: undefined }), 500);
    expect(errors).toHaveLength(1);
  });

  it("row 3: answers 401 with verifyRequest's words for a missing or wrong signature, another timestamp, or an old time", async () => {
    const { answers, siren, errors } = setup();
    const fn = vi.fn();
    answers.on('postConversionAction', 'tell-the-crm', fn);
    const raw = body('postConversionAction');
    const t = now();
    const cases: Array<Record<string, string>> = [
      signed(raw, 'app.request', t, { 'X-Siren-Signature-V2': undefined }),
      signed(raw, 'app.request', t, { 'X-Siren-Signature-V2': `t=${t},v1=${'0'.repeat(64)}` }),
      signed(raw, 'app.request', t, { 'X-Siren-Signature-V2': 'garbage' }),
      signed(raw, 'app.request', t, { 'X-Siren-Timestamp': String(t + 1) }),
      signed(raw, 'app.request', t - 301),
      signed(raw, 'app.request', t + 301),
    ];
    for (const headers of cases) {
      const result = await answers.handle({ method: 'POST', headers, rawBody: raw });
      expectJsonReply(result, 401, raw);
      // The words are verifyRequest's own, checked in its order.
      const expected = (() => {
        try {
          siren.apps.verifyRequest(raw, headers, SECRET);
        } catch (error) {
          return (error as Error).message;
        }
        return 'verifyRequest accepted it';
      })();
      expect((parsed(result) as { error: string }).error).toBe(expected);
    }
    // A body signed with another secret is refused too.
    const other = createHmac('sha256', 'another-secret').update(`${t}.${raw}`).digest('hex');
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(raw, 'app.request', t, { 'X-Siren-Signature-V2': `t=${t},v1=${other}` }), rawBody: raw }), 401);
    expect(fn).not.toHaveBeenCalled();
    expect(errors).toHaveLength(0);
  });

  it('row 3: checks the time against toleranceSeconds', async () => {
    const { answers } = setup([ACCEPTED()], { toleranceSeconds: 10 });
    answers.on('postConversionAction', 'tell-the-crm', () => undefined);
    const raw = body('postConversionAction');
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(raw, 'app.request', now() - 11), rawBody: raw }), 401);
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(raw, 'app.request', now() - 5), rawBody: raw }), 200);
  });

  it('row 4: answers 400 for a signed body that is not JSON, or an app request that is not a version 1 envelope', async () => {
    const { answers, errors } = setup();
    const fn = vi.fn();
    answers.on('postConversionAction', fn);
    answers.onEvent('conversion.approved', fn);
    const notJson = '{"version":1,';
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(notJson), rawBody: notJson }), 400);
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(notJson, 'conversion.approved'), rawBody: notJson }), 400);
    const request = { ...features.kinds.postConversionAction!.request, version: 2 };
    const wrong = JSON.stringify(request);
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(wrong), rawBody: wrong }), 400);
    const list = '[1,2]';
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(list, 'conversion.approved'), rawBody: list }), 400);
    expect(fn).not.toHaveBeenCalled();
    expect(errors).toHaveLength(0);
  });

  it("row 5: a tell's function runs before the reply, and the reply is 200 {} once it returns", async () => {
    const { answers, http } = setup();
    const order: string[] = [];
    answers.on('postConversionAction', 'tell-the-crm', async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`ran ${request.id} ${request.data.conversion.id}`);
    });
    const raw = body('postConversionAction');
    for (const rawBody of [raw, Buffer.from(raw), new TextEncoder().encode(raw)]) {
      const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody });
      order.push(`replied ${result.status}`);
      expectJsonReply(result, 200);
      expect(result.after).toBeUndefined();
    }
    expect(order).toEqual([`ran ${ID} 1042`, 'replied 200', `ran ${ID} 1042`, 'replied 200', `ran ${ID} 1042`, 'replied 200']);
    expect(http.requests).toHaveLength(0);
  });

  it("row 5: a tell's function that throws gets 500, and onError gets the error and the request", async () => {
    const { answers, errors } = setup();
    const failure = new Error('the CRM is down, token sk_live_secret');
    answers.on('postAllocationAction', 'note-the-share', () => {
      throw failure;
    });
    const raw = body('postAllocationAction');
    const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    expectJsonReply(result, 500, raw);
    expect(result.body).not.toContain('sk_live_secret');
    expect((parsed(result) as { error: string }).error).toContain('postAllocationAction note-the-share');
    expect(errors).toEqual([{ error: failure, request: expect.objectContaining({ id: ID, mode: 'tell' }) }]);
  });

  it("row 6: an ask gets 200 {} at once, and its function runs only in the work after the reply", async () => {
    const { answers, http } = setup();
    const fn = vi.fn(() => features.kinds.distributionResolver!.answer as never);
    answers.on('distributionResolver', 'split-by-score', fn);
    const raw = body('distributionResolver');
    const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    expectJsonReply(result, 200);
    expect(fn).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
    expect(typeof result.after).toBe('function');
    await result.after!();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]).toEqual([expect.objectContaining({ id: ID, mode: 'ask', answerUrl: expect.any(String) })]);
    expect(pathOf(http.requests[0])).toBe(ANSWER_PATH);
    expect(bodyOf(http.requests[0])).toEqual(features.kinds.distributionResolver!.answer);
  });

  it('row 6: an ask whose function returns answers.later() posts nothing, so the app answers later with requests.answer()', async () => {
    const { answers, http, errors } = setup();
    answers.on('payoutMethod', 'acme-ledger', () => answers.later());
    answers.on('distributionResolver', async () => answers.later());
    for (const kind of ['distributionResolver']) {
      const raw = body(kind);
      const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
      expectJsonReply(result, 200);
      await result.after!();
    }
    expect(http.requests).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('row 7: a request for a kind and key with no function gets 404 with the words Siren shows', async () => {
    const { answers, errors } = setup();
    answers.on('distributionResolver', 'another-key', () => answers.later());
    answers.on('postConversionAction', () => undefined);
    const raw = body('distributionResolver');
    const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    expectJsonReply(result, 404);
    expect(parsed(result)).toEqual({ error: 'No function handles distributionResolver split-by-score.' });
    expect(result.after).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  it("rows 5 to 7: on(kind, fn) handles every key of the kind, and on(kind, key, fn) wins for its own key", async () => {
    const { answers } = setup();
    const any = vi.fn();
    const own = vi.fn();
    answers.on('postConversionAction', any);
    answers.on('postConversionAction', 'tell-the-crm', own);
    const raw = body('postConversionAction');
    await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    expect(own).toHaveBeenCalledTimes(1);
    expect(any).not.toHaveBeenCalled();
    const request = features.kinds.postConversionAction!.request;
    const other = JSON.stringify({ ...request, item: { kind: 'postConversionAction', key: 'other-key', id: 'app:99' } });
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(other), rawBody: other }), 200);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it("row 8: another event goes to onEvent's function, with 200 once it returns", async () => {
    const { answers } = setup();
    const seen: WebhookEvent[] = [];
    const order: string[] = [];
    answers.onEvent('conversion.approved', async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(event);
      order.push('ran');
    });
    const raw = JSON.stringify({ conversionId: 1042, status: 'approved' });
    const result = await answers.handle({ method: 'POST', headers: signed(raw, 'conversion.approved', now(), { 'X-Siren-Delivery': 'evt_1' }), rawBody: raw });
    order.push('replied');
    expectJsonReply(result, 200);
    expect(order).toEqual(['ran', 'replied']);
    expect(seen).toEqual([{ type: 'conversion.approved', data: { conversionId: 1042, status: 'approved' }, body: { conversionId: 1042, status: 'approved' }, deliveryId: 'evt_1' }]);
  });

  it("row 8: an event's function that throws gets 500, and onError gets the error and the event", async () => {
    const { answers, errors } = setup();
    const failure = new Error('no');
    answers.onEvent('conversion.approved', () => {
      throw failure;
    });
    const raw = JSON.stringify({ conversionId: 1042 });
    const result = await answers.handle({ method: 'POST', headers: signed(raw, 'conversion.approved'), rawBody: raw });
    expectJsonReply(result, 500);
    expect(errors).toEqual([{ error: failure, request: expect.objectContaining({ type: 'conversion.approved' }) }]);
  });

  it('row 8: an event is checked as a request is, so an old or unsigned event gets 401', async () => {
    const { answers } = setup();
    const fn = vi.fn();
    answers.onEvent('conversion.approved', fn);
    const raw = JSON.stringify({ conversionId: 1042 });
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(raw, 'conversion.approved', now() - 400), rawBody: raw }), 401);
    expectJsonReply(
      await answers.handle({ method: 'POST', headers: signed(raw, 'conversion.approved', now(), { 'X-Siren-Signature-V2': undefined }), rawBody: raw }),
      401,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('row 9: another event with no function gets 200 {}', async () => {
    const { answers, errors } = setup();
    answers.onEvent('conversion.approved', () => undefined);
    const raw = JSON.stringify({ test: true });
    expectJsonReply(await answers.handle({ method: 'POST', headers: signed(raw, 'webhook.test'), rawBody: raw }), 200);
    expect(errors).toHaveLength(0);
  });
});

describe('apps-answer-handler: section 3.2, posting an ask\'s answer', () => {
  async function ask(fn: () => unknown, replies: Array<HttpResponse | Error> = [ACCEPTED()]) {
    const context = setup(replies);
    context.answers.on('distributionResolver', 'split-by-score', fn as never);
    const raw = body('distributionResolver');
    const result = await context.answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    expect(result.status).toBe(200);
    await result.after!();
    return context;
  }

  it('step 1: checks the returned answer as requests.answer() does, and sends a bad one nowhere', async () => {
    const bad: unknown[] = [
      null,
      [],
      'allocated',
      { units: 'USD' },
      { outcome: '' },
      new (class Answer {
        outcome = 'allocated';
      })(),
      { outcome: 'allocated', padding: 'x'.repeat(16_384) },
    ];
    for (const value of bad) {
      const { http, errors } = await ask(() => value);
      expect(http.requests).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.error).toBeInstanceOf(SirenError);
      expect(errors[0]!.request).toEqual(expect.objectContaining({ id: ID }));
    }
  });

  it("step 2: posts to POST /apps/requests/{id}/answer with the client's own key", async () => {
    const { http, errors } = await ask(async () => features.kinds.distributionResolver!.answer);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe(ANSWER_PATH);
    expect(http.bearers()).toEqual([`Bearer ${TEST_API_KEY}`]);
    expect(bodyOf(http.requests[0])).toEqual({ outcome: 'allocated', units: 'USD', shares: { '41': 6000, '43': 4000 } });
    expect(errors).toHaveLength(0);
  });

  it('step 3: resends the same answer after a 503, a 429 or a lost connection, within maxRetries', async () => {
    const answer = features.kinds.distributionResolver!.answer;
    for (const first of [unavailable(), reply(429, { error: { message: 'Slow down.' } }, { 'Retry-After': '0' }), networkDown()]) {
      const { http, errors } = await ask(() => answer, [first, reply(200, { status: 'accepted', duplicate: true })]);
      expect(http.requests).toHaveLength(2);
      expect(http.requests[1]!.body).toBe(http.requests[0]!.body);
      expect(errors).toHaveLength(0);
    }
    // maxRetries is 2: three sends, then onError.
    const { http, errors } = await ask(() => answer, [unavailable()]);
    expect(http.requests).toHaveLength(3);
    expect(errors).toHaveLength(1);
  });

  it('step 3: requests.answer() itself stays sent once', async () => {
    const { siren, http } = setup([unavailable(), ACCEPTED()]);
    await expect(siren.apps.requests.answer(ID, { outcome: 'allocated' })).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(1);
  });

  it("step 4: hands each refusal to onError as the SDK's typed error, sent once", async () => {
    const cases: Array<[number, string, new (...args: never[]) => Error]> = [
      [422, 'app_answer_invalid', ValidationError],
      [409, 'app_request_already_answered', ConflictError],
      [409, 'app_request_dropped', ConflictError],
      [403, 'app_inactive', PermissionError],
      [404, 'app_request_not_found', NotFoundError],
    ];
    for (const [status, code, kind] of cases) {
      const { http, errors } = await ask(() => features.kinds.distributionResolver!.answer, [
        reply(status, { error: { message: 'Refused.', code, context: [] } }),
        ACCEPTED(),
      ]);
      expect(http.requests, code).toHaveLength(1);
      expect(errors, code).toHaveLength(1);
      expect(errors[0]!.error, code).toBeInstanceOf(kind);
      expect((errors[0]!.error as SirenError).code).toBe(code);
    }
  });

  it('step 4: a 401 gets the one resend every call gets, then goes to onError', async () => {
    const { http, errors } = await ask(() => features.kinds.distributionResolver!.answer, [reply(401, { error: { message: 'Unauthorized.' } })]);
    expect(http.requests.length).toBeLessThanOrEqual(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(AuthenticationError);
  });

  it('step 5: a function that throws goes to onError, and nothing is sent, so Siren asks again after answerBy', async () => {
    const failure = new Error('the ledger is down');
    const { http, errors } = await ask(() => {
      throw failure;
    });
    expect(http.requests).toHaveLength(0);
    expect(errors).toEqual([{ error: failure, request: expect.objectContaining({ id: ID }) }]);
  });

  it('the work after the reply never rejects, even when onError throws', async () => {
    const { answers } = setup([ACCEPTED()], {
      onError: () => {
        throw new Error('onError broke');
      },
    });
    answers.on('distributionResolver', () => {
      throw new Error('no');
    });
    const raw = body('distributionResolver');
    const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
    await expect(result.after!()).resolves.toBeUndefined();
  });

  it("logs with console.error when no onError is given, naming only the kind, key and request id, never the data or headers", async () => {
    const http = new FakeHttpClient([ACCEPTED()]);
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http });
    const answers = siren.apps.requestHandler({ signingSecret: SECRET });
    const failure = new Error('the CRM is down');
    answers.on('postConversionAction', () => {
      throw failure;
    });
    answers.onEvent('conversion.approved', () => {
      throw failure;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const raw = body('postConversionAction');
      expect((await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw })).status).toBe(500);
      const event = JSON.stringify({ conversionId: 1042, email: 'flo@example.com' });
      const eventHeaders = signed(event, 'conversion.approved', now(), { 'X-Siren-Delivery': 'evt_7' });
      expect((await answers.handle({ method: 'POST', headers: eventHeaders, rawBody: event })).status).toBe(500);
      expect(log.mock.calls).toEqual([
        [`Siren request handler (postConversionAction tell-the-crm ${ID}):`, failure],
        ['Siren request handler (conversion.approved evt_7):', failure],
      ]);
      const written = JSON.stringify(log.mock.calls.map((call) => call.map(String)));
      for (const secret of ['1042', 'flo@example.com', 'Partner program', SECRET, 'X-Siren-Signature']) {
        expect(written, secret).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('logs the 500 for a parsed body with no request to name', async () => {
    const http = new FakeHttpClient([ACCEPTED()]);
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http });
    const answers = siren.apps.requestHandler({ signingSecret: SECRET });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const raw = body('postConversionAction');
      await answers.handle({ method: 'POST', headers: signed(raw), rawBody: JSON.parse(raw) as unknown });
      expect(log.mock.calls).toEqual([['Siren request handler:', expect.any(SirenError)]]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('apps-answer-handler: the metric kinds of slice C16-1', () => {
  const metricAsk = (kind: string, key: string, data: Record<string, unknown>) =>
    JSON.stringify({
      ...(JSON.parse(body('distributionResolver')) as Record<string, unknown>),
      item: { kind, key, id: 'app:11' },
      data,
    });
  const cause = { id: 'evt-1', type: 'transaction', causeId: '3307' };

  it("types on('metricCalculation') and on('metricFilter') by their questions and answers, and posts what they return", async () => {
    const { answers, http } = setup([ACCEPTED()]);
    answers.on('metricCalculation', 'score-it', ({ data }) => ({
      outcome: 'scores',
      results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.points ?? 0 }],
    }));
    answers.on('metricFilter', 'owned-customers', ({ data }) =>
      data.collaborator.id === 42 ? { outcome: 'suppress', reason: 'Customer already owned by a partner' } : { outcome: 'allow' },
    );
    // @ts-expect-error A metric filter answers allow or suppress, never scores.
    answers.on('metricFilter', 'wrong', () => ({ outcome: 'scores', results: [] }));

    const calculation = metricAsk('metricCalculation', 'score-it', {
      distributor: { id: 2, name: 'Partner pool' },
      distribution: { id: 21, periodEnd: '2026-11-01T00:00:00+00:00' },
      metricType: 'sale',
      distributorMetricTypeId: 5,
      triggeringCollaborator: { id: 42, name: 'Flo' },
      opportunityId: 615,
      points: 12,
      cause,
      sale: null,
    });
    const filter = metricAsk('metricFilter', 'owned-customers', {
      distributor: { id: 2, name: 'Partner pool' },
      distribution: { id: 21 },
      collaborator: { id: 42, name: 'Flo' },
      metricType: 'sale',
      opportunityId: null,
      points: null,
      cause,
      sale: { transactionId: 3307, conversionId: 1042, excludedLineIds: [] },
    });
    for (const raw of [calculation, filter]) {
      const result = await answers.handle({ method: 'POST', headers: signed(raw), rawBody: raw });
      expect(result.status).toBe(200);
      await result.after!();
    }
    expect(http.requests.map(bodyOf)).toEqual([
      { outcome: 'scores', results: [{ collaboratorId: 42, score: 12 }] },
      { outcome: 'suppress', reason: 'Customer already owned by a partner' },
    ]);
  });
});

describe('apps-answer-handler: verifyRequest stays the low-level path', () => {
  it('still refuses an ordinary webhook, which the handler serves', () => {
    const { siren } = setup();
    const raw = JSON.stringify({ conversionId: 1 });
    expect(() => siren.apps.verifyRequest(raw, signed(raw, 'conversion.approved'), SECRET)).toThrow(SignatureVerificationError);
  });
});
