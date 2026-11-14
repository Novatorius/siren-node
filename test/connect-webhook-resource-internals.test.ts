import { describe, expect, it, vi } from 'vitest';
import { UnexpectedResponseError } from '../src/index';
import { ConnectWebhookResource } from '../src/connect/index';
import type { ApiResponse, HttpMethod, HttpTransport, SirenRequest } from '../src/http';

/*
 * Unit tests for ConnectWebhookResource's private send helper, the one place
 * that sends a webhook route and checks the shape of its answer. The
 * acceptance suite in connect-webhook-resource.test.ts covers the routes
 * through the real transport. These cover the helper's own choices at the
 * transport boundary it hands requests to: what it passes on, which bodies
 * pass each shape check, and what the error carries.
 */

type Send = <T>(method: HttpMethod, path: string, body: unknown, retriable: boolean, shape: 'object' | 'array') => Promise<T>;

function helperOver(status: number, text: string) {
  const sent: SirenRequest[] = [];
  const request = vi.fn(async (req: SirenRequest): Promise<ApiResponse> => {
    sent.push(req);
    return { status, statusText: '', headers: { get: () => null }, text: async () => text };
  });
  const resource = new ConnectWebhookResource({ request } as unknown as HttpTransport);
  const send = (resource as unknown as { send: Send }).send.bind(resource) as Send;
  return { send, sent };
}

describe('ConnectWebhookResource send helper', () => {
  it.each([true, false])('hands the transport the method, path, body and retriable flag %s as given', async (retriable) => {
    const { send, sent } = helperOver(200, '{}');

    await send('PUT', '/connect/webhook', { targetUrl: 'https://store.example/hook', events: [] }, retriable, 'object');

    expect(sent).toEqual([
      { method: 'PUT', path: '/connect/webhook', body: { targetUrl: 'https://store.example/hook', events: [] }, retriable },
    ]);
  });

  it('accepts an empty JSON object for the object shape and an empty JSON array for the array shape', async () => {
    await expect(helperOver(200, '{}').send('GET', '/connect/webhook', undefined, true, 'object')).resolves.toEqual({});
    await expect(helperOver(200, '[]').send('GET', '/connect/webhook/deliveries', undefined, true, 'array')).resolves.toEqual([]);
  });

  it.each(['"text"', '42', 'true', 'null'])('refuses the JSON scalar %s for either shape', async (text) => {
    for (const shape of ['object', 'array'] as const) {
      await expect(helperOver(200, text).send('GET', '/connect/webhook', undefined, true, shape), shape).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
    }
  });

  it('refuses an object for the array shape', async () => {
    await expect(helperOver(200, '{"id":1}').send('GET', '/connect/webhook/deliveries', undefined, true, 'array')).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it('names the method, path and status in the error, and carries no body in its data', async () => {
    const error = await helperOver(201, '["whsec_secret_in_body"]')
      .send('PUT', '/connect/webhook', {}, false, 'object')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    const details = error as UnexpectedResponseError;
    expect(details.message).toBe('Siren: Cloud answered PUT /connect/webhook with a body that is not a JSON object.');
    expect(details.statusCode).toBe(201);
    expect(details.data).toBeUndefined();
  });
});
