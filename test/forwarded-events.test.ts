import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ConflictError,
  ConnectionError,
  EventSlug,
  ForwardedEventSlug,
  FORWARDED_EVENT_VERSION,
  HttpClientError,
  NotFoundError,
  RateLimitError,
  Siren,
  SirenError,
  ValidationError,
} from '../src/index';
import type { ForwardedEventEnvelope } from '../src/index';
import type { HttpRequest, HttpResponse } from '../src/http';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * Slice 5 acceptance tests for packet P6: events.forward, the versioned
 * envelope a connected site sends to `POST /event/{slug}`.
 *
 * Integration shape (KB 568): the real Siren client and transport, with a
 * FakeHttpClient at the HttpClient seam. The answers are the ones Siren's
 * lib/Events/Core/Factories/Forwarded/ForwardedEventFactory.php lists at
 * b6f7140d0, and the envelope rules are lib/EventForwarding/Core/Services/
 * EventWireFormat.php. The header is ForwardedEventSender::FINAL_ATTEMPT_HEADER
 * in lib/Connect/Service/Services/ForwardedEventSender.php.
 *
 * The vocabulary tests at the top hold now: ForwardedEventSlug and the
 * version are written in full in the architecture commit.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`. The packet that removes the last
 * `.skip` in this file deletes this paragraph too. Nothing else here changes.
 */

const BASE = 'https://api.sirenaffiliates.com/siren/v1';
const EVENT_ID = '5f0c2b1e-9d8a-4c3f-8e7d-6c5b4a392817';

/** Siren's ForwardedEventSlug enum at b6f7140d0, in its order. */
const CLOUD_SLUGS = [
  'sale-triggered',
  'transaction-completed',
  'refund-triggered',
  'partial-refund-received',
  'renewal-triggered',
  'lead-triggered',
  'blog-post-visited',
  'coupon-applied',
  'student-completed-lesson',
  'student-completed-course',
  'order-discounts-detected',
  'order-discounts-reversed',
  'customer-identified',
  'earlier-sale-customer-identified',
  'earlier-order-refunds-found',
  'earlier-sale-coupons-identified',
  'sale-line-variations-identified',
  'customer-created',
  'customer-updated',
  'customer-deleted',
  'coupon-created',
  'coupon-updated',
  'coupon-deleted',
  'coupons-imported',
  'product-created',
  'product-updated',
  'product-deleted',
  'products-imported',
];

const Answers = {
  accepted: { status: 'accepted', event: 'product-deleted', message: 'Event accepted.' },
  duplicate: { status: 'duplicate', event: 'product-deleted', message: 'Event already received.' },
  saleCreated: { status: 'created', event: 'sale-triggered', message: 'Sale recorded.' },
  // ForwardedEventIngestionService::readEnvelope, lines 91 to 95 at b6f7140d0.
  cloudOrigin: {
    error: {
      message: 'This event came from Siren Cloud, so it is not taken back in. Do not send it again.',
      context: { reason: 'cloud_origin', field: 'origin' },
    },
  },
  // ForwardedEventIngestionService, lines 250 to 254 at b6f7140d0.
  waitingForRecord: {
    error: {
      message: 'The shopper is not linked to a collaborator yet. Nothing was saved. It is safe to send it again.',
      context: { event: 'product-deleted', reason: 'waiting_for_record' },
    },
  },
  notFound: { error: { message: 'No transaction matches that reference.', context: { reason: 'reference_not_found', field: 'data.transaction' } } },
  otherProperty: {
    error: { message: 'The order was recorded for another store.', context: { reason: 'reference_belongs_to_another_property' } },
  },
  unavailable: { error: { message: 'Service unavailable', context: [] } },
};

const productDeleted: ForwardedEventEnvelope<'product-deleted'> = {
  version: 1,
  eventId: EVENT_ID,
  origin: 'site',
  occurredAt: '2026-11-12T09:30:00+00:00',
  data: { integration: 'medusa', platformId: 'prod_01', changedAt: '2026-11-12T09:30:00+00:00' },
};

const sale: ForwardedEventEnvelope<'sale-triggered'> = {
  version: 1,
  eventId: EVENT_ID,
  origin: 'site',
  occurredAt: null,
  data: {
    trackingToken: 'tt_abc',
    source: 'medusa',
    bindingId: 'order_01',
    bindingType: 'medusa_order',
    transactionDetails: [{ name: 'Hat', type: 'product', value: 2500, quantity: 1 }],
    customer: { type: 'medusa_customer', id: 'cus_01' },
  },
};

function siren(replies: Array<HttpResponse | Error>, maxRetries = 2) {
  const http = new FakeHttpClient(replies);
  return { http, client: new Siren({ apiKey: 'sk_live_test', httpClient: http, maxRetries }) };
}

function header(request: HttpRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

describe('forwarded event vocabulary', () => {
  it("names the 28 slugs of Siren's ForwardedEventSlug, and version 1", () => {
    expect(Object.values(ForwardedEventSlug)).toEqual(CLOUD_SLUGS);
    expect(FORWARDED_EVENT_VERSION).toBe(1);
  });
});

describe('P6: events.forward', () => {
  it.skip('sends one POST to /event/{slug} whose body is the envelope as given, and reads the answer as every event is read', async () => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    const result = await client.events.forward(ForwardedEventSlug.ProductDeleted, productDeleted);

    expect(result.status).toBe('accepted');
    expect(result.body).toEqual(Answers.accepted);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('POST');
    expect(http.requests[0]!.url).toBe(`${BASE}/event/product-deleted`);
    expect(JSON.parse(http.requests[0]!.body!)).toEqual(productDeleted);
    expect(header(http.requests[0]!, 'authorization')).toBe('Bearer sk_live_test');
    expect(header(http.requests[0]!, 'content-type')).toBe('application/json');
  });

  it.skip('sends a sale and reads the sale status', async () => {
    const { http, client } = siren([reply(200, Answers.saleCreated)]);

    const result = await client.events.forward('sale-triggered', sale);

    expect(result.status).toBe('created');
    expect(http.requests).toHaveLength(1);
    expect(JSON.parse(http.requests[0]!.body!)).toEqual(sale);
  });

  it.skip('sends a refund with its optional refundKind beside data', async () => {
    const { http, client } = siren([reply(200, Answers.accepted)]);
    const refund: ForwardedEventEnvelope<'refund-triggered'> = {
      ...productDeleted,
      data: { transaction: { id: 1 } },
      optional: { refundKind: 'cancelled' },
    };

    await client.events.forward('refund-triggered', refund);

    expect(http.requests).toHaveLength(1);
    expect(JSON.parse(http.requests[0]!.body!)).toEqual(refund);
  });

  it.skip.each(CLOUD_SLUGS)('sends %s to its own path', async (slug) => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    await client.events.forward(slug as ForwardedEventSlug, { ...productDeleted, data: {} } as never);

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe(`${BASE}/event/${slug}`);
  });

  it.skip("answers Cloud's duplicate as a result, not an error", async () => {
    const { client } = siren([reply(200, Answers.duplicate)]);

    await expect(client.events.forward('product-deleted', productDeleted)).resolves.toMatchObject({ status: 'duplicate' });
  });
});

describe('P6: events.forward final attempt header', () => {
  it.skip('sends X-Siren-Final-Attempt: 1 when finalAttempt is true, beside the SDK headers', async () => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    await client.events.forward('product-deleted', productDeleted, { finalAttempt: true });

    expect(http.requests).toHaveLength(1);
    const request = http.requests[0]!;
    expect(header(request, 'x-siren-final-attempt')).toBe('1');
    expect(header(request, 'authorization')).toBe('Bearer sk_live_test');
    expect(header(request, 'accept')).toBe('application/json');
    expect(header(request, 'content-type')).toBe('application/json');
    expect(header(request, 'user-agent')).toMatch(/^siren-sdk-typescript\//);
  });

  it.skip.each([
    ['no options', undefined],
    ['finalAttempt false', { finalAttempt: false }],
  ])('sends no X-Siren-Final-Attempt header with %s', async (_name, options) => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    await client.events.forward('product-deleted', productDeleted, options);

    expect(http.requests).toHaveLength(1);
    expect(header(http.requests[0]!, 'x-siren-final-attempt')).toBeUndefined();
  });

  it.skip('sends the header on the one send of a final attempt, and on no other call afterwards', async () => {
    const { http, client } = siren([reply(503, Answers.unavailable, { 'Retry-After': '0' }), reply(200, Answers.accepted), reply(200, Answers.accepted)]);

    await expect(client.events.forward('product-deleted', productDeleted, { finalAttempt: true })).rejects.toBeInstanceOf(ApiError);
    await client.events.forward('product-deleted', productDeleted);
    await client.events.ingest('product-deleted', {});

    expect(http.requests.map((request) => header(request, 'x-siren-final-attempt'))).toEqual(['1', undefined, undefined]);
  });
});

describe('P6: events.forward is sent once', () => {
  it.skip.each([
    ['a 503', reply(503, Answers.unavailable, { 'Retry-After': '0' }), ApiError],
    ['a 500 with no body', reply(500), ApiError],
    ['a 429', reply(429, Answers.unavailable, { 'Retry-After': '0' }), RateLimitError],
    ['a network error', new HttpClientError('socket hang up'), ConnectionError],
  ])('sends once on %s, with the client allowing retries, and raises it for the outbox', async (_name, first, type) => {
    const { http, client } = siren([first, reply(200, Answers.duplicate)], 3);

    await expect(client.events.forward('product-deleted', productDeleted)).rejects.toBeInstanceOf(type);
    expect(http.requests).toHaveLength(1);
  });

  it.skip("raises Cloud's 500 waiting_for_record as ApiError with the reason in data, sent once", async () => {
    const { http, client } = siren([reply(500, Answers.waitingForRecord), reply(200, Answers.accepted)], 3);

    let caught: unknown;
    try {
      await client.events.forward('product-deleted', productDeleted);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).statusCode).toBe(500);
    expect((caught as ApiError).data).toMatchObject({ reason: 'waiting_for_record' });
    expect(http.requests).toHaveLength(1);
  });

  it.skip.each([
    ['409 cloud_origin', reply(409, Answers.cloudOrigin), ConflictError],
    ['404 reference_not_found', reply(404, Answers.notFound), NotFoundError],
    ['422 reference_belongs_to_another_property', reply(422, Answers.otherProperty), ValidationError],
  ])('raises %s without sending again', async (_name, answer, type) => {
    const { http, client } = siren([answer, reply(200, Answers.accepted)]);

    await expect(client.events.forward('refund-triggered', { ...productDeleted, data: { transaction: { id: 1 } } })).rejects.toBeInstanceOf(type);
    expect(http.requests).toHaveLength(1);
  });
});

describe('P6: events.forward refusals', () => {
  const secret = 'CUSTOMER-SECRET-VALUE';
  const leaky = { ...productDeleted, data: { integration: 'medusa', platformId: secret } };

  it.skip.each([
    ['a slug Siren does not forward', 'sale', leaky],
    ['an unknown slug', 'product-deletd', leaky],
    ['an empty slug', '', leaky],
    ['a version other than 1', 'product-deleted', { ...leaky, version: 2 }],
    ['a version given as text', 'product-deleted', { ...leaky, version: '1' }],
    ['an eventId that is not a UUID', 'product-deleted', { ...leaky, eventId: 'evt_123' }],
    ['an eventId with braces', 'product-deleted', { ...leaky, eventId: `{${EVENT_ID}}` }],
    ['an origin of cloud', 'product-deleted', { ...leaky, origin: 'cloud' }],
    ['an origin of Site', 'product-deleted', { ...leaky, origin: 'Site' }],
    ['no origin', 'product-deleted', { ...leaky, origin: undefined }],
    ['no eventId', 'product-deleted', { ...leaky, eventId: undefined }],
    ['an eventId of 36 characters with its dashes out of place', 'product-deleted', { ...leaky, eventId: '0a1b2c3d4e5f-6a7b-8c9d-0e1f-2a3b4c5d' }],
    ['no occurredAt', 'product-deleted', { ...leaky, occurredAt: undefined }],
    ['an occurredAt without an offset', 'product-deleted', { ...leaky, occurredAt: '2026-11-12T09:30:00' }],
    ['an occurredAt with a space for the T', 'product-deleted', { ...leaky, occurredAt: '2026-11-12 09:30:00+00:00' }],
    ['an occurredAt that is a number', 'product-deleted', { ...leaky, occurredAt: 1_762_000_000 }],
    ['data that is a list', 'product-deleted', { ...leaky, data: [secret] }],
    ['data that is null', 'product-deleted', { ...leaky, data: null }],
    ['data that is text', 'product-deleted', { ...leaky, data: secret }],
  ])('refuses %s with SirenError, sends nothing and quotes nothing from data', async (_name, slug, envelope) => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    let caught: unknown;
    try {
      await client.events.forward(slug as never, envelope as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SirenError);
    expect((caught as Error).message).not.toContain(secret);
    expect(http.requests).toHaveLength(0);
  });

  it.skip('refuses an EventSlug that is not a forwarded slug, so a typo never becomes a custom event', async () => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    for (const slug of Object.values(EventSlug).filter((value) => !CLOUD_SLUGS.includes(value))) {
      await expect(client.events.forward(slug as never, productDeleted as never), slug).rejects.toBeInstanceOf(SirenError);
    }
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each([
    ['an upper-case UUID', { eventId: EVENT_ID.toUpperCase() }],
    ['a version 7 UUID', { eventId: '01932c07-a2b4-7c3d-8e9f-0a1b2c3d4e5f' }],
    ['an occurredAt in UTC with Z', { occurredAt: '2026-11-12T09:30:00Z' }],
    ['an occurredAt with microseconds and an offset', { occurredAt: '2026-11-12T09:30:00.123456-05:00' }],
    ['an occurredAt of null', { occurredAt: null }],
  ])('sends an envelope with %s', async (_name, change) => {
    const { http, client } = siren([reply(200, Answers.accepted)]);

    await client.events.forward('product-deleted', { ...productDeleted, ...change });

    expect(http.requests).toHaveLength(1);
  });
});
