import { describe, expect, it } from 'vitest';
import { MissingScopeError } from '../src/index';

/*
 * Unit tests for how MissingScopeError trims the colons that end a scope it
 * reads from Siren's wording. The trim runs in linear time, so a reply with
 * a long run of colons inside the name cannot stall the process.
 */

describe('MissingScopeError scope read from the wording', () => {
  it('drops every colon that ends the name and keeps the colons inside it', () => {
    expect(new MissingScopeError('This key is not authorized for conversions:read::').scope).toBe(
      'conversions:read',
    );
  });

  it('leaves the scope undefined when the name is only colons', () => {
    expect(new MissingScopeError('This key is not authorized for :::').scope).toBeUndefined();
  });

  it('reads the scope from the wording when the reply carries the missing_scope code and no context scope', () => {
    const error = new MissingScopeError('This key is not authorized for ledger:conversions:read.', {
      code: 'missing_scope',
    });
    expect(error.scope).toBe('ledger:conversions:read');
  });

  it('reads a name holding a long run of colons in well under a second', () => {
    const name = `a${':'.repeat(200_000)}b`;
    const started = performance.now();
    const error = new MissingScopeError(`This key is not authorized for ${name}.`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(error.scope).toBe(name);
  });
});
