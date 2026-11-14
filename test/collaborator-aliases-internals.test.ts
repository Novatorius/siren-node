import { describe, expect, it } from 'vitest';
import { SirenError, UnexpectedResponseError } from '../src/index';
import { aliasCode, plainAlias } from '../src/resources/collaborator-aliases';

/*
 * Unit tests for the two helpers CollaboratorAliasesResource shares across
 * its methods: the code check and the code row reader. The P4 acceptance
 * tests reach them through the resource, so these pin what each one decides
 * on its own, the method name in the code check's message and the row
 * passed through untouched included. No test here sends a request.
 */

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('aliasCode', () => {
  it.each([
    ['SAVE10', 'SAVE10'],
    [' SAVE10 ', 'SAVE10'],
    ['\tvip\n', 'vip'],
    ['TWO WORDS', 'TWO WORDS'],
  ])('answers %j trimmed as %j', (code, trimmed) => {
    expect(aliasCode(code, 'create')).toBe(trimmed);
  });

  it.each([
    ['an empty code', ''],
    ['a code of spaces', '   '],
    ['a code with a comma', 'SAVE10,VIP'],
    ['a code with a comma inside spaces', ' A,B '],
    ['a number', 10],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s with SirenError naming the method', (_label, code) => {
    const error = caught(() => aliasCode(code, 'findByCode'));

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toMatch(/^findByCode /);
  });
});

describe('plainAlias', () => {
  it('answers a qualified row with the plain type and its Property, leaving the row as it was', () => {
    const row = { code: 'SAVE10', type: 'coupon@property:5', collaboratorId: 4 };

    expect(plainAlias(row)).toEqual({ code: 'SAVE10', type: 'coupon', collaboratorId: 4, propertyId: 5 });
    expect(row).toEqual({ code: 'SAVE10', type: 'coupon@property:5', collaboratorId: 4 });
  });

  it('answers a plain row with a null propertyId', () => {
    expect(plainAlias({ code: 'FLO', type: 'tracking', collaboratorId: 4 })).toEqual({
      code: 'FLO',
      type: 'tracking',
      collaboratorId: 4,
      propertyId: null,
    });
  });

  it.each([
    ['no type', { code: 'SAVE10', collaboratorId: 4 }],
    ['a numeric type', { code: 'SAVE10', type: 5, collaboratorId: 4 }],
    ['a null type', { code: 'SAVE10', type: null, collaboratorId: 4 }],
  ])('refuses a row with %s with UnexpectedResponseError carrying the row', (_label, row) => {
    const error = caught(() => plainAlias(row));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).data).toEqual(row);
  });
});
