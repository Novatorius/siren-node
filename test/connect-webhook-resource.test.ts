import { describe, expect, it } from 'vitest';
import { ApiError, ConnectionError, HttpClientError, MissingScopeError, NotFoundError, SirenError, UnexpectedResponseError } from '../src/index';
import { ConnectScope } from '../src/connect/index';
import type { ConnectWebhookResource } from '../src/connect/index';
import type { HttpRequest } from '../src/http';
import { reply } from './http-fakes';
import { BASE, ConnectAnswers, connectOver } from './connect-fakes';

/*
 * Slice 5 acceptance tests for packet P4: ConnectWebhookResource, the
 * connected site's own subscription at `/connect/webhook`.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam, answered with the bodies the
 * controllers in lib/Webhooks/Service/Rest/Connector build at b6f7140d0
 * (test/connect-fakes.ts). One fixture test per route.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`. The packet that removes the last
 * `.skip` in this file deletes this paragraph too. Nothing else here changes.
 */

const NONCE = 'n0nce_ABCDEFGHIJKL';
const params = { targetUrl: 'https://store.example/siren/webhook', events: ['conversion.approved', 'payout.paid'] };
const withSecret = { ...ConnectAnswers.webhook, signingSecret: ConnectAnswers.signingSecret };

type Call = (webhook: ConnectWebhookResource) => Promise<unknown>;

const ROUTES: Array<[string, Call, string, string, unknown, number, unknown]> = [
  ['replace', (w) => w.replace(params), 'PUT', '/connect/webhook', params, 201, withSecret],
  ['get', (w) => w.get(), 'GET', '/connect/webhook', undefined, 200, ConnectAnswers.webhook],
  ['delete', (w) => w.delete(), 'DELETE', '/connect/webhook', undefined, 200, ConnectAnswers.deleted],
  ['test', (w) => w.test(NONCE), 'POST', '/connect/webhook/test', { nonce: NONCE }, 200, ConnectAnswers.tested],
  ['deliveries', (w) => w.deliveries(), 'GET', '/connect/webhook/deliveries', undefined, 200, [ConnectAnswers.delivery]],
];

function bodyOf(request: HttpRequest): unknown {
  return request.body === undefined ? undefined : JSON.parse(request.body);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

function webhookOver(...args: Parameters<typeof connectOver>) {
  const ctx = connectOver(...args);
  return { ...ctx, webhook: ctx.connect.webhook };
}

describe('P4: ConnectWebhookResource routes', () => {
  it.skip.each(ROUTES)('%s sends its route once with the bearer token and answers the body as sent', async (_name, call, method, path, body, status, answer) => {
    const { http, webhook } = webhookOver([reply(status, answer)]);

    const result = await call(webhook);

    expect(result).toEqual(answer);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe(method);
    expect(http.requests[0]!.url).toBe(`${BASE}${path}`);
    expect(bodyOf(http.requests[0]!)).toEqual(body);
    expect(http.bearers()).toEqual(['Bearer tok-1']);
  });

  it.skip('replace answers a 200 replacement the same way as a 201 creation', async () => {
    const { webhook } = webhookOver([reply(200, withSecret)]);

    await expect(webhook.replace(params)).resolves.toEqual(withSecret);
  });
});

describe('P4: ConnectWebhookResource retries', () => {
  it.skip.each([
    ['replace, because each send rotates the signing secret', (w: ConnectWebhookResource) => w.replace(params)],
    ['test, because Cloud allows ten tests a site an hour', (w: ConnectWebhookResource) => w.test(NONCE)],
  ])('sends %s once on a 503 and on a network error', async (_name, call) => {
    for (const first of [reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }), new HttpClientError('socket hang up')]) {
      const { http, webhook } = webhookOver([first, reply(200, withSecret)]);

      const error = await failure(call(webhook));

      expect(error).toBeInstanceOf(first instanceof Error ? ConnectionError : ApiError);
      expect(http.requests).toHaveLength(1);
    }
  });

  it.skip.each([
    ['get', (w: ConnectWebhookResource) => w.get(), ConnectAnswers.webhook],
    ['delete', (w: ConnectWebhookResource) => w.delete(), ConnectAnswers.deleted],
    ['deliveries', (w: ConnectWebhookResource) => w.deliveries(), [ConnectAnswers.delivery]],
  ])('retries %s after a 503', async (_name, call, answer) => {
    const { http, webhook } = webhookOver([reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }), reply(200, answer)]);

    await expect(call(webhook)).resolves.toEqual(answer);
    expect(http.requests).toHaveLength(2);
  });

  it.skip.each(ROUTES)('%s is resent once with a refreshed token after a 401, a send-once route included', async (_name, call, _m, _p, _b, status, answer) => {
    const { http, webhook } = webhookOver([reply(401, ConnectAnswers.invalidToken), reply(status, answer)]);

    await expect(call(webhook)).resolves.toEqual(answer);
    expect(http.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});

describe('P4: ConnectWebhookResource answers', () => {
  it.skip('get raises NotFoundError when the site has no subscription', async () => {
    const { webhook } = webhookOver([reply(404, { error: { message: 'This site has no webhook subscription.', context: [] } })]);

    await expect(webhook.get()).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skip.each(ROUTES)('%s raises MissingScopeError when the token lacks connect:webhooks', async (_name, call) => {
    const { webhook } = webhookOver([reply(403, ConnectAnswers.missingScope(ConnectScope.Webhooks))]);

    await expect(call(webhook)).rejects.toBeInstanceOf(MissingScopeError);
  });

  it.skip.each([
    ['replace', (w: ConnectWebhookResource) => w.replace(params)],
    ['get', (w: ConnectWebhookResource) => w.get()],
    ['delete', (w: ConnectWebhookResource) => w.delete()],
    ['test', (w: ConnectWebhookResource) => w.test(NONCE)],
  ])('%s raises UnexpectedResponseError for a 2xx that is not a JSON object', async (_name, call) => {
    for (const answer of [reply(200, [withSecret]), { status: 200, headers: {}, body: 'not json' }, reply(200)]) {
      const { webhook } = webhookOver([answer]);
      await expect(call(webhook), JSON.stringify(answer)).rejects.toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it.skip('replace keeps the signing secret from the answer out of an UnexpectedResponseError', async () => {
    const { webhook } = webhookOver([reply(200, [withSecret])]);

    const error = await failure(webhook.replace(params));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    const details = error as UnexpectedResponseError;
    expect(`${error.message} ${JSON.stringify(error)} ${JSON.stringify(details.data ?? null)}`).not.toContain(ConnectAnswers.signingSecret);
  });

  it.skip('replace raises UnexpectedResponseError for an answer without a text signingSecret', async () => {
    for (const signingSecret of [undefined, null, 42, '']) {
      const { webhook } = webhookOver([reply(201, { ...ConnectAnswers.webhook, signingSecret })]);
      await expect(webhook.replace(params), String(signingSecret)).rejects.toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it.skip('deliveries raises UnexpectedResponseError for a 2xx that is not a JSON array', async () => {
    for (const answer of [reply(200, ConnectAnswers.delivery), { status: 200, headers: {}, body: 'not json' }, reply(200)]) {
      const { webhook } = webhookOver([answer]);
      await expect(webhook.deliveries(), JSON.stringify(answer)).rejects.toBeInstanceOf(UnexpectedResponseError);
    }
  });
});

describe('P4: ConnectWebhookResource.test nonce', () => {
  it.skip.each([
    ['16 characters', 'a'.repeat(16)],
    ['128 characters', 'Z'.repeat(128)],
    ['letters, digits, hyphens and underscores', 'aZ09-_aZ09-_aZ09'],
  ])('sends a nonce of %s', async (_name, nonce) => {
    const { http, webhook } = webhookOver([reply(200, ConnectAnswers.tested)]);

    await webhook.test(nonce);

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0]!)).toEqual({ nonce });
  });

  it.skip.each([
    ['15 characters', 'a'.repeat(15)],
    ['129 characters', 'a'.repeat(129)],
    ['a dot', 'abcdefghijklmno.'],
    ['a space', 'abcdefghijklmno '],
    ['a line break', 'abcdefghijklmno\n'],
    ['an empty string', ''],
    ['a value that is not a string', 1234567890123456],
  ])('refuses a nonce of %s with SirenError before sending', async (_name, nonce) => {
    const { http, webhook } = webhookOver([reply(200, ConnectAnswers.tested)]);

    await expect(webhook.test(nonce as string)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
