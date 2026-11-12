import { describe, expect, it } from 'vitest';
import { ApiError, MissingScopeError, UnexpectedResponseError } from '../src/index';
import { ConnectScope, ConnectWebhookResource } from '../src/connect/index';
import type { ConnectResource } from '../src/connect/index';
import type { HttpRequest } from '../src/http';
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
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`, leaves none of them skipped, and
 * changes nothing else here.
 */

type Route = {
  name: string;
  scope: ConnectScope | null;
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
  { name: 'ping', scope: null, call: (c) => c.ping(), method: 'GET', path: '/ping', body: undefined, answer: ConnectAnswers.ping },
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
  it.skip.each(ROUTES.map((route) => [route.name, route] as const))(
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

  it.skip('reportIntegrations sends PUT /connect/integrations with the whole list, and resolves with nothing on 204', async () => {
    const { http, connect } = connectOver([reply(204)]);

    const result = await connect.reportIntegrations(integrations);

    expect(result).toBeUndefined();
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('PUT');
    expect(http.requests[0]!.url).toBe(`${BASE}/connect/integrations`);
    expect(bodyOf(http.requests[0]!)).toEqual({ integrations });
    expect(header(http.requests[0]!, 'authorization')).toBe('Bearer tok-1');
  });

  it.skip('reportIntegrations sends an empty list as an empty list, so Cloud clears what it held', async () => {
    const { http, connect } = connectOver([reply(204)]);

    await connect.reportIntegrations([]);

    expect(bodyOf(http.requests[0]!)).toEqual({ integrations: [] });
  });

  it.skip('reportSiteState sends only the fields it is given', async () => {
    const { http, connect } = connectOver([reply(200, ConnectAnswers.siteState)]);

    await connect.reportSiteState({ forwarding: false });

    expect(bodyOf(http.requests[0]!)).toEqual({ forwarding: false });
  });

  it.skip('syncProducts sends only the fields it is given', async () => {
    const { http, connect } = connectOver([reply(200, ConnectAnswers.productSync)]);

    await connect.syncProducts({ platform: 'wc', pruneBefore: 1_762_000_123 });

    expect(bodyOf(http.requests[0]!)).toEqual({ platform: 'wc', pruneBefore: 1_762_000_123 });
  });
});

describe('P3: ConnectResource transport rules', () => {
  const calls: Array<[string, (connect: ConnectResource) => Promise<unknown>, HttpResponseLike]> = [
    ...ROUTES.map((route) => [route.name, route.call, reply(200, route.answer)] as [string, (c: ConnectResource) => Promise<unknown>, HttpResponseLike]),
    ['reportIntegrations', (c) => c.reportIntegrations(integrations), reply(204)],
  ];

  it.skip.each(calls)('%s is retried after a 503', async (_name, call, success) => {
    const { http, connect } = connectOver([reply(503, ConnectAnswers.unavailable, { 'Retry-After': '0' }), success]);

    await call(connect);

    expect(http.requests).toHaveLength(2);
  });

  it.skip.each(calls)('%s is resent once with a refreshed token after a 401', async (_name, call, success) => {
    const { http, tokens, connect } = connectOver([reply(401, ConnectAnswers.invalidToken), success]);

    await call(connect);

    expect(http.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(tokens.refreshAccessToken).toHaveBeenCalledWith('tok-1');
  });

  it.skip.each(ROUTES.map((route) => [route.name, route] as const))(
    '%s raises UnexpectedResponseError for a 2xx that is not a JSON object',
    async (_name, route) => {
      for (const answer of [reply(200, [route.answer]), { status: 200, headers: {}, body: 'not json' }, reply(200)]) {
        const { connect } = connectOver([answer]);
        await expect(route.call(connect), JSON.stringify(answer)).rejects.toBeInstanceOf(UnexpectedResponseError);
      }
    },
  );

  it.skip.each(ROUTES.filter((route) => route.scope !== null).map((route) => [route.name, route] as const))(
    '%s raises MissingScopeError naming its scope when Cloud refuses the token',
    async (_name, route) => {
      const { connect } = connectOver([reply(403, ConnectAnswers.missingScope(route.scope!))]);

      const error = await failure(route.call(connect));

      expect(error).toBeInstanceOf(MissingScopeError);
      expect(error.message).toContain(route.scope!);
    },
  );

  it.skip("plan raises Cloud's 503 plan_unavailable as ApiError with that code once retries run out", async () => {
    const { http, connect } = connectOver([reply(503, ConnectAnswers.planUnavailable, { 'Retry-After': '0' })], 1);

    const error = await failure(connect.plan());

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('plan_unavailable');
    expect((error as ApiError).statusCode).toBe(503);
    expect(http.requests).toHaveLength(2);
  });

  it.skip('customerEmailKey keeps the secret out of an UnexpectedResponseError', async () => {
    const { connect } = connectOver([reply(200, [ConnectAnswers.customerEmailKey])]);

    const error = await failure(connect.customerEmailKey());

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(ConnectAnswers.customerEmailKey.secret);
  });
});

describe('P3: ConnectResource.webhook', () => {
  it.skip('is a ConnectWebhookResource over the same transport', async () => {
    const { http, connect } = connectOver([reply(200, ConnectAnswers.webhook)]);

    expect(connect.webhook).toBeInstanceOf(ConnectWebhookResource);
    await connect.webhook.get();
    expect(http.bearers()).toEqual(['Bearer tok-1']);
  });
});

type HttpResponseLike = ReturnType<typeof reply>;
