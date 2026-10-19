/**
 * Shapes for Siren's public storefront routes. Siren answers them with no API
 * key, because a shopper's browser calls them. They match what the visit
 * script and checkout pixel in the Siren Cloud app send and read.
 */

/** A source that takes storefront visits. Siren Cloud has `shopify` and `stripe`. */
export type StorefrontSource = 'shopify' | 'stripe' | (string & {});

/**
 * What a storefront script needs to reach Siren. Siren Cloud returns this as
 * the `storefront` block of an inbound connection.
 */
export interface StorefrontSettings {
  /** Public URL that records a referral visit. */
  visitUrl: string;
  /** Public URL that claims an order for a visit, or null when the source takes no claims. */
  claimUrl: string | null;
  /** Where the visit token goes: a Shopify cart attribute, or Stripe's `client_reference_id`. */
  attribute: string;
  /** The query parameter the organization's referral links carry the tracking code in. */
  referralParam: string;
  /**
   * How many days to keep a visit token: the longest expiration among the
   * organization's active programs, or 400 when one never expires.
   */
  attributionWindowDays?: number;
}

/** The body of a visit request. */
export interface StorefrontVisitRequest {
  /** The collaborator's tracking code from the referral link. */
  ref: string;
  /**
   * The token an earlier visit from this browser returned. When Siren can
   * verify it, the visit adds to that opportunity.
   */
  visitToken?: string | null;
}

/** Siren's answer to a visit request. */
export interface StorefrontVisitResponse {
  /**
   * True when Siren recorded the visit, or queued it while the organization's
   * engine is paused. False when the code names no active collaborator.
   */
  recorded: boolean;
  /** True when Siren queued the visit (HTTP 202) because the engine is paused. */
  queued?: boolean;
  opportunityId: number | null;
  /** The signed token to keep and hand to checkout. Null when nothing was recorded. */
  visitToken: string | null;
  /** The order attribute to write the token to. */
  attribute: string;
  /** How many days to keep the token. Present with a token. */
  attributionWindowDays?: number;
}

/** The body of an order claim. */
export interface StorefrontClaimRequest {
  /** A token Siren issued for this organization. */
  visitToken: string;
  /** The platform's order id. */
  orderId: string;
  /** The order total the checkout reported, in major units, such as "49.99". */
  total: string;
  /** The ISO 4217 currency code. */
  currency: string;
}

/** Siren's answer to an order claim. It never says why a claim failed. */
export interface StorefrontClaimResponse {
  claimed: boolean;
  credited: boolean;
  /** True when Siren queued the claim (HTTP 202) because the engine is paused. `claimed` is then false. */
  queued?: boolean;
}

/** The pieces of a `fetch` the module uses, so tests and wrapped `fetch` functions can stand in. */
export type StorefrontFetch = (input: string, init: RequestInit) => Promise<Response>;

/** How to reach the storefront routes. */
export interface StorefrontOptions {
  /** The visit URL, from {@link StorefrontSettings.visitUrl}. */
  visitUrl: string;
  /** The claim URL, from {@link StorefrontSettings.claimUrl}. */
  claimUrl?: string | null;
  /**
   * The `fetch` to use. Defaults to the global one, looked up at call time. A
   * page whose script wraps `window.fetch` passes the original here.
   */
  fetch?: StorefrontFetch;
}
