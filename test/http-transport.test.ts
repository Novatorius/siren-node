import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  ApiKeyScope,
  ApiKeysResource,
  AuthenticationError,
  ConnectionError,
  EventsResource,
  HttpClientError,
  NotFoundError,
  RateLimitError,
  RecordsResource,
  SirenError,
  SiteDisconnectedError,
  WebhooksResource,
} from '../src/index';
import { HttpTransport, type HttpResponse, type HttpTransportOptions } from '../src/http';
import { CloudAnswers, FakeHttpClient, reply, spySource } from './http-fakes';

/*
 * Slice 2 acceptance tests for packet P4: HttpTransport.
 *
 * Integration shape (KB 568): the real transport and the real resources, with
 * the network mocked only at the HttpClient seam by FakeHttpClient, which
 * replays Siren Cloud answers written from Siren's source.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else here.
 */


/**
 * Fails any test whose request reaches the global fetch, so a transport that
 * ignores its client fails on that, not on a real network call.
 */
function tripwireFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('tripwire: the request went to the global fetch, not the HttpClient');
    }),
  );
}

beforeEach(tripwireFetch);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BASE_URL = 'https://cloud.test/siren/v1';

function transport(
  client: FakeHttpClient,
  tokens = spySource(),
  overrides: Partial<HttpTransportOptions> = {},
): HttpTransport {
  return new HttpTransport({
    tokens,
    client,
    baseUrl: BASE_URL,
    timeout: 1234,
    maxRetries: 0,
    ...overrides,
  });
}

/** Settle a promise and hand back what it rejected with, or fail when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

/*
 * The send-once requests: Siren cannot match a resent copy, so the transport
 * never retries them on 429, 5xx or a dropped connection (slice 1, A67). Each
 * still gets one resend after a 401, because Siren refused the credential
 * before recording anything. The list covers an event of each send-once kind
 * and both management writes. The SDK's deletes are retriable today, as in
 * the PHP SDK, and the record writes of slices 3 and 4 take the same rule
 * through the same `retriable: false` flag.
 */
const SEND_ONCE: Array<[string, (http: HttpTransport) => Promise<unknown>, unknown]> = [
  [
    'events.siteVisited',
    (http) => new EventsResource(http).siteVisited({ collaboratorId: 4021 }),
    CloudAnswers.eventTokenRefused,
  ],
  [
    'events.ingest',
    (http) => new EventsResource(http).ingest('newsletter-signup', { email: 'a@b.test' }),
    CloudAnswers.eventTokenRefused,
  ],
  ['events.sale with no externalId', (http) => new EventsResource(http).sale({ test: true }), CloudAnswers.eventTokenRefused],
  [
    'webhooks.subscriptions.create (POST)',
    (http) =>
      new WebhooksResource(http).subscriptions.create({ targetUrl: 'https://store.test/hook', events: ['*'] }),
    CloudAnswers.authenticationRequired,
  ],
  [
    'apiKeys.create (POST)',
    (http) => new ApiKeysResource(http).create({ scopes: [ApiKeyScope.AllEvents] }),
    CloudAnswers.authenticationRequired,
  ],
];

describe('P4: HttpTransport sends through the HttpClient seam', () => {
  it.skip('hands the client the whole request: method, URL with query, headers, body and timeout', async () => {
    const client = new FakeHttpClient([reply(200, [])]);
    await new RecordsResource(transport(client), '/conversions').list({ page: 2, perPage: 5, status: 'approved' });

    expect(client.requests).toHaveLength(1);
    const request = client.requests[0]!;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`${BASE_URL}/conversions?status=approved&number=5&offset=5`);
    expect(request.headers.Authorization).toBe('Bearer tok-1');
    expect(request.headers.Accept).toBe('application/json');
    expect(request.headers['User-Agent']).toBe('siren-sdk-typescript/0.3.0');
    expect(request.body).toBeUndefined();
    expect(request.timeout).toBe(1234);
  });

  it.skip('sends a JSON body as a string with the JSON content type', async () => {
    const client = new FakeHttpClient([reply(200)]);
    await new EventsResource(transport(client)).refund({ source: 'medusa', externalId: 'order_1', refundId: 're_1' });

    const request = client.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${BASE_URL}/event/refund`);
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(typeof request.body).toBe('string');
    expect(JSON.parse(request.body!)).toEqual({ source: 'medusa', externalId: 'order_1', refundId: 're_1' });
  });

  it.skip('never calls the global fetch when a client is given', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new FakeHttpClient([reply(200, [])]);
    await new RecordsResource(transport(client), '/payouts').list();

    expect(client.requests).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.skip('reads reply headers in any case, the status, and the body', async () => {
    const client = new FakeHttpClient([
      reply(202, { status: 'queued', queued: true }, { 'X-Siren-Oid': '555' }),
      reply(200, { items: [{ id: 1 }], total: 9 }),
      reply(200, [{ id: 2 }], { 'X-SIREN-ESTIMATED-COUNT': '40' }),
    ]);
    const http = transport(client);

    const result = await new EventsResource(http).sale({ source: 'medusa', externalId: 'order_9', total: 5, trackingId: 1 });
    expect(result.opportunityId).toBe(555);
    expect(result.status).toBe('queued');
    expect(result.queued).toBe(true);

    const envelope = await new RecordsResource(http, '/conversions').list();
    expect(envelope).toEqual([{ id: 1 }]);
    expect(envelope.estimatedCount).toBe(9);

    const bare = await new RecordsResource(http, '/conversions').list();
    expect(bare).toEqual([{ id: 2 }]);
    expect(bare.estimatedCount).toBe(40);
  });

  it.skip('maps an error reply from the client to the typed error, with its message and Retry-After', async () => {
    const client = new FakeHttpClient([
      reply(404, CloudAnswers.notFound),
      reply(429, { error: { message: 'Slow down.', context: [] } }, { 'retry-AFTER': '7' }),
      reply(500, undefined, {}, 'Server Melted'),
    ]);
    const records = new RecordsResource(transport(client), '/conversions');

    const notFound = await rejection(records.list());
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect((notFound as NotFoundError).message).toBe('No record found with that ID.');

    const limited = await rejection(records.list());
    expect(limited).toBeInstanceOf(RateLimitError);
    expect((limited as RateLimitError).retryAfter).toBe(7);

    const melted = await rejection(records.list());
    expect(melted).toBeInstanceOf(ApiError);
    expect((melted as ApiError).message).toBe('Server Melted');
    expect((melted as ApiError).statusCode).toBe(500);
  });

  it.skip('raises a 3xx reply as SirenError with its status and never sends again', async () => {
    const client = new FakeHttpClient([
      reply(307, undefined, { Location: 'https://elsewhere.test/collect' }, 'Temporary Redirect'),
      reply(200, []),
    ]);

    const error = await rejection(new RecordsResource(transport(client, spySource(), { maxRetries: 2 }), '/conversions').list());

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).statusCode).toBe(307);
    expect(client.requests).toHaveLength(1);
  });

  it.skip("turns an HttpClientError into ConnectionError whose cause is the host's own error", async () => {
    const hostError = new TypeError('fetch failed');
    const client = new FakeHttpClient([new HttpClientError('fetch failed', { cause: hostError })]);

    const error = await rejection(new RecordsResource(transport(client), '/conversions').list());
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).cause).toBe(hostError);
    expect((error as ConnectionError).message).toContain('fetch failed');
    expect(client.requests).toHaveLength(1);
  });

  it.skip('uses the HttpClientError itself as the cause when it carries none', async () => {
    const dropped = new HttpClientError('connect ECONNREFUSED 127.0.0.1:1');
    const client = new FakeHttpClient([dropped]);

    const error = await rejection(new RecordsResource(transport(client), '/conversions').list());
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).cause).toBe(dropped);
  });

  it.skip('resends a retriable request after an HttpClientError while retries are left', async () => {
    const client = new FakeHttpClient([new HttpClientError('socket hang up'), reply(200, [])]);
    const list = await new RecordsResource(transport(client, spySource(), { maxRetries: 1 }), '/conversions').list();

    expect(list).toEqual([]);
    expect(client.requests).toHaveLength(2);
  });

  it.skip('lets any other client error through unchanged and never resends it, even on a retriable request', async () => {
    const bug = new TypeError('host client bug');
    const client = new FakeHttpClient([bug, reply(200, [])]);

    const error = await rejection(
      new RecordsResource(transport(client, spySource(), { maxRetries: 2 }), '/conversions').list(),
    );
    expect(error).toBe(bug);
    expect(client.requests).toHaveLength(1);
  });

  it.skip.each([
    ['a 503', () => reply(503, undefined)],
    ['a 429 with Retry-After', () => reply(429, { error: { message: 'Slow down.', context: [] } }, { 'Retry-After': '30' })],
    ['an HttpClientError', () => new HttpClientError('socket hang up')],
  ])('sends a retriable read exactly once at maxRetries 0 when it gets %s, with no wait', async (_name, answer) => {
    vi.useFakeTimers();
    const client = new FakeHttpClient([answer(), reply(200, [])]);

    const error = await rejection(new RecordsResource(transport(client, spySource(), { maxRetries: 0 }), '/conversions').list());

    expect(error).toBeInstanceOf(SirenError);
    expect(client.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skip('sends a retriable read exactly twice at maxRetries 0 when the resend after a 401 gets a 503', async () => {
    const client = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
      reply(503, undefined),
      reply(200, []),
    ]);

    const error = await rejection(new RecordsResource(transport(client, spySource(), { maxRetries: 0 }), '/conversions').list());

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(503);
    expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});

describe('P4: HttpTransport reads the token from the AccessTokenSource', () => {
  it.skip('asks the source for the token on every call, so a rotated token is used on the next call', async () => {
    const tokens = spySource(['tok-A', 'tok-B']);
    const client = new FakeHttpClient([reply(200, [])]);
    const records = new RecordsResource(transport(client, tokens), '/conversions');

    await records.list();
    await records.list();

    expect(client.bearers()).toEqual(['Bearer tok-A', 'Bearer tok-B']);
    expect(tokens.getAccessToken).toHaveBeenCalledTimes(2);
    expect(tokens.refreshAccessToken).not.toHaveBeenCalled();
  });

  it.skip('reads the token once per call: a retry carries the same token without asking again', async () => {
    vi.useFakeTimers();
    const tokens = spySource(['tok-A', 'tok-B']);
    const client = new FakeHttpClient([reply(503, undefined), reply(200, [])]);

    const pending = new RecordsResource(transport(client, tokens, { maxRetries: 1 }), '/conversions').list();
    await vi.runAllTimersAsync();
    await pending;

    expect(client.bearers()).toEqual(['Bearer tok-A', 'Bearer tok-A']);
    expect(tokens.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it.skip('lets an error from getAccessToken through unchanged and sends nothing', async () => {
    const broken = new Error('token store offline');
    const tokens = spySource();
    tokens.getAccessToken.mockRejectedValueOnce(broken);
    const client = new FakeHttpClient([reply(200, [])]);

    const error = await rejection(new RecordsResource(transport(client, tokens), '/conversions').list());
    expect(error).toBe(broken);
    expect(client.requests).toHaveLength(0);
  });

  it.skip.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ])('refuses a token that is %s with SirenError and sends nothing', async (_name, token) => {
    const tokens = spySource();
    tokens.getAccessToken.mockResolvedValueOnce(token);
    const client = new FakeHttpClient([reply(200, [])]);

    const error = await rejection(new RecordsResource(transport(client, tokens), '/conversions').list());

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toMatch(/getAccessToken/);
    expect(client.requests).toHaveLength(0);
  });
});

describe('P4: HttpTransport refreshes once on a 401 and resends', () => {
  it.skip('refreshes with the refused token and resends the same request with the new one', async () => {
    const tokens = spySource(['tok-1'], 'tok-2');
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [{ id: 3 }])]);

    const list = await new RecordsResource(transport(client, tokens), '/conversions').list({ status: 'approved' });

    expect(list).toEqual([{ id: 3 }]);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(tokens.refreshAccessToken).toHaveBeenCalledWith('tok-1');
    expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    const [first, second] = client.requests;
    expect(second!.method).toBe(first!.method);
    expect(second!.url).toBe(first!.url);
    expect(second!.body).toBe(first!.body);
  });

  it.skip.each(SEND_ONCE)(
    'resends %s once after a 401, writes included, and sends it exactly twice',
    async (_name, call, refusal) => {
      const tokens = spySource(['tok-1'], 'tok-2');
      const client = new FakeHttpClient([reply(401, refusal), reply(200, { id: 1 })]);

      await call(transport(client, tokens, { maxRetries: 2 }));

      expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
      expect(client.requests[1]!.body).toBe(client.requests[0]!.body);
    },
  );

  it.skip.each(SEND_ONCE)(
    'never sends %s a third time, whatever the resend gets, with retries on',
    async (_name, call, refusal) => {
      vi.useFakeTimers();
      const afterResend: Array<[HttpResponse | Error, new (...args: never[]) => Error]> = [
        [reply(503, undefined), ApiError],
        [reply(429, { error: { message: 'Slow down.', context: [] } }, { 'Retry-After': '1' }), RateLimitError],
        [new HttpClientError('socket hang up'), ConnectionError],
        [reply(401, CloudAnswers.siteDisconnected), SiteDisconnectedError],
      ];
      for (const [answer, raised] of afterResend) {
        const tokens = spySource(['tok-1'], 'tok-2');
        const client = new FakeHttpClient([reply(401, refusal), answer, reply(200, { id: 1 })]);

        const pending = rejection(call(transport(client, tokens, { maxRetries: 2 })));
        await vi.runAllTimersAsync();
        const error = await pending;

        expect(error).toBeInstanceOf(raised);
        expect(client.requests).toHaveLength(2);
        expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.skip.each(SEND_ONCE)(
    'never retries %s when its first send loses the connection or gets a 503, with retries on',
    async (_name, call) => {
      vi.useFakeTimers();
      for (const answer of [new HttpClientError('socket hang up'), reply(503, undefined)]) {
        const client = new FakeHttpClient([answer, reply(200, { id: 1 })]);

        const pending = rejection(call(transport(client, spySource(), { maxRetries: 2 })));
        await vi.runAllTimersAsync();
        const error = await pending;

        expect(error).toBeInstanceOf(answer instanceof Error ? ConnectionError : ApiError);
        expect(client.requests).toHaveLength(1);
      }
    },
  );

  it.skip('surfaces SiteDisconnectedError when the resend gets a second 401 for a revoked site', async () => {
    const tokens = spySource(['tok-1'], 'tok-2');
    const client = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
      reply(401, CloudAnswers.siteDisconnected),
    ]);

    const error = await rejection(
      new EventsResource(transport(client, tokens)).sale({ source: 'medusa', externalId: 'order_1', total: 5, trackingId: 1 }),
    );

    expect(error).toBeInstanceOf(SiteDisconnectedError);
    expect((error as SiteDisconnectedError).message).toBe('This site is no longer connected.');
    expect((error as SiteDisconnectedError).statusCode).toBe(401);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it.skip('refreshes only once per call: a second 401 is raised without another refresh or send', async () => {
    const tokens = spySource(['tok-1'], 'tok-2');
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired)]);

    const error = await rejection(new RecordsResource(transport(client, tokens, { maxRetries: 2 }), '/conversions').list());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toBeInstanceOf(SiteDisconnectedError);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(client.requests).toHaveLength(2);
  });

  it.skip.each([
    ['a 403 missing_scope', () => reply(403, { error: { message: 'Missing scope.', code: 'missing_scope', context: [] } })],
    ['a 409', () => reply(409, { error: { message: 'Already exists.', context: [] } })],
    ['a 404', () => reply(404, CloudAnswers.notFound)],
  ])('never refreshes on %s: it is sent once and raised', async (_name, answer) => {
    const tokens = spySource(['tok-1'], 'tok-2');
    const client = new FakeHttpClient([answer(), reply(200, [])]);

    const error = await rejection(new RecordsResource(transport(client, tokens, { maxRetries: 2 }), '/conversions').list());

    expect(error).toBeInstanceOf(SirenError);
    expect(tokens.refreshAccessToken).not.toHaveBeenCalled();
    expect(client.requests).toHaveLength(1);
  });

  it.skip('sends the resend at once, with no wait', async () => {
    vi.useFakeTimers();
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    const pending = new RecordsResource(transport(client, spySource(), { maxRetries: 2 }), '/conversions').list();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.requests).toHaveLength(2);
    expect(await pending).toEqual([]);
  });

  it.skip('refreshes only once per call even when a retry comes between two 401s', async () => {
    vi.useFakeTimers();
    const tokens = spySource(['tok-1'], 'tok-2');
    const client = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
      reply(503, undefined),
      reply(401, CloudAnswers.authenticationRequired),
      reply(200, []),
    ]);

    const pending = rejection(new RecordsResource(transport(client, tokens, { maxRetries: 1 }), '/conversions').list());
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(client.requests).toHaveLength(3);
  });

  it.skip("raises Siren's event-route revoked-site answer as AuthenticationError with its message after the resend", async () => {
    const client = new FakeHttpClient([
      reply(401, CloudAnswers.eventTokenRefused),
      reply(401, CloudAnswers.eventSiteRevoked),
    ]);

    const error = await rejection(new EventsResource(transport(client)).siteVisited({ collaboratorId: 4021 }));

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toBeInstanceOf(SiteDisconnectedError);
    expect((error as AuthenticationError).message).toBe(CloudAnswers.eventSiteRevoked.error.message);
    expect(client.requests).toHaveLength(2);
  });

  it.skip.each([
    ['null', null],
    ['an empty string', ''],
    ['undefined', undefined],
    ['a number', 7],
  ])('raises the first 401 and sends nothing more when the refresh answers %s', async (_name, refreshed) => {
    const tokens = spySource(['tok-1'], refreshed as string | null);
    const client = new FakeHttpClient([reply(401, CloudAnswers.siteDisconnected), reply(200, [])]);

    const error = await rejection(new RecordsResource(transport(client, tokens), '/conversions').list());

    expect(error).toBeInstanceOf(SiteDisconnectedError);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(client.requests).toHaveLength(1);
  });

  it.skip('lets an error from refreshAccessToken through unchanged and sends nothing more', async () => {
    const refusal = new Error('refresh token revoked');
    const client = new FakeHttpClient([reply(401, CloudAnswers.authenticationRequired), reply(200, [])]);

    const error = await rejection(
      new RecordsResource(transport(client, spySource(['tok-1'], refusal)), '/conversions').list(),
    );

    expect(error).toBe(refusal);
    expect(client.requests).toHaveLength(1);
  });

  it.skip.each([
    ['a second 401', [reply(401, CloudAnswers.authenticationRequired)]],
    ['a 503 after the resend', [reply(401, CloudAnswers.authenticationRequired), reply(503, undefined)]],
    ['a 429 after the resend', [reply(401, CloudAnswers.authenticationRequired), reply(429, undefined, { 'Retry-After': '1' })]],
    ['a lost connection after the resend', [reply(401, CloudAnswers.authenticationRequired), new HttpClientError('socket hang up')]],
  ] as Array<[string, Array<HttpResponse | Error>]>)(
    'keeps the refused and the fresh token out of the error it raises on %s',
    async (_name, answers) => {
      const tokens = spySource(['sk_secret_first'], 'sk_secret_second');
      const client = new FakeHttpClient(answers);

      const error = (await rejection(new RecordsResource(transport(client, tokens), '/conversions').list())) as SirenError;

      expect(client.requests).toHaveLength(2);
      const seen = [
        error.message,
        error.stack ?? '',
        JSON.stringify(error),
        String(error.cause ?? ''),
        JSON.stringify(error.data ?? null),
      ].join(' ');
      expect(seen).not.toContain('sk_secret_first');
      expect(seen).not.toContain('sk_secret_second');
    },
  );

  it.skip("removes the token from a client error's message when it builds ConnectionError, and keeps the client error as it is", async () => {
    const leaky = new HttpClientError('POST https://cloud.test failed, Authorization: Bearer sk_secret_first');
    const client = new FakeHttpClient([leaky]);

    const error = await rejection(
      new RecordsResource(transport(client, spySource(['sk_secret_first'])), '/conversions').list(),
    );

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).message).not.toContain('sk_secret_first');
    expect((error as ConnectionError).message).toContain('Authorization: Bearer');
    expect((error as ConnectionError).cause).toBe(leaky);
  });

  it.skip('does not count the resend as a retry: a retriable request still gets its retries after a refresh', async () => {
    const client = new FakeHttpClient([
      reply(401, CloudAnswers.authenticationRequired),
      reply(503, undefined),
      reply(200, [{ id: 4 }]),
    ]);

    const list = await new RecordsResource(transport(client, spySource(), { maxRetries: 1 }), '/conversions').list();

    expect(list).toEqual([{ id: 4 }]);
    expect(client.bearers()).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
  });

  it.skip('sends a retriable request at most maxRetries + 2 times', async () => {
    vi.useFakeTimers();
    const client = new FakeHttpClient([
      reply(503, undefined),
      reply(401, CloudAnswers.authenticationRequired),
      reply(503, undefined),
    ]);

    const pending = rejection(new RecordsResource(transport(client, spySource(), { maxRetries: 2 }), '/conversions').list());
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(503);
    expect(client.requests).toHaveLength(4);
  });
});
