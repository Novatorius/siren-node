import { describe, expect, it, vi } from 'vitest';
import { SirenError } from '../src/index';
import type { ApiResponse, SirenRequest } from '../src/http';
import { retrieveRecord } from '../src/resources/records';

/*
 * Unit tests for retrieveRecord, the helper behind conversions.retrieve and
 * transactions.retrieve. The acceptance suite in records-retrieve.test.ts
 * covers the contract through the real client. These cover the choices the
 * helper makes beyond it, at the transport boundary it hands requests to.
 */

function fakeTransport(body = '{"id":1}') {
  const sent: SirenRequest[] = [];
  const request = vi.fn(async (req: SirenRequest): Promise<ApiResponse> => {
    sent.push(req);
    return {
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => body,
    };
  });

  return { http: { request }, sent };
}

describe('retrieveRecord', () => {
  it('refuses an id past the safe integer range before sending, and accepts both ends of it', async () => {
    const { http, sent } = fakeTransport();
    const unsafe = Number.MAX_SAFE_INTEGER + 1;

    const error = await retrieveRecord(http, '/conversions', unsafe).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toContain(String(unsafe));
    expect(sent).toHaveLength(0);

    await retrieveRecord(http, '/conversions', 1);
    await retrieveRecord(http, '/conversions', Number.MAX_SAFE_INTEGER);

    expect(sent.map((req) => req.path)).toEqual(['/conversions/1', `/conversions/${Number.MAX_SAFE_INTEGER}`]);
  });

  it('quotes a string id in the message, so "7" reads apart from 7', async () => {
    const { http } = fakeTransport();

    const error = await retrieveRecord(http, '/transactions', '7').catch((caught: unknown) => caught);

    expect((error as SirenError).message).toContain('"7"');
  });

  it('leaves out an empty fields list, so Siren answers its default fields', async () => {
    const { http, sent } = fakeTransport();

    await retrieveRecord(http, '/transactions', 3, { fields: [] });

    expect(sent[0]!.query?.fields).toBeUndefined();
  });

  it('hands the transport a retriable GET with no body', async () => {
    const { http, sent } = fakeTransport();

    await retrieveRecord(http, '/transactions', 3);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('GET');
    expect(sent[0]!.retriable).toBe(true);
    expect(sent[0]!.body).toBeUndefined();
  });
});
