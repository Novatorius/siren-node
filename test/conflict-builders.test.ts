import { describe, expect, it } from 'vitest';
import { CodeConflictError, ConflictError, HoldConflictError } from '../src/index';

/*
 * Unit tests for the status that CodeConflictError.fromConflict and
 * HoldConflictError.fromConflict copy from the conflict they wrap. Both
 * classes default to 409, so these build the conflict with another status
 * to show the builders copy it rather than fall back to the default.
 */

describe('fromConflict keeps the conflict status', () => {
  const conflict = new ConflictError('Refused.', { code: 'hold_no_credit', statusCode: 423 });

  it('copies the status into a CodeConflictError', () => {
    expect(CodeConflictError.fromConflict(conflict, 'SUMMER', 'coupon').statusCode).toBe(423);
  });

  it('copies the status into a HoldConflictError', () => {
    expect(HoldConflictError.fromConflict(conflict).statusCode).toBe(423);
  });
});
