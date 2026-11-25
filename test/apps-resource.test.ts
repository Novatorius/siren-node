import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import {
  AppErrorCode,
  AuthenticationError,
  ConflictError,
  appErrorCode,
  NotFoundError,
  PermissionError,
  SirenError,
  UnexpectedResponseError,
  ValidationError,
} from '../src/errors';
import { DEFAULT_BASE_URL, SANDBOX_BASE_URL } from '../src/http';
import { AppsResource, MAX_APP_ANSWER_BYTES } from '../src/resources/apps';
import type { DeclareAppParams } from '../src/record-types';
import { FakeHttpClient, reply } from './http-fakes';
import { capturedBody, capturedReply } from './cloud-captures';
import { bodyOf, expectRetried, expectSentOnce, pathOf, queryOf, transportOver } from './record-fakes';

import { APP_KEY, APP_REQUEST_ID, AppAnswers, appRecord, requestRow } from './apps-siren-answers';
/*
 * Acceptance tests for `siren.apps` and `siren.apps.requests`, packets
 * sdk-apps, sdk-requests, sdk-answer and sdk-sandbox-guard. Contract:
 * docs/architecture/apps-cli.md, "The calls".
 *
 * The answers are Siren's, from AppSerializer and AppRequestSerializer on
 * the apps-records (7a843fed3) and apps-exchange (086615e2a) branches.
 * answer.json is Siren's tests/Fixtures/apps-exchange/answer.json.
 */

const KEY = APP_KEY;
const REQUEST = APP_REQUEST_ID;

const app = appRecord({ description: '' });
const secrets = { rawKey: `sk_test_${'0a'.repeat(32)}`, signingSecret: 'ef'.repeat(32) };
const row = requestRow();

const declaration: DeclareAppParams = {
  name: 'Acme',
  description: '',
  url: 'https://acme.example/siren',
  scopes: [],
  events: ['conversion.approved'],
  features: [
    { kind: 'payoutMethod', key: 'acme-ledger', name: 'Acme ledger', currencies: ['USD'], answerWindowMinutes: 4320 },
    { kind: 'postConversionAction', key: 'notify-crm', name: 'Tell the CRM' },
  ],
};

function apps(replies: Parameters<typeof transportOver>[0]) {
  const over = transportOver(replies);
  return { ...over, apps: new AppsResource(over.transport) };
}

async function refused(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the call answered instead of refusing');
}

describe('apps-cli: apps.declare', () => {
  it('sends the whole app once with PUT and answers the secrets of a new app', async () => {
    const { http, apps: resource } = apps([reply(201, { ...app, ...secrets })]);
    const declared = await resource.declare(KEY, declaration);

    expect(http.requests[0]?.method).toBe('PUT');
    expect(pathOf(http.requests[0])).toBe('/apps/acme-payouts');
    expect(bodyOf(http.requests[0])).toEqual(declaration);
    expect(declared).toMatchObject({ key: KEY, created: true, ...secrets });
  });

  it('answers created: false and no secret for an app that already exists', async () => {
    const { apps: resource } = apps([reply(200, app)]);
    const declared = await resource.declare(KEY, declaration);
    expect(declared.created).toBe(false);
    expect(declared).not.toHaveProperty('rawKey');
    expect(declared).not.toHaveProperty('signingSecret');
  });

  it('is sent once', async () => {
    await expectSentOnce((transport) => new AppsResource(transport).declare(KEY, declaration), reply(200, app));
  });

  it('refuses a bad key, an unknown field and a broken feature before sending', async () => {
    const cases: Array<[string, unknown]> = [
      ['Acme', declaration],
      ['acme--payouts', declaration],
      ['-acme', declaration],
      ['requests', declaration],
      ['a'.repeat(65), declaration],
      [KEY, { ...declaration, secret: 'x' }],
      [KEY, { ...declaration, status: undefined }],
      [KEY, { ...declaration, name: undefined }],
      [KEY, { ...declaration, url: undefined }],
      [KEY, { ...declaration, features: {} }],
      [KEY, { ...declaration, features: ['acme-ledger'] }],
      [KEY, { ...declaration, features: [{ key: 'acme-ledger', name: 'Acme ledger' }] }],
      [KEY, { ...declaration, features: [{ kind: 'payoutMethod', name: 'Acme ledger' }] }],
      [KEY, { ...declaration, features: [{ kind: 'payoutMethod', key: 'acme-ledger' }] }],
      [KEY, { ...declaration, features: [{ kind: 'payoutMethod', key: 'acme-ledger', name: 'A', settings: {} }] }],
    ];
    for (const [key, params] of cases) {
      const { http, apps: resource } = apps([reply(200, app)]);
      const error = await refused(() => resource.declare(key, params as DeclareAppParams));
      expect(error, JSON.stringify([key, params])).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
  });

  it('sends only its own fields, never an inherited toJSON', async () => {
    const params = Object.assign(Object.create({ toJSON: () => ({ name: 'hijacked' }) }) as object, declaration);
    const { http, apps: resource } = apps([reply(200, app)]);
    await resource.declare(KEY, params as DeclareAppParams);
    expect(bodyOf(http.requests[0])).toEqual(declaration);
  });

  it('throws UnexpectedResponseError for an answer that is not an app, or holds a secret that is not text', async () => {
    for (const body of [{ success: true }, { ...app, features: undefined }, { ...app, rawKey: 7 }, { ...app, signingSecret: null }]) {
      const { apps: resource } = apps([reply(200, body)]);
      expect(await refused(() => resource.declare(KEY, declaration)), JSON.stringify(body)).toBeInstanceOf(
        UnexpectedResponseError,
      );
    }
  });
});

describe('apps-cli: apps reads and changes', () => {
  it('lists the apps from a bare array, retried', async () => {
    const { http, apps: resource } = apps([reply(200, [app])]);
    expect(await resource.list()).toEqual([app]);
    expect(http.requests[0]?.method).toBe('GET');
    expect(pathOf(http.requests[0])).toBe('/apps');
    await expectRetried((transport) => new AppsResource(transport).list(), reply(200, [app]));

    const wrapped = apps([reply(200, { data: [app] })]);
    expect(await refused(() => wrapped.apps.list())).toBeInstanceOf(UnexpectedResponseError);
  });

  it('retrieves one app, retried, and refuses a bad key before sending', async () => {
    const { http, apps: resource } = apps([reply(200, app)]);
    expect(await resource.retrieve(KEY)).toEqual(app);
    expect(pathOf(http.requests[0])).toBe('/apps/acme-payouts');
    await expectRetried((transport) => new AppsResource(transport).retrieve(KEY), reply(200, app));

    const bad = apps([reply(200, app)]);
    expect(await refused(() => bad.apps.retrieve('requests'))).toBeInstanceOf(SirenError);
    expect(bad.http.requests).toHaveLength(0);
  });

  it('turns an app on and off once, and refuses another status', async () => {
    const { http, apps: resource } = apps([reply(200, { ...app, status: 'inactive' })]);
    expect((await resource.setStatus(KEY, 'inactive')).status).toBe('inactive');
    expect(http.requests[0]?.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/apps/acme-payouts/status');
    expect(bodyOf(http.requests[0])).toEqual({ status: 'inactive' });
    await expectSentOnce((transport) => new AppsResource(transport).setStatus(KEY, 'active'), reply(200, app));

    const bad = apps([reply(200, app)]);
    expect(await refused(() => bad.apps.setStatus(KEY, 'paused' as 'active'))).toBeInstanceOf(SirenError);
    expect(bad.http.requests).toHaveLength(0);
  });

  it('reads an app error code from error.code first, then from context.reason', async () => {
    const coded = apps([reply(409, { error: { message: 'In use.', code: 'app_in_use', context: { reason: 'app_change_in_progress' } } })]);
    expect(appErrorCode(await refused(() => coded.apps.delete(KEY)))).toBe('app_in_use');
    const reasoned = apps([AppAnswers.reasonOnly('app_change_in_progress')]);
    expect(appErrorCode(await refused(() => reasoned.apps.delete(KEY)))).toBe('app_change_in_progress');
    const plain = apps([AppAnswers.uncoded()]);
    expect(appErrorCode(await refused(() => plain.apps.delete(KEY)))).toBeUndefined();
    expect(appErrorCode(new Error('not from Siren'))).toBeUndefined();
  });

  it('deletes once, and raises the in-use refusal with its uses', async () => {
    const { http, apps: resource } = apps([reply(200, { success: true })]);
    await expect(resource.delete(KEY)).resolves.toBeUndefined();
    expect(http.requests[0]?.method).toBe('DELETE');
    expect(pathOf(http.requests[0])).toBe('/apps/acme-payouts');
    await expectSentOnce((transport) => new AppsResource(transport).delete(KEY), reply(200, { success: true }));

    const inUse = apps([AppAnswers.inUse()]);
    const error = await refused(() => inUse.apps.delete(KEY));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).data).toMatchObject({ reason: 'app_in_use', uses: { 'app:12': 2 } });
  });
});

describe('apps-cli: apps.requests', () => {
  it('lists requests from their envelope, retried, with a status filter', async () => {
    const { http, apps: resource } = apps([reply(200, { requests: [row] })]);
    expect(await resource.requests.list({ status: 'needs_attention' })).toEqual([row]);
    expect(pathOf(http.requests[0])).toBe('/apps/requests');
    expect(queryOf(http.requests[0])).toEqual({ status: 'needs_attention' });
    await expectRetried((transport) => new AppsResource(transport).requests.list(), reply(200, { requests: [] }));

    const none = apps([reply(200, { requests: [] })]);
    await none.apps.requests.list();
    expect(queryOf(none.http.requests[0])).toEqual({});
  });

  it('refuses an unknown filter or status before sending, and a body with no requests list', async () => {
    for (const params of [{ status: 'lost' }, { app: KEY }]) {
      const { http, apps: resource } = apps([reply(200, { requests: [] })]);
      expect(await refused(() => resource.requests.list(params as { status: 'sent' }))).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
    for (const body of [[row], { requests: 'none' }, { requests: [1] }]) {
      const { apps: resource } = apps([reply(200, body)]);
      expect(await refused(() => resource.requests.list())).toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it('pages with limit and before, which ListAppRequests reads at feat/apps 0383186437', async () => {
    const { http, apps: resource } = apps([reply(200, { requests: [row] })]);
    expect(await resource.requests.list({ limit: 100, before: REQUEST, status: 'sent' })).toEqual([row]);
    expect(queryOf(http.requests[0])).toEqual({ limit: '100', before: REQUEST, status: 'sent' });
  });

  it('refuses a limit outside 1 to 100, a before that is no request id, and either one beside needs_attention, which Siren would ignore', async () => {
    for (const params of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { before: 'apr_x' }, { status: 'needs_attention', limit: 10 }, { status: 'needs_attention', before: REQUEST }]) {
      const { http, apps: resource } = apps([reply(200, { requests: [] })]);
      expect(await refused(() => resource.requests.list(params as never)), JSON.stringify(params)).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
  });

  it('finds requests by the start of their id with idPrefix, which ListAppRequests reads at feat/apps 76d5bbdf83', async () => {
    const { http, apps: resource } = apps([reply(200, { requests: [row], total: 1 })]);
    expect(await resource.requests.list({ idPrefix: 'apr_9f2c' })).toEqual([row]);
    expect(queryOf(http.requests[0])).toEqual({ idPrefix: 'apr_9f2c' });
  });

  it('refuses an idPrefix that is not apr_ and 4 to 32 hex characters, and one beside another filter, which Siren would ignore', async () => {
    for (const params of [
      { idPrefix: 'apr_9f2' },
      { idPrefix: '9f2c4e1a' },
      { idPrefix: `apr_${'a'.repeat(33)}` },
      { idPrefix: 'apr_9F2C' },
      { idPrefix: 'apr_9f2c', limit: 10 },
      { idPrefix: 'apr_9f2c', before: REQUEST },
      { idPrefix: 'apr_9f2c', status: 'sent' },
    ]) {
      const { http, apps: resource } = apps([reply(200, { requests: [] })]);
      expect(await refused(() => resource.requests.list(params as never)), JSON.stringify(params)).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
  });

  it('resends once, and refuses a bad id before sending', async () => {
    const { http, apps: resource } = apps([reply(200, { ...row, sendCount: 2 })]);
    expect((await resource.requests.resend(REQUEST)).sendCount).toBe(2);
    expect(http.requests[0]?.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe(`/apps/requests/${REQUEST}/resend`);
    await expectSentOnce((transport) => new AppsResource(transport).requests.resend(REQUEST), reply(200, row));

    for (const id of ['apr_xyz', REQUEST.toUpperCase(), `${REQUEST}/answer`, 'requests']) {
      const bad = apps([reply(200, row)]);
      expect(await refused(() => bad.apps.requests.resend(id))).toBeInstanceOf(SirenError);
      expect(bad.http.requests).toHaveLength(0);
    }

    const done = apps([AppAnswers.notResendable()]);
    const error = await refused(() => done.apps.requests.resend(REQUEST));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('app_request_not_resendable');
  });
});

interface AnswerFixture {
  path: string;
  exchanges: Array<{ answer: { outcome: string }; status: number; reply?: unknown; code?: string }>;
}
const answers = JSON.parse(
  readFileSync(new URL('./fixtures/apps-exchange/answer.json', import.meta.url), 'utf8'),
) as AnswerFixture;

describe('apps-cli: apps.requests.answer', () => {
  it("replays Siren's answer fixture: accepted, then a duplicate, then a different answer refused", async () => {
    const replies = answers.exchanges.map((exchange) =>
      exchange.status === 200
        ? reply(200, exchange.reply)
        : reply(exchange.status, { error: { code: exchange.code, message: 'A different answer came first.' } }),
    );
    const { http, apps: resource } = apps(replies);
    const [first, again, different] = answers.exchanges;

    expect(await resource.requests.answer(REQUEST, first!.answer)).toEqual({ status: 'accepted', duplicate: false });
    expect(await resource.requests.answer(REQUEST, again!.answer)).toEqual({ status: 'accepted', duplicate: true });
    const error = await refused(() => resource.requests.answer(REQUEST, different!.answer));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('app_request_already_answered');

    expect(http.requests).toHaveLength(3);
    for (const [index, request] of http.requests.entries()) {
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe(answers.path);
      expect(bodyOf(request)).toEqual(answers.exchanges[index]!.answer);
    }
  });

  it('is sent once, and the caller sends the same answer again after a lost one', async () => {
    await expectSentOnce(
      (transport) => new AppsResource(transport).requests.answer(REQUEST, { outcome: 'paid' }),
      reply(200, { status: 'accepted', duplicate: true }),
    );
  });

  it('refuses a bad id, an answer that is not an object with an outcome, and one over 16 KB, before sending', async () => {
    const fits = { outcome: 'paid', note: '' };
    fits.note = 'x'.repeat(MAX_APP_ANSWER_BYTES - JSON.stringify(fits).length);
    const tooBig = { ...fits, note: `${fits.note}x` };
    const cases: Array<[string, unknown]> = [
      ['apr_1', { outcome: 'paid' }],
      [REQUEST, ['paid']],
      [REQUEST, 'paid'],
      [REQUEST, null],
      [REQUEST, { reference: 'x' }],
      [REQUEST, { outcome: 3 }],
      [REQUEST, new (class Answer {
        outcome = 'paid';
      })()],
      [REQUEST, tooBig],
    ];
    for (const [id, answer] of cases) {
      const { http, apps: resource } = apps([reply(200, { status: 'accepted' })]);
      expect(await refused(() => resource.requests.answer(id, answer as { outcome: string }))).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
    const { http, apps: resource } = apps([reply(200, { status: 'accepted' })]);
    await resource.requests.answer(REQUEST, fits);
    expect(http.requests[0]?.body).toHaveLength(MAX_APP_ANSWER_BYTES);
  });

  it("raises each of Siren's refusals with its code", async () => {
    const cases: Array<[number, string, new (...args: never[]) => Error]> = [
      [404, 'app_request_not_found', NotFoundError],
      [403, 'app_inactive', PermissionError],
      [403, 'app_answer_forbidden', PermissionError],
      [422, 'app_answer_invalid', ValidationError],
      [401, 'app_answer_unauthorized', AuthenticationError],
    ];
    for (const [status, code, kind] of cases) {
      const { apps: resource } = apps([reply(status, { error: { code, message: 'Refused.' } })]);
      const error = await refused(() => resource.requests.answer(REQUEST, { outcome: 'paid' }));
      expect(error, code).toBeInstanceOf(kind);
      expect((error as SirenError).code).toBe(code);
    }
    for (const body of [{ status: 'queued' }, { status: 'accepted', duplicate: 'yes' }, []]) {
      const { apps: resource } = apps([reply(200, body)]);
      expect(await refused(() => resource.requests.answer(REQUEST, { outcome: 'paid' }))).toBeInstanceOf(
        UnexpectedResponseError,
      );
    }
  });

  it("raises a person's answer to an ask that needs no attention as ConflictError app_request_not_needing_attention, and a code it does not know as Siren sent it", async () => {
    const { apps: resource } = apps([AppAnswers.notNeedingAttention()]);
    const error = await refused(() => resource.requests.answer(REQUEST, { outcome: 'paid' }));
    expect(error).toBeInstanceOf(ConflictError);
    expect(appErrorCode(error)).toBe(AppErrorCode.NotNeedingAttention);
    expect(AppErrorCode.NotNeedingAttention).toBe('app_request_not_needing_attention');
    expect((error as Error).message).toBe('A person may answer only a request that needs attention. The app may still answer this one.');

    const unknown = apps([AppAnswers.unknownRefusal()]);
    const other = await refused(() => unknown.apps.requests.answer(REQUEST, { outcome: 'paid' }));
    expect(other).toBeInstanceOf(ConflictError);
    expect(appErrorCode(other)).toBe('made_up_refusal_code');
    expect((other as Error).message).toBe('Siren refused this answer for a reason this SDK does not know.');
  });

  // Siren's key check answers a missing or unknown bearer with 401 and no code, before the answer
  // route runs (captures apps-answer-401-no-bearer and apps-answer-401-unknown-key, from
  // saas/Auth/ApiKeyAuthMiddleware.php line 133 on feat/apps at 1557b0030).
  it('gives the uncoded 401 of a missing or unknown bearer the code app_answer_unauthorized, with a message that names siren apps rotate-key', async () => {
    for (const name of ['apps-answer-401-no-bearer', 'apps-answer-401-unknown-key']) {
      const { http, apps: resource } = apps([capturedReply(name)]);
      const error = await refused(() => resource.requests.answer(REQUEST, { outcome: 'paid' }));
      expect(error, name).toBeInstanceOf(AuthenticationError);
      expect((error as SirenError).code, name).toBe('app_answer_unauthorized');
      expect(appErrorCode(error), name).toBe('app_answer_unauthorized');
      expect((error as SirenError).statusCode).toBe(401);
      expect((error as Error).message).toContain('run siren apps rotate-key <app key>');
      expect(((error as Error).cause as Error).message).toBe(capturedBody<{ error: { message: string } }>(name).error.message);
      expect(http.requests.length, name).toBeLessThanOrEqual(2);
    }

    const other = apps([capturedReply('apps-answer-401-unknown-key')]);
    const listed = await refused(() => other.apps.list());
    expect(listed).toBeInstanceOf(AuthenticationError);
    expect(appErrorCode(listed)).toBeUndefined();

    const coded = apps([capturedReply('apps-list-401-app-key')]);
    const keyRefused = await refused(() => coded.apps.requests.answer(REQUEST, { outcome: 'paid' }));
    expect((keyRefused as SirenError).code).toBe('api_key_not_accepted');
  });
});

describe('apps-cli: sandbox and live keys', () => {
  const testKey = `sk_test_${'0a'.repeat(32)}`;
  const liveKey = `sk_live_${'0a'.repeat(32)}`;

  it('sends a sandbox key with no baseUrl to the sandbox', async () => {
    const http = new FakeHttpClient([reply(200, [])]);
    await new Siren({ apiKey: testKey, httpClient: http }).apps.list();
    expect(http.requests[0]?.url).toBe(`${SANDBOX_BASE_URL}/apps`);

    const live = new FakeHttpClient([reply(200, [])]);
    await new Siren({ apiKey: liveKey, httpClient: live }).apps.list();
    expect(live.requests[0]?.url).toBe(`${DEFAULT_BASE_URL}/apps`);
  });

  it('refuses a sandbox key sent to the live API and a live key sent to the sandbox, without quoting the key', () => {
    const cases: Array<[string, string]> = [
      [testKey, DEFAULT_BASE_URL],
      [testKey, 'https://API.sirenaffiliates.com/siren/v1/'],
      [liveKey, SANDBOX_BASE_URL],
    ];
    for (const [apiKey, baseUrl] of cases) {
      let error: unknown;
      try {
        new Siren({ apiKey, baseUrl, httpClient: new FakeHttpClient([]) });
      } catch (caught) {
        error = caught;
      }
      expect(error, baseUrl).toBeInstanceOf(SirenError);
      expect((error as Error).message).not.toContain(apiKey.slice(8));
    }
  });

  it('lets either kind of key reach any other address', async () => {
    for (const apiKey of [testKey, liveKey]) {
      const http = new FakeHttpClient([reply(200, [])]);
      await new Siren({ apiKey, baseUrl: 'http://localhost:33918/siren/v1', httpClient: http }).apps.list();
      expect(http.requests[0]?.url).toBe('http://localhost:33918/siren/v1/apps');
    }
  });
});
