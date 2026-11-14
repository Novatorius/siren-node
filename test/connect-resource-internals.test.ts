import { describe, expect, it } from 'vitest';
import { UnexpectedResponseError } from '../src/index';
import { reply } from './http-fakes';
import { ConnectAnswers, connectOver } from './connect-fakes';

/*
 * Unit tests for the ConnectResource internals the P3 acceptance tests do
 * not pin: the standard base64 check on the customer email key, for a key
 * written with `+` and `/`, a base64url key that needs no padding, a key
 * without its padding, and a key with padding inside it, each long enough to
 * pass the 16-byte floor.
 */

async function keyFrom(secret: string) {
  const { connect } = connectOver([reply(200, { ...ConnectAnswers.customerEmailKey, secret })]);
  return connect.customerEmailKey();
}

describe('ConnectResource internals: the customer email key check', () => {
  it('accepts a key written with + and /, the standard base64 alphabet', async () => {
    const secret = '++++++++////AQIDBAUGBwgJ';
    expect(Buffer.from(secret, 'base64')).toHaveLength(18);

    await expect(keyFrom(secret)).resolves.toEqual({ ...ConnectAnswers.customerEmailKey, secret });
  });

  it('refuses a base64url key that needs no padding, since standard base64 never holds - or _', async () => {
    const secret = '--------____AQIDBAUGBwgJ';
    expect(Buffer.from(secret, 'base64')).toHaveLength(18);

    await expect(keyFrom(secret)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('refuses a key written without its padding, as base64_encode never writes one', async () => {
    const secret = 'QUFBQUFBQUFBQUFBQUFBQUE';
    expect(Buffer.from(secret, 'base64')).toHaveLength(17);

    await expect(keyFrom(secret)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('refuses a key with padding inside it', async () => {
    const secret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==QUFB';
    expect(Buffer.from(secret, 'base64').length).toBeGreaterThanOrEqual(16);

    await expect(keyFrom(secret)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
