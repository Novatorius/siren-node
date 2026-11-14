import { SirenError } from './errors';

/**
 * The namespace Siren Cloud keeps each connected site's names in.
 *
 * Cloud stores a type that a connected site writes with the site's Property
 * attached: a coupon code's type `coupon` becomes `coupon@property:5`, and a
 * mapping's `wordpress_user` becomes `wordpress_user@property:5`. The site
 * always sends the plain name, and Cloud takes the Property from its token,
 * never from the request.
 *
 * Cloud refuses any type, platform or token from a site that is not
 * letters, digits, underscores and hyphens ({@link PropertyQualifier.NAME_PATTERN}).
 * That keeps out the `@` of a qualifier and the comma a list filter splits
 * on. One exception: a code type may also name one integration's coupons,
 * `coupon@source:wc` ({@link PropertyQualifier.CODE_TYPE_PATTERN}), which
 * Cloud reads and frees on the alias routes. The SDK checks the same rules
 * before it sends a request, so a bad name fails with a `SirenError`
 * instead of a round trip.
 *
 * Matches the Siren PHP SDK's `PropertyQualifier` class. The PHP class
 * throws `\InvalidArgumentException`. This one throws `SirenError`, as every
 * check this SDK makes before sending does.
 *
 * ```ts
 * PropertyQualifier.unqualify('coupon@property:5'); // 'coupon'
 * PropertyQualifier.propertyOf('coupon@property:5'); // 5
 * ```
 */
export const PropertyQualifier = {
  /** What separates a name from the Property it belongs to. */
  SEPARATOR: '@property:',

  /** What a type, platform or token sent to Cloud may contain: one or more letters, digits, underscores and hyphens, and nothing else. */
  NAME_PATTERN: /^[A-Za-z0-9_-]+$/,

  /** The other form a code type may take: one integration's coupons, such as `coupon@source:wc`, as Cloud's connector rule allows. */
  CODE_TYPE_PATTERN: /^coupon@source:[a-z0-9_-]{1,32}$/,

  /**
   * The name with a trailing `@property:{digits}` taken off. A plain name,
   * or one whose suffix is not digits to the end or not a safe integer,
   * comes back unchanged, so a name is unqualified exactly when
   * {@link propertyOf} answers a number.
   */
  unqualify(name: string): string {
    if (PropertyQualifier.propertyOf(name) === null) return name;
    return name.slice(0, name.lastIndexOf(PropertyQualifier.SEPARATOR));
  },

  /**
   * The Property a qualified name belongs to, from a trailing
   * `@property:{digits}`, or `null` for a plain name. Digits that do not
   * make a safe integer also answer `null`.
   */
  propertyOf(name: string): number | null {
    const at = name.lastIndexOf(PropertyQualifier.SEPARATOR);
    if (at < 0) return null;
    const digits = name.slice(at + PropertyQualifier.SEPARATOR.length);
    if (!/^[0-9]+$/.test(digits)) return null;
    const property = Number(digits);
    return Number.isSafeInteger(property) ? property : null;
  },

  /** Whether a name may be sent to Cloud as a type, platform or token. Any value that is not a string is not. */
  isValidName(name: unknown): name is string {
    return typeof name === 'string' && PropertyQualifier.NAME_PATTERN.test(name);
  },

  /**
   * Returns the name when Cloud would accept it. Otherwise throws
   * `SirenError` with the message
   * `"Send {field} as letters, digits, underscores and hyphens only. Siren adds the site's Property itself."`,
   * which never quotes the name.
   */
  assertName(name: unknown, field: string): string {
    if (!PropertyQualifier.isValidName(name)) {
      throw new SirenError(
        `Send ${field} as letters, digits, underscores and hyphens only. Siren adds the site's Property itself.`,
      );
    }
    return name;
  },

  /** Whether a code type may be sent to Cloud: a valid name, or a match for {@link CODE_TYPE_PATTERN}. */
  isValidCodeType(type: unknown): type is string {
    if (PropertyQualifier.isValidName(type)) return true;
    return typeof type === 'string' && PropertyQualifier.CODE_TYPE_PATTERN.test(type);
  },

  /**
   * Returns the code type when Cloud would accept it. Otherwise throws
   * `SirenError` with the message
   * `"Send {field} as letters, digits, underscores and hyphens, or as coupon@source:{integration}. Siren adds the site's Property itself."`,
   * which never quotes the type.
   */
  assertCodeType(type: unknown, field: string): string {
    if (!PropertyQualifier.isValidCodeType(type)) {
      throw new SirenError(
        `Send ${field} as letters, digits, underscores and hyphens, or as coupon@source:{integration}. Siren adds the site's Property itself.`,
      );
    }
    return type;
  },

  /**
   * A copy of `record` with `record[field]` unqualified and the Property it
   * named under `propertyId`, so a caller sees the plain name it sent and
   * still knows which site's namespace the record lives in. `propertyId` is
   * `null` for a record in no site's namespace, and also for a suffix that
   * {@link unqualify} leaves on, so such a name stays qualified. A record whose `field` is
   * not a string comes back unchanged, as the same object. The record passed
   * in is never changed.
   */
  plainRecord<T extends Record<string, unknown>>(record: T, field: string): T & { propertyId?: number | null } {
    const value = record[field];
    if (typeof value !== 'string') return record;
    return { ...record, [field]: PropertyQualifier.unqualify(value), propertyId: PropertyQualifier.propertyOf(value) };
  },
} as const;
