import { describe, expect, it, vi } from 'vitest';
import { CallbackAccessTokenSource, SirenError, StaticAccessToken } from '../src/index';

/*
 * Slice 2 acceptance tests for packets P1 (StaticAccessToken) and P2
 * (CallbackAccessTokenSource). Each source mirrors its PHP SDK class at
 * 59383e6 (src/Auth).
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`, leaves none of them skipped, and
 * changes nothing else here.
 */

describe('P1: StaticAccessToken', () => {
  it('answers the token it was given', async () => {
    expect(await new StaticAccessToken('sk_live_abc').getAccessToken()).toBe('sk_live_abc');
  });

  it('cannot refresh, so it answers null for any refused token', async () => {
    const source = new StaticAccessToken('sk_live_abc');

    expect(await source.refreshAccessToken('sk_live_abc')).toBeNull();
    expect(await source.refreshAccessToken('something-else')).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['undefined', undefined],
  ])('refuses %s with SirenError', (_name, token) => {
    expect(() => new StaticAccessToken(token as unknown as string)).toThrow(SirenError);
  });
});

describe('P2: CallbackAccessTokenSource', () => {
  it.skip('answers what the get function returns, sync or async, and calls it each time', async () => {
    let n = 0;
    const get = vi.fn(() => `tok-${++n}`);
    const source = new CallbackAccessTokenSource(get);

    expect(await source.getAccessToken()).toBe('tok-1');
    expect(await source.getAccessToken()).toBe('tok-2');
    expect(get).toHaveBeenCalledTimes(2);
    expect(await new CallbackAccessTokenSource(async () => 'tok-async').getAccessToken()).toBe('tok-async');
  });

  it.skip('passes the refused token to the refresh function and answers its token, sync or async', async () => {
    const refresh = vi.fn(async (rejected: string) => `${rejected}-fresh`);
    const source = new CallbackAccessTokenSource(() => 'tok-1', refresh);

    expect(await source.refreshAccessToken('tok-1')).toBe('tok-1-fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('tok-1');
    expect(await new CallbackAccessTokenSource(() => 'a', () => 'b').refreshAccessToken('a')).toBe('b');
  });

  it.skip('answers null without a refresh function', async () => {
    expect(await new CallbackAccessTokenSource(() => 'tok-1').refreshAccessToken('tok-1')).toBeNull();
  });

  it.skip.each([
    ['null', null],
    ['an empty string', ''],
    ['a number', 7],
    ['undefined', undefined],
  ])('answers null when the refresh function returns %s', async (_name, value) => {
    const source = new CallbackAccessTokenSource(
      () => 'tok-1',
      () => value as unknown as string | null,
    );

    expect(await source.refreshAccessToken('tok-1')).toBeNull();
  });

  it.skip('lets an error from either function through unchanged', async () => {
    const getFailure = new Error('store offline');
    const refreshFailure = new Error('grant revoked');
    const source = new CallbackAccessTokenSource(
      () => {
        throw getFailure;
      },
      async () => {
        throw refreshFailure;
      },
    );

    await expect(source.getAccessToken()).rejects.toBe(getFailure);
    await expect(source.refreshAccessToken('tok-1')).rejects.toBe(refreshFailure);
  });
});
