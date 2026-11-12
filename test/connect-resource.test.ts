import { describe, expect, it } from 'vitest';
import { ApiError, ConnectionError, HttpClientError, MissingScopeError, PermissionError, UnexpectedResponseError } from '../src/index';
import { ConnectScope, ConnectWebhookResource } from '../src/connect/index';
import type { ConnectResource } from '../src/connect/index';
import type { HttpRequest } from '../src/http';
import { shown } from './error-text';
import { reply } from './http-fakes';
import { BASE, ConnectAnswers, connectOver } from './connect-fakes';

/*
 * Slice 5 acceptance tests for packet P3: ConnectResource, the `/connect/*`
 * routes and `/ping` a connected site calls with its OAuth access token.
 *
 * Integration shape (KB 568): the real ConnectResource over the real
 * HttpTransport, with a FakeHttpClient at the HttpClient seam, answered with
 * the bodies in test/connect-fakes.ts. The done condition is one fixture test
 * per route: each row below sends one route and checks its method, URL, body,
 * bearer token and the answer it resolves with.
 */

type Route = {
  name: string;
  scope: ConnectScope;
  call: (connect: ConnectResource) => Promise<unknown>;
  method: string;
  path: string;
  body: unknown;
  answer: Record<string, unknown>;
};

const products = [
  { id: 'prod_01', parentId: null, name: 'Hat', sku: 'HAT', type: 'simple', status: 'published', editUrl: 'https://store.example/app/products/prod_01' },
  { id: 'prod_02', name: 'Scarf' },
];

const ROUTES: Route[] = [
  { name: 'plan', scope: ConnectScope.Read, call: (c) => c.plan(), method: 'GET', path: '/connect/plan', body: undefined, answer: ConnectAnswers.plan },
  { name: 'updateGrant', scope: ConnectScope.Read, call: (c) => c.updateGrant(), method: 'POST', path: '/connect/update-grant', body: undefined, answer: ConnectAnswers.updateGrant },
  {
    name: 'reportSiteState',
    scope: ConnectScope.Read,
    call: (c) => c.reportSiteState({ forwarding: true, cutOverAt: 1_762_000_000, localDataDeletedAt: null, migrationComplete: true }),
    method: 'PUT',
    path: '/connect/site-state',
    body: { forwarding: true, cutOverAt: 1_762_000_000, localDataDeletedAt: null, migrationComplete: true },
    answer: ConnectAnswers.siteState,
  },
  {
    name: 'syncProducts',
    scope: ConnectScope.RecordsWrite,
    call: (c) => c.syncProducts({ platform: 'medusa', products, removed: ['prod_09'], pruneBefore: null }),
    method: 'PUT',
    path: '/connect/products',
    body: { platform: 'medusa', products, removed: ['prod_09'], pruneBefore: null },
    answer: ConnectAnswers.productSync,
  },
  { name: 'disconnect', scope: ConnectScope.Read, call: (c) => c.disconnect(), method: 'POST', path: '/connect/disconnect', body: undefined, answer: ConnectAnswers.disconnected },
  { name: 'migrationWindow', scope: ConnectScope.Migrate, call: (c) => c.migrationWindow(), method: 'GET', path: '/connect/migration-window', body: undefined, answer: ConnectAnswers.migrationWindow },
  { name: 'customerEmailKey', scope: ConnectScope.RecordsRead, call: (c) => c.customerEmailKey(), method: 'GET', path: '/connect/customer-email-key', body: undefined, answer: ConnectAnswers.customerEmailKey },
  { name: 'ping', scope: ConnectScope.Ingest, call: (c) => c.ping(), method: 'GET', path: '/ping', body: undefined, answer: ConnectAnswers.ping },
];

const integrations = [
  { id: 'medusa', name: 'Medusa', supports: ['coupons', 'customers', 'products'] },
  { id: 'stripe-checkout' },
];

function header(request: HttpRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

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

describe('P3: ConnectResource routes', () => {
  it.each(ROUTES.map((route) => [route.name, route] as const))(
    '%s sends its route once with the bearer token and answers Cloud\'s body as sent',
    async (_name, route) => {
      const answer = { ...route.answer, addedLater: 'kept' };
      const { http, connect } = connectOver([reply(200, answer)]);

      const result = await route.call(connect);

      expect(result).toEqual(answer);
      expect(http.requests).toHaveLength(1);
      const [request] = http.requests;
      expect(request!.method).toBe(route.method);
      expect(request!.url).toBe(`${BASE}${route.path}`);
      expect(bodyOf(request!)).toEqual(route.body);
      expect(header(request!, 'authorization')).toBe('Bearer tok-1');
    },
  );

  it('reportIntegrations sends PUT /connect/integrations with the whole list, and resolves with nothing on 204', async () => {
    const { http, connect } = connectOver([reply(204)]);

    const result = await connect.reportIntegrations(integrations);

    expect(result).toBeUndefined();
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('PUT');
    expect(http.requests[0]!.url).toBe(`${BASE}/connect/integrations`);
    expect(bodyOf(http.requests[0]!)).toEqual({ integrations });
    expect(header(http.requests[0]!, 'authorization')).toBe('Bearer tok-1');
  });

  it('reportIntegrations sends an empty list as an empty list, so Cloud clears what it held', async () => {
    const { http, connect } = connectOver([reply(204)]);

    await connect.reportIntegrations([]);

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0]!)).toEqual({ integrations: [] });
  });

  it('reportSiteState sends only the fields it is given', async () => {
    const { http, connect } = connectOver([reply(200, ConnectAnswers.siteState)]);

    await connect.reportSiteState({ forwarding: false });

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0]!)).toEqual({ forwarding: false });
  });

  it('syncProducts sends only the fields it is given', async () => {
    const { http, connect } = connectOver([reply(200, ConnectAnswers.productSync)]);

    await connect.syncProducts({ platform: 'wc', pruneBefore: 1_762_000_123 });

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0]!)).toEqual({ platform: 'wc', pruneBefore: 1_762_000_123 });
  });
});

describe('P3: ConnectResource transport rules', () => {
  const calls: Array<[string, (connect: ConnectResource) => Promise<unknown>, HttpResponseLike]> = [
    ...ROUTES.map((route) => [route.name, route.call, reply(200, route.answer)] as [string, (c: ConnectResource) => Promise<unknown>, HttpResponseLike]),
    ['reportIntegrations', (c) => c.reportIntegrations(integrations), reply(204)],
  ];

  const sentOnce = ['disconnect', 'reportSiteState', 'reportIntegrations', 'syncProducts'];

  it.each(calls.filter(([name]) => !sentOnce.includes(name)))('%s is retried after a 503', async (_name, call, success) => {
    const { http, connect } = connectOver([reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }), success]);

    await call(connect);

    expect(http.requests).toHaveLength(2);
  });

  it.each([
    ['a 503', reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }), ApiError],
    ['a network error', new HttpClientError('socket hang up'), ConnectionError],
  ])('disconnect is sent once on %s, since Cloud answers a resend after the commit with 401', async (_name, first, type) => {
    const { http, connect } = connectOver([first, reply(200, ConnectAnswers.disconnected)], 3);

    await expect(connect.disconnect()).rejects.toBeInstanceOf(type);
    expect(http.requests).toHaveLength(1);
  });

  it.each(calls.filter(([name]) => sentOnce.includes(name) && name !== 'disconnect'))(
    '%s is sent once on a 503 and on a network error, since the site queue reports again',
    async (_name, call, success) => {
      for (const first of [reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }), new HttpClientError('socket hang up')]) {
        const { http, connect } = connectOver([first, success], 3);

        await expect(call(connect)).rejects.toBeInstanceOf(first instanceof Error ? ConnectionError : ApiError);
        expect(http.requests).toHaveLength(1);
      }
    },
  );

  it.each(calls)('%s is resent once with a refreshed token after a 401', async (_name, call, success) => {
    const { http, tokens, connect } = connectOver([reply(401, ConnectAnswers.invalidToken), success]);

    await call(connect);

    expect(http.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(tokens.refreshAccessToken).toHaveBeenCalledWith('tok-1');
  });

  it.each(ROUTES.map((route) => [route.name, route] as const))(
    '%s raises UnexpectedResponseError for a 2xx that is not a JSON object',
    async (_name, route) => {
      for (const answer of [reply(200, [route.answer]), { status: 200, headers: {}, body: 'not json' }, reply(200)]) {
        const { connect } = connectOver([answer]);
        await expect(route.call(connect), JSON.stringify(answer)).rejects.toBeInstanceOf(UnexpectedResponseError);
      }
    },
  );

  // `/ping` refuses in its own words, tested below.
  it.each([
    ...ROUTES.filter((route) => route.name !== 'ping').map((route) => [route.name, route.call, route.scope] as const),
    ['reportIntegrations', (c: ConnectResource) => c.reportIntegrations(integrations), ConnectScope.RecordsWrite] as const,
  ])('%s raises MissingScopeError with the scope Cloud names when Cloud refuses the token', async (_name, call, scope) => {
    const { http, connect } = connectOver([reply(403, ConnectAnswers.missingScope(scope))]);

    const error = await failure(call(connect));

    expect(error).toBeInstanceOf(MissingScopeError);
    expect((error as MissingScopeError).scope).toBe(scope);
    expect(http.requests).toHaveLength(1);
  });

  it("ping raises PermissionError on Cloud's 403 for a token without connect:ingest", async () => {
    const { http, connect } = connectOver([reply(403, ConnectAnswers.ingestRefused)]);

    const error = await failure(connect.ping());

    expect(error).toBeInstanceOf(PermissionError);
    expect(error.message).toBe(ConnectAnswers.ingestRefused.error.message);
    expect(http.requests).toHaveLength(1);
  });

  it("plan raises Cloud's 503 plan_unavailable as ApiError with that code once retries run out", async () => {
    const { http, connect } = connectOver([reply(503, ConnectAnswers.planUnavailable, { 'Retry-After': '0' })], 1);

    const error = await failure(connect.plan());

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('plan_unavailable');
    expect((error as ApiError).statusCode).toBe(503);
    expect(http.requests).toHaveLength(2);
  });

  it.each([
    ['customerEmailKey without keyId', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, keyId: undefined }],
    ['customerEmailKey with an empty keyId', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, keyId: '' }],
    ['customerEmailKey with an empty secret', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, secret: '' }],
    ['customerEmailKey with a secret that is not text', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, secret: 42 }],
    ['customerEmailKey with no fields', (c: ConnectResource) => c.customerEmailKey(), {}],
    ['customerEmailKey with a secret that is not base64', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, secret: 'this is not base64 at all, though it runs well past sixteen bytes' }],
    ['customerEmailKey with a key under 16 bytes', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, secret: 'c2hvcnQta2V5' }],
    ['customerEmailKey with a 15-byte key', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, secret: 'ZmlmdGVlbi1ieXRlcy1r' }],
    ['customerEmailKey with a base64url secret', (c: ConnectResource) => c.customerEmailKey(), { ...ConnectAnswers.customerEmailKey, secret: '-_-_dXJsLXNhZmUta2V5LXBhZA' }],
    ['updateGrant without grant', (c: ConnectResource) => c.updateGrant(), { ...ConnectAnswers.updateGrant, grant: undefined }],
    ['updateGrant with an empty grant', (c: ConnectResource) => c.updateGrant(), { ...ConnectAnswers.updateGrant, grant: '' }],
  ] as const)('%s raises UnexpectedResponseError, so a missing secret never reads as one, and shows none of the answer', async (_name, call, answer) => {
    const { connect } = connectOver([reply(200, answer)]);

    const error = await failure(call(connect));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    for (const value of [(answer as { secret?: unknown }).secret, (answer as { grant?: unknown }).grant]) {
      if (typeof value === 'string' && value !== '') expect(shown(error)).not.toContain(value);
    }
  });

  it('customerEmailKey accepts a key of exactly 16 bytes', async () => {
    const answer = { ...ConnectAnswers.customerEmailKey, secret: 'c2l4dGVlbi1ieXRlcy1reQ==' };
    const { connect } = connectOver([reply(200, answer)]);

    await expect(connect.customerEmailKey()).resolves.toEqual(answer);
  });

  it.each([
    ['customerEmailKey', (c: ConnectResource) => c.customerEmailKey(), ConnectAnswers.customerEmailKey, ConnectAnswers.customerEmailKey.secret],
    ['updateGrant', (c: ConnectResource) => c.updateGrant(), ConnectAnswers.updateGrant, ConnectAnswers.updateGrant.grant],
  ] as const)('%s keeps the secret from the answer out of an UnexpectedResponseError', async (_name, call, answer, secret) => {
    const { connect } = connectOver([reply(200, [answer])]);

    const error = await failure(call(connect));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(shown(error)).not.toContain(secret);
  });
});

describe('P3: ConnectResource.webhook', () => {
  it('is a ConnectWebhookResource over the same transport', async () => {
    const { http, connect } = connectOver([reply(200, ConnectAnswers.webhook)]);

    expect(connect.webhook).toBeInstanceOf(ConnectWebhookResource);
    await connect.webhook.get();
    expect(http.bearers()).toEqual(['Bearer tok-1']);
  });
});

type HttpResponseLike = ReturnType<typeof reply>;
