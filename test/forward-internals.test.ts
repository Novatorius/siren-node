import { describe, expect, it } from 'vitest';
import { Siren, SirenError } from '../src/index';
import { HttpTransport } from '../src/http';
import type { HttpMethod } from '../src/http';
import { FakeHttpClient, reply, spySource } from './http-fakes';

/*
 * Unit tests for the two internals slice 5 packet P6 adds: the transport's
 * merge of a request's own headers beneath the SDK's, and the envelope
 * object check in events.forward. The acceptance suite in
 * forwarded-events.test.ts drives both through the client with one extra
 * header and well-formed envelopes. These cover the cases it leaves out, at
 * the HttpClient seam, where the headers leave the SDK.
 */

const BASE = 'https://api.sirenaffiliates.com/siren/v1';
const EVENT_ID = '5f0c2b1e-9d8a-4c3f-8e7d-6c5b4a392817';

function transportOver() {
  const http = new FakeHttpClient([reply(200, {})]);
  const transport = new HttpTransport({ tokens: spySource(['tok-1']), client: http, baseUrl: BASE, timeout: 30_000, maxRetries: 0 });
  return { http, transport };
}

const SDK_VALUES = {
  authorization: 'Bearer tok-1',
  accept: 'application/json',
  'user-agent': 'siren-sdk-typescript/0.3.0',
  'content-type': 'application/json',
};

/** Every header name in lower case, with each value it was sent under. */
function byLowerName(headers: Readonly<Record<string, string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) (out[name.toLowerCase()] ??= []).push(value);
  return out;
}

describe('HttpTransport request headers', () => {
  it.each([
    ['in their own case', { Authorization: 'Bearer stolen', Accept: 'text/html', 'User-Agent': 'other/1', 'Content-Type': 'text/plain' }],
    ['in lower case', { authorization: 'Bearer stolen', accept: 'text/html', 'user-agent': 'other/1', 'content-type': 'text/plain' }],
    ['in upper case', { AUTHORIZATION: 'Bearer stolen', ACCEPT: 'text/html', 'USER-AGENT': 'other/1', 'CONTENT-TYPE': 'text/plain' }],
  ])('never lets a request header %s replace or sit beside the SDK headers', async (_name, extra) => {
    const { http, transport } = transportOver();

    await transport.request({ method: 'POST', path: '/event/product-deleted', body: {}, retriable: false, headers: { ...extra, 'X-Siren-Final-Attempt': '1' } });

    const sent = byLowerName(http.requests[0]!.headers);
    expect(sent).toEqual({
      authorization: [SDK_VALUES.authorization],
      accept: [SDK_VALUES.accept],
      'user-agent': [SDK_VALUES['user-agent']],
      'content-type': [SDK_VALUES['content-type']],
      'x-siren-final-attempt': ['1'],
    });
  });

  it('drops a Content-Type header from a request without a body', async () => {
    const { http, transport } = transportOver();

    await transport.request({ method: 'GET' as HttpMethod, path: '/connect/plan', retriable: true, headers: { 'content-type': 'text/plain', 'X-Trace': 'abc' } });

    expect(byLowerName(http.requests[0]!.headers)).toEqual({
      authorization: [SDK_VALUES.authorization],
      accept: [SDK_VALUES.accept],
      'user-agent': [SDK_VALUES['user-agent']],
      'x-trace': ['abc'],
    });
  });

  it('sends only the SDK headers for a request without headers', async () => {
    const { http, transport } = transportOver();

    await transport.request({ method: 'POST', path: '/event/custom', body: {}, retriable: false });

    expect(byLowerName(http.requests[0]!.headers)).toEqual({
      authorization: [SDK_VALUES.authorization],
      accept: [SDK_VALUES.accept],
      'user-agent': [SDK_VALUES['user-agent']],
      'content-type': [SDK_VALUES['content-type']],
    });
  });
});

describe('events.forward envelope object check', () => {
  function siren() {
    const http = new FakeHttpClient([reply(200, { status: 'accepted' })]);
    return { http, client: new Siren({ apiKey: 'sk_live_test', httpClient: http }) };
  }

  it.each([
    ['null', null],
    ['a list', []],
    ['text', 'envelope'],
    ['a number', 1],
  ])('refuses an envelope that is %s with SirenError and sends nothing', async (_name, envelope) => {
    const { http, client } = siren();

    await expect(client.events.forward('product-deleted', envelope as never)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['text before it', `x${EVENT_ID}`],
    ['text after it', `${EVENT_ID}x`],
  ])('refuses an eventId with %s, so the UUID check holds at both ends', async (_name, eventId) => {
    const { http, client } = siren();

    await expect(
      client.events.forward('product-deleted', { version: 1, eventId, origin: 'site', occurredAt: null, data: {} } as never),
    ).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it('sends an envelope whose data is an empty object', async () => {
    const { http, client } = siren();

    await client.events.forward('coupons-imported', { version: 1, eventId: EVENT_ID, origin: 'site', occurredAt: null, data: {} } as never);

    expect(http.requests).toHaveLength(1);
  });
});
