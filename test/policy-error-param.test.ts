import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionError, PolicyError } from '../src/index';
import { jsonResponse, makeClient } from './helpers';

/*
 * Slice 1 P3 unit tests for the `error.context.param` guard in PolicyError.
 * The acceptance tests send a non-string param only beside a known code,
 * where the code decides alone. These cover a reply with no code, where
 * the param's type is what decides.
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
    for (const param of [7, true, ['status'], { name: 'status' }]) {
      const error = await thrownBy(403, { error: { message: 'Forbidden.', context: { param } } });
      expect(error, JSON.stringify(param)).toBeInstanceOf(PermissionError);
      expect(error, JSON.stringify(param)).not.toBeInstanceOf(PolicyError);
      expect(PolicyError.matches('Forbidden.', undefined, { param })).toBe(false);
    }
  });

  it('counts an empty string param as named, as the PHP SDK does', () => {
    expect(PolicyError.matches('Forbidden.', undefined, { param: '' })).toBe(true);
    expect(new PolicyError('Refused.', { data: { param: '' } }).param).toBe('');
  });
});
