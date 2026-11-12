import { describe, expect, it } from 'vitest';
import { PropertyQualifier, SirenError } from '../src/index';

/*
 * Slice 3 acceptance tests for packet P2: PropertyQualifier, the plain-name
 * rule and the `@property:N` namespace Siren Cloud files a connected site's
 * names under. The cases follow the Siren PHP SDK's PropertyQualifier
 * (src/PropertyQualifier.php at 59383e6) and Cloud's NAME_PATTERN check.
 *
 * Unit shape: PropertyQualifier is pure.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P2 implementer turns each into `it` and deletes this
 * paragraph.
 */

describe('P2: PropertyQualifier constants', () => {
  it('names the separator and the name rule', () => {
    expect(PropertyQualifier.SEPARATOR).toBe('@property:');
    expect(PropertyQualifier.NAME_PATTERN.source).toBe('^[A-Za-z0-9_-]+$');
    expect(PropertyQualifier.NAME_PATTERN.flags).toBe('');
  });
});

describe('P2: PropertyQualifier.unqualify', () => {
  it.skip.each([
    ['coupon@property:5', 'coupon'],
    ['wordpress_user@property:12', 'wordpress_user'],
    ['credit_coupon_PTS@property:7', 'credit_coupon_PTS'],
    ['coupon', 'coupon'],
    ['coupon@property:', 'coupon@property:'],
    ['coupon@property:5x', 'coupon@property:5x'],
    ['coupon@property:5@property:6', 'coupon@property:5'],
    ['', ''],
  ])('unqualify(%j) is %j', (name, plain) => {
    expect(PropertyQualifier.unqualify(name)).toBe(plain);
  });
});

describe('P2: PropertyQualifier.propertyOf', () => {
  it.skip.each([
    ['coupon@property:5', 5],
    ['wordpress_user@property:12', 12],
    ['coupon@property:0', 0],
    ['coupon', null],
    ['coupon@property:', null],
    ['coupon@property:5x', null],
    ['coupon@property:-5', null],
    ['coupon@property:99999999999999999999', null],
  ])('propertyOf(%j) is %j', (name, property) => {
    expect(PropertyQualifier.propertyOf(name)).toBe(property);
  });
});

describe('P2: PropertyQualifier.isValidName', () => {
  it.skip.each(['coupon', 'wordpress_user', 'credit-coupon', 'A9', '_', '-'])('accepts %j', (name) => {
    expect(PropertyQualifier.isValidName(name)).toBe(true);
  });

  it.skip.each([
    ['empty', ''],
    ['a qualifier', 'coupon@property:5'],
    ['a comma', 'coupon,tracking'],
    ['a space', 'coupon '],
    ['a trailing newline', 'coupon\n'],
    ['a dot', 'coupon.x'],
    ['a non-ASCII letter', 'cupón'],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, name) => {
    expect(PropertyQualifier.isValidName(name)).toBe(false);
  });
});

describe('P2: PropertyQualifier.assertName', () => {
  it.skip('returns a valid name unchanged', () => {
    expect(PropertyQualifier.assertName('coupon', 'type')).toBe('coupon');
  });

  it.skip.each([
    ['empty', ''],
    ['a qualifier', 'coupon@property:5'],
    ['a comma', 'coupon,tracking'],
    ['a trailing newline', 'coupon\n'],
    ['a number', 5],
    ['null', null],
  ])('throws SirenError for %s, naming the field and never the name', (_label, name) => {
    let caught: unknown;
    try {
      PropertyQualifier.assertName(name, 'platform');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SirenError);
    expect((caught as SirenError).message).toBe(
      "Send platform as letters, digits, underscores and hyphens only. Siren adds the site's Property itself.",
    );
  });
});

describe('P2: PropertyQualifier.plainRecord', () => {
  it.skip('strips the qualifier and records the Property', () => {
    const record = { code: 'SAVE10', type: 'coupon@property:5', collaboratorId: 4 };

    expect(PropertyQualifier.plainRecord(record, 'type')).toEqual({
      code: 'SAVE10',
      type: 'coupon',
      collaboratorId: 4,
      propertyId: 5,
    });
  });

  it.skip('records a null Property for a name in no site namespace', () => {
    expect(PropertyQualifier.plainRecord({ code: 'ADA', type: 'tracking' }, 'type')).toEqual({
      code: 'ADA',
      type: 'tracking',
      propertyId: null,
    });
  });

  it.skip('never changes the record passed in', () => {
    const record = { code: 'SAVE10', type: 'coupon@property:5' };
    const plain = PropertyQualifier.plainRecord(record, 'type');

    expect(record).toEqual({ code: 'SAVE10', type: 'coupon@property:5' });
    expect(plain).not.toBe(record);
  });

  it.skip('returns a record whose field is not a string unchanged, as the same object', () => {
    const missing = { code: 'SAVE10' };
    const numeric = { code: 'SAVE10', type: 5 };

    expect(PropertyQualifier.plainRecord(missing, 'type')).toBe(missing);
    expect(PropertyQualifier.plainRecord(numeric, 'type')).toBe(numeric);
    expect(missing).toEqual({ code: 'SAVE10' });
  });

  it.skip('reads the field it is given', () => {
    expect(PropertyQualifier.plainRecord({ externalType: 'wc_product@property:3' }, 'externalType')).toEqual({
      externalType: 'wc_product',
      propertyId: 3,
    });
  });
});
