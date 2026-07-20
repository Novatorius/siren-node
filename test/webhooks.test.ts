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

describe('webhooks.constructEvent', () => {
  const payload = {
    type: 'payout.paid',
    data: { payoutId: 31, amount: 120.5 },
    deliveryId: 'dlv_abc',
  };
  const body = JSON.stringify(payload);

  it('verifies and parses a valid delivery', () => {
    const event = bareClient().webhooks.constructEvent(body, sign(body), SECRET);

    expect(event.type).toBe('payout.paid');
    expect(event.data).toEqual({ payoutId: 31, amount: 120.5 });
    expect(event.deliveryId).toBe('dlv_abc');
  });

  it('works with raw Buffer bodies', () => {
    const bytes = Buffer.from(body, 'utf8');
    const event = bareClient().webhooks.constructEvent(bytes, sign(bytes), SECRET);
    expect(event.type).toBe('payout.paid');
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
  it('contains all 31 event types plus "*"', () => {
    // The full canonical set is pinned in test/taxonomy.test.ts.
    const values = Object.values(WebhookEventType);
    expect(values).toHaveLength(32);
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
