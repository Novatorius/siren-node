import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  SirenError,
  UnexpectedResponseError,
  WebhookSubscriptionsResource,
} from '../src/index';
import type { WebhookDelivery, WebhookSubscription, WebhookTestResult } from '../src/index';
import type { HttpTransport } from '../src/http';
import { failOnGlobalFetch, reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, pathOf, queryOf, transportOver } from './record-fakes';
import { WebhookAnswers } from './sdk-gaps-fakes';

/*
 * apps-sdk-gaps acceptance tests: the webhook subscription calls the SDK
 * lacked. Siren Cloud serves each to an API key, by saas/Auth/ApiKeyRoutes.php
 * at 20c47873d, to organization keys only:
 *
 * - GET /webhooks/{id} and GET /webhooks/{id}/deliveries, with
 *   `webhook-subscriptions:read` or `webhook-subscriptions:manage`.
 * - PUT /webhooks/{id} and POST /webhooks/{id}/test, with
 *   `webhook-subscriptions:manage`.
 *
 * `events()` was already in the SDK. The answers come from
 * test/sdk-gaps-fakes.ts, which cites the Cloud file behind each.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 */

beforeEach(failOnGlobalFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, subscriptions: new WebhookSubscriptionsResource(built.transport) };
}

const BAD_IDS = [0, -1, 1.5, Number.NaN, '12' as unknown as number];

describe('apps-sdk-gaps: webhooks.subscriptions.retrieve', () => {
  it('reads GET /webhooks/{id} and answers the subscription without its secret', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.subscription)]);

    const subscription: WebhookSubscription = await subscriptions.retrieve(12);

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/webhooks/12']);
    expect(queryOf(http.requests[0])).toEqual({});
    expect(subscription).toEqual(WebhookAnswers.subscription);
    expect(subscription).not.toHaveProperty('signingSecret');
  });

  it('throws NotFoundError for an id the organization does not have', async () => {
    const { subscriptions } = over([reply(404, WebhookAnswers.notFound)]);

    await expect(subscriptions.retrieve(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an id that is not a positive whole number before sending', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.subscription)]);

    for (const id of BAD_IDS) {
      await expect(subscriptions.retrieve(id)).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it('throws UnexpectedResponseError when a 2xx body is not a JSON object', async () => {
    const { subscriptions } = over([reply(200, [WebhookAnswers.subscription])]);

    await expect(subscriptions.retrieve(12)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('retries, as a read', async () => {
    await expectRetried(
      (transport: HttpTransport) => new WebhookSubscriptionsResource(transport).retrieve(12),
      reply(200, WebhookAnswers.subscription),
    );
  });
});

describe('apps-sdk-gaps: webhooks.subscriptions.update', () => {
  it('names the fields PUT /webhooks/{id} reads', () => {
    expect(WebhookSubscriptionsResource.UPDATE_FIELDS).toEqual(['targetUrl', 'events', 'status', 'description']);
  });

  it('sends PUT /webhooks/{id} with only the given fields and answers the subscription as it now stands', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.paused)]);

    const subscription = await subscriptions.update(12, { status: 'paused', description: undefined });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['PUT', '/webhooks/12']);
    expect(bodyOf(http.requests[0])).toEqual({ status: 'paused' });
    expect(subscription).toEqual(WebhookAnswers.paused);
  });

  it('sends every field it reads', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.subscription)]);

    await subscriptions.update(12, {
      targetUrl: 'https://hooks.example.com/siren',
      events: ['payout.paid', 'payout.failed'],
      status: 'active',
      description: 'Payouts to the ledger',
    });

    expect(bodyOf(http.requests[0])).toEqual({
      targetUrl: 'https://hooks.example.com/siren',
      events: ['payout.paid', 'payout.failed'],
      status: 'active',
      description: 'Payouts to the ledger',
    });
  });

  it('refuses a field the route does not read, before sending, and names it', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.subscription)]);

    await expect(subscriptions.update(12, { signingSecret: 'x' } as never)).rejects.toThrow(
      'webhooks.subscriptions.update() cannot send "signingSecret". Siren\'s update route reads only targetUrl, events, status and description.',
    );
    expect(http.requests).toHaveLength(0);
  });

  it('refuses an id that is not a positive whole number before sending', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.subscription)]);

    for (const id of BAD_IDS) {
      await expect(subscriptions.update(id, { status: 'paused' })).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it('throws NotFoundError for an id the organization does not have', async () => {
    const { subscriptions } = over([reply(404, WebhookAnswers.notFound)]);

    await expect(subscriptions.update(99, { status: 'paused' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is sent once', async () => {
    await expectSentOnce(
      (transport: HttpTransport) => new WebhookSubscriptionsResource(transport).update(12, { status: 'paused' }),
      reply(200, WebhookAnswers.paused),
    );
  });
});

describe('apps-sdk-gaps: webhooks.subscriptions.test', () => {
  it('sends POST /webhooks/{id}/test with no body and answers what the endpoint did', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.testDelivered)]);

    const result: WebhookTestResult = await subscriptions.test(12);

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/webhooks/12/test']);
    expect(http.requests[0]!.body).toBeUndefined();
    expect(result).toEqual(WebhookAnswers.testDelivered);
  });

  it('answers a failed delivery as Cloud does, with status 200 and delivered false', async () => {
    const { subscriptions } = over([reply(200, WebhookAnswers.testFailed)]);

    const result = await subscriptions.test(12);

    expect(result.delivered).toBe(false);
    expect(result.httpStatus).toBe(500);
  });

  it('throws ConflictError for a paused subscription', async () => {
    const { subscriptions } = over([reply(409, WebhookAnswers.testPaused)]);

    await expect(subscriptions.test(12)).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws RateLimitError past the hourly limit, without retrying', async () => {
    const { http, subscriptions } = over([
      reply(429, { error: { message: 'Too many requests.', context: [] } }, { 'Retry-After': '0' }),
      reply(200, WebhookAnswers.testDelivered),
    ]);

    await expect(subscriptions.test(12)).rejects.toBeInstanceOf(RateLimitError);
    expect(http.requests).toHaveLength(1);
  });

  it('refuses an id that is not a positive whole number before sending', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.testDelivered)]);

    for (const id of BAD_IDS) {
      await expect(subscriptions.test(id)).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it('throws UnexpectedResponseError when a 2xx body is not a JSON object', async () => {
    const { subscriptions } = over([reply(200, 'ok')]);

    await expect(subscriptions.test(12)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('is sent once, since each test makes Siren send a request', async () => {
    await expectSentOnce(
      (transport: HttpTransport) => new WebhookSubscriptionsResource(transport).test(12),
      reply(200, WebhookAnswers.testDelivered),
    );
  });
});

describe('apps-sdk-gaps: webhooks.subscriptions.deliveries', () => {
  it('reads GET /webhooks/{id}/deliveries and answers the bare list, newest first', async () => {
    const { http, subscriptions } = over([reply(200, WebhookAnswers.deliveries)]);

    const deliveries: WebhookDelivery[] = await subscriptions.deliveries(12);

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/webhooks/12/deliveries']);
    expect(queryOf(http.requests[0])).toEqual({});
    expect(deliveries).toEqual(WebhookAnswers.deliveries);
    expect(deliveries.map((delivery) => delivery.status)).toEqual(['delivered', 'failed']);
  });

  it('answers an empty list for a subscription with no deliveries', async () => {
    const { subscriptions } = over([reply(200, [])]);

    await expect(subscriptions.deliveries(12)).resolves.toEqual([]);
  });

  it('throws NotFoundError for an id the organization does not have', async () => {
    const { subscriptions } = over([reply(404, WebhookAnswers.notFound)]);

    await expect(subscriptions.deliveries(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws UnexpectedResponseError when a 2xx body is not a list of objects', async () => {
    for (const body of [{ items: [] }, [1, 2], ['x']]) {
      const { subscriptions } = over([reply(200, body)]);
      await expect(subscriptions.deliveries(12)).rejects.toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it('refuses an id that is not a positive whole number before sending', async () => {
    const { http, subscriptions } = over([reply(200, [])]);

    for (const id of BAD_IDS) {
      await expect(subscriptions.deliveries(id)).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it('retries, as a read', async () => {
    await expectRetried(
      (transport: HttpTransport) => new WebhookSubscriptionsResource(transport).deliveries(12),
      reply(200, WebhookAnswers.deliveries),
    );
  });
});
