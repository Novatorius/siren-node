import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren, SignatureVerificationError, WebhookEventType, ApiError } from '../src/index';
import { emptyResponse, jsonResponse, makeClient, TEST_API_KEY } from './helpers';

const SECRET = 'whsec_test_secret_do_not_use';

function sign(rawBody: string | Buffer, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function bareClient(): Siren {
  return new Siren({ apiKey: TEST_API_KEY });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('webhooks.verifySignature', () => {
  const body = JSON.stringify({
    type: 'conversion.approved',
    data: { conversionId: 7 },
    deliveryId: 'dlv_123',
  });

  it('accepts a valid signature over a string body', () => {
    expect(bareClient().webhooks.verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('accepts a valid signature over raw bytes', () => {
    const bytes = Buffer.from(body, 'utf8');
    expect(bareClient().webhooks.verifySignature(bytes, sign(bytes), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = body.replace('"conversionId":7', '"conversionId":9999');
    expect(bareClient().webhooks.verifySignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(
      bareClient().webhooks.verifySignature(body, sign(body, 'wrong-secret'), SECRET),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(bareClient().webhooks.verifySignature(body, null, SECRET)).toBe(false);
    expect(bareClient().webhooks.verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const bare = sign(body).slice('sha256='.length);
    expect(bareClient().webhooks.verifySignature(body, bare, SECRET)).toBe(false);
    expect(bareClient().webhooks.verifySignature(body, `md5=${bare}`, SECRET)).toBe(false);
  });

  it('rejects malformed hex digests without throwing', () => {
    expect(bareClient().webhooks.verifySignature(body, 'sha256=nothex', SECRET)).toBe(false);
  });
});

// Siren sends the event payload itself as the body, and puts the event type
// and delivery id in the X-Siren-Event and X-Siren-Delivery headers
// (WebhookDeliveryService::deliver() and docs/api/webhooks-delivery.md in the
// Siren repo). These tests used to sign a `{ type, data, deliveryId }` body,
// which Siren never sends, so a real delivery parsed to an empty type and
// empty data. They now use the wire format.
describe('webhooks.constructEvent', () => {
  const payload = { payoutId: 31, amount: 120.5, type: 'stripe' };
  const body = JSON.stringify(payload);
  const headers = {
    'x-siren-event': 'payout.paid',
    'x-siren-delivery': 'evt_8a3f1b2c4d5e6f7890abcdef12345678',
  };

  it('verifies a delivery, returns the body as data, and reads type and id from the headers', () => {
    const event = bareClient().webhooks.constructEvent(body, sign(body), SECRET, headers);

    expect(event.type).toBe('payout.paid');
    expect(event.data).toEqual(payload);
    expect(event.deliveryId).toBe('evt_8a3f1b2c4d5e6f7890abcdef12345678');
  });

  it('works with raw Buffer bodies and a Fetch Headers object', () => {
    const bytes = Buffer.from(body, 'utf8');
    const event = bareClient().webhooks.constructEvent(
      bytes,
      sign(bytes),
      SECRET,
      new Headers({ 'X-Siren-Event': 'payout.paid', 'X-Siren-Delivery': 'evt_1' }),
    );
    expect(event.type).toBe('payout.paid');
    expect(event.deliveryId).toBe('evt_1');
  });

  it('reads header names in any case and the first value of a repeated header', () => {
    const event = bareClient().webhooks.constructEvent(body, sign(body), SECRET, {
      'X-Siren-Event': ['payout.paid', 'ignored'],
      'X-SIREN-DELIVERY': 'evt_2',
    });
    expect(event.type).toBe('payout.paid');
    expect(event.deliveryId).toBe('evt_2');
  });

  it('never takes a payload field named type for the event type', () => {
    const event = bareClient().webhooks.constructEvent(body, sign(body), SECRET);
    expect(event.type).toBe('');
    expect(event.deliveryId).toBeUndefined();
    expect(event.data).toEqual(payload);
  });

  it('unwraps the envelope a Property-bound subscription receives', () => {
    const envelope = JSON.stringify({
      version: 1,
      id: 'evt_3',
      type: 'conversion.approved',
      kind: 'engine',
      propertyId: 4,
      data: { conversionIds: [301] },
      records: {},
    });
    const event = bareClient().webhooks.constructEvent(envelope, sign(envelope), SECRET);
    expect(event.type).toBe('conversion.approved');
    expect(event.deliveryId).toBe('evt_3');
    expect(event.data).toEqual({ conversionIds: [301] });
  });

  it('throws SignatureVerificationError for a tampered body', () => {
    const tampered = body.replace('120.5', '99999');
    expect(() => bareClient().webhooks.constructEvent(tampered, sign(body), SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it('throws SignatureVerificationError when the header is missing', () => {
    expect(() => bareClient().webhooks.constructEvent(body, undefined, SECRET)).toThrow(
      SignatureVerificationError,
    );
    expect(() => bareClient().webhooks.constructEvent(body, '', SECRET)).toThrow(
      /Missing X-Siren-Signature/,
    );
  });
});

describe('WebhookEventType', () => {
  // The 34 events Siren's WebhookCatalog lists and GET /webhooks/events serves.
  it('contains all 34 event types plus "*"', () => {
    const values = Object.values(WebhookEventType);
    expect(values).toHaveLength(35);
    expect(values).toContain('program.created');
    expect(values).toContain('collaborator.updated');
    expect(values).toContain('collaborator.deactivated');
    expect(values).toContain('credit.issued');
    expect(values).toContain('currency.deleted');
    expect(values).toContain('*');
    expect(values).toContain('conversion.approved');
    expect(values).toContain('transaction.created');
    expect(WebhookEventType.All).toBe('*');
    expect(WebhookEventType.PayoutPaid).toBe('payout.paid');
  });
});

describe('webhooks.subscriptions', () => {
  it('creates a subscription and surfaces the one-time signingSecret', async () => {
    const ctx = makeClient([
      jsonResponse(201, {
        id: 5,
        targetUrl: 'https://example.com/webhooks/siren',
        events: ['conversion.approved'],
        status: 'active',
        signingSecret: 'whsec_only_returned_once',
      }),
    ]);

    const sub = await ctx.client.webhooks.subscriptions.create({
      targetUrl: 'https://example.com/webhooks/siren',
      events: [WebhookEventType.ConversionApproved],
    });

    const call = ctx.lastCall();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/webhooks');
    expect(call.body).toEqual({
      targetUrl: 'https://example.com/webhooks/siren',
      events: ['conversion.approved'],
    });
    expect(sub.signingSecret).toBe('whsec_only_returned_once');
  });

  it('never auto-retries subscription creation', async () => {
    const ctx = makeClient([jsonResponse(500, { error: 'boom' })], {
      maxRetries: 3,
    });

    await expect(
      ctx.client.webhooks.subscriptions.create({
        targetUrl: 'https://example.com/hook',
        events: ['*'],
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lists subscriptions as a bare array', async () => {
    const ctx = makeClient([
      jsonResponse(200, [{ id: 1, targetUrl: 'https://a.example', events: ['*'] }]),
    ]);
    const subs = await ctx.client.webhooks.subscriptions.list();

    expect(ctx.lastCall().method).toBe('GET');
    expect(subs).toEqual([{ id: 1, targetUrl: 'https://a.example', events: ['*'] }]);
  });

  it('deletes a subscription by id', async () => {
    const ctx = makeClient([emptyResponse(200)]);
    await ctx.client.webhooks.subscriptions.delete(5);

    const call = ctx.lastCall();
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe('https://api.sirenaffiliates.com/siren/v1/webhooks/5');
  });
});
