import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SignatureVerificationError, SirenError } from '../src/errors';
import { listAppRequests, verifyAppRequest } from '../src/resources/app-requests';
import { reply } from './http-fakes';
import { transportOver } from './record-fakes';

/*
 * Unit tests for the guards src/resources/app-requests.ts adds beyond the
 * acceptance tests of packets sdk-verify, sdk-requests and sdk-answer
 * (test/apps-verify-request.test.ts, test/apps-resource.test.ts). Each guard
 * has a mutation in scripts/mutations/apps-cli.json that this file catches.
 */

interface SignedFixture {
  secret: string;
  timestamp: number;
  body: string;
  headers: Record<string, string>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/apps-exchange/signed-request.json', import.meta.url), 'utf8'),
) as SignedFixture;
const T = fixture.timestamp;

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('the call answered instead of refusing');
}

describe('apps-cli internals: verifyAppRequest', () => {
  it('refuses a parsed body with SirenError, since only the raw bytes can be checked', () => {
    const parsed = JSON.parse(fixture.body) as unknown;
    const error = refusal(() =>
      verifyAppRequest(parsed as string, fixture.headers, fixture.secret, { now: T }, 300),
    );
    expect(error).toBeInstanceOf(SirenError);
    expect(error).not.toBeInstanceOf(SignatureVerificationError);
    expect((error as Error).message).toContain('raw request body');
  });

  it('refuses a clock that is not a finite number, which would let any timestamp through', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, '1794913200']) {
      const error = refusal(() =>
        verifyAppRequest(fixture.body, fixture.headers, fixture.secret, { now: now as number }, 300),
      );
      expect(error, String(now)).toBeInstanceOf(SirenError);
      expect(error, String(now)).not.toBeInstanceOf(SignatureVerificationError);
    }
  });

  it('refuses options that are not an object', () => {
    const error = refusal(() =>
      verifyAppRequest(fixture.body, fixture.headers, fixture.secret, null as unknown as { now: number }, 300),
    );
    expect(error).toBeInstanceOf(SirenError);
    expect(error).not.toBeInstanceOf(SignatureVerificationError);
  });

  it('refuses a V2 header that names two times, even when the first one is signed', () => {
    const v1 = createHmac('sha256', fixture.secret).update(`${T}.${fixture.body}`).digest('hex');
    const headers = { ...fixture.headers, 'X-Siren-Signature-V2': `t=${T},t=${T + 999},v1=${v1}` };
    const error = refusal(() => verifyAppRequest(fixture.body, headers, fixture.secret, { now: T }, 300));
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as Error).message).toContain('cannot be read');
  });
});

describe('apps-cli internals: listAppRequests', () => {
  it('refuses filters that are not an object before sending', async () => {
    const { http, transport } = transportOver([reply(200, { requests: [] })]);
    await expect(listAppRequests(transport, null as unknown as object, ['status'])).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
