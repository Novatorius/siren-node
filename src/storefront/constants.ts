import type { StorefrontSource } from './types';

/** The API root Siren Cloud serves the storefront routes under. */
export const STOREFRONT_DEFAULT_BASE_URL = 'https://api.sirenaffiliates.com/siren/v1';

/** The referral link parameter when the organization has not chosen another. */
export const DEFAULT_REFERRAL_PARAM = 'ref';

/** The first-party cookie and localStorage key that hold the visit token. */
export const VISIT_STORAGE_KEY = 'siren_visit';

/** The cart attribute a Shopify storefront writes the visit token to. Shopify hides names that start with `__`. */
export const SHOPIFY_TRACKING_ATTRIBUTE = '__siren_tracking_id';

/** The Checkout Session field a Stripe storefront writes the visit token to. */
export const STRIPE_TRACKING_ATTRIBUTE = 'client_reference_id';

/** How many days to keep a visit token when Siren does not say. */
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 30;

/** The longest window to keep a token for: the longest a browser keeps a cookie. */
export const MAX_ATTRIBUTION_WINDOW_DAYS = 400;

/**
 * A visit token: the opportunity id, a dot, and 32 hex characters of
 * signature. Stripe drops a reference with a dot, so a Stripe storefront
 * passes it on with an underscore. Siren reads both spellings.
 */
export const VISIT_TOKEN_PATTERN = /^[0-9]+[._][a-f0-9]{32}$/;

/** The order attribute a source takes the visit token in, or undefined for a source this module does not know. */
export function trackingAttributeFor(source: StorefrontSource): string | undefined {
  if (source === 'shopify') return SHOPIFY_TRACKING_ATTRIBUTE;
  if (source === 'stripe') return STRIPE_TRACKING_ATTRIBUTE;
  return undefined;
}
