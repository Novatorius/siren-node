import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionError, PolicyError } from '../src/index';
import { jsonResponse, makeClient } from './helpers';

/*
 * Unit tests for the `error.context.param` guard in PolicyError. They cover
 * a reply with no code, where the param's type decides the class, and the
 * constructor, which keeps `param` only when it is a string.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

async function thrownBy(status: number, body: unknown): Promise<unknown> {
  const ctx = makeClient([jsonResponse(status, body)], { maxRetries: 0 });
  return ctx.client.conversions.list().catch((error: unknown) => error);
}

describe('PolicyError param guard with no code', () => {
  it('keeps a 403 whose context param is not a string a plain PermissionError', async () => {
    for (const param of [7, true, null, ['status'], { name: 'status' }]) {
      const error = await thrownBy(403, { error: { message: 'Forbidden.', context: { param } } });
      expect(error, JSON.stringify(param)).toBeInstanceOf(PermissionError);
      expect(error, JSON.stringify(param)).not.toBeInstanceOf(PolicyError);
      expect(PolicyError.matches('Forbidden.', undefined, { param })).toBe(false);
      expect(new PolicyError('Refused.', { data: { param } }).param, JSON.stringify(param)).toBeUndefined();
    }
  });

  it('counts an empty string param as named, as the PHP SDK does', () => {
    expect(PolicyError.matches('Forbidden.', undefined, { param: '' })).toBe(true);
    expect(new PolicyError('Refused.', { data: { param: '' } }).param).toBe('');
  });
});
