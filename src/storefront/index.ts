/**
 * Browser-safe storefront module, exported as `@novatorius/siren/storefront`.
 *
 * It uses `fetch` and no Node built-ins, and it takes no API key. Siren's
 * storefront routes are public: a merchant's own site calls them from the
 * shopper's browser.
 */
import {
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  MAX_ATTRIBUTION_WINDOW_DAYS,
  STOREFRONT_DEFAULT_BASE_URL,
  VISIT_TOKEN_PATTERN,
} from './constants';
import type {
  StorefrontClaimRequest,
  StorefrontClaimResponse,
  StorefrontFetch,
  StorefrontOptions,
  StorefrontSource,
  StorefrontVisitRequest,
  StorefrontVisitResponse,
} from './types';

export * from './constants';
export type * from './types';

/** The two URLs a storefront needs. */
export interface StorefrontUrls {
  visitUrl: string;
  claimUrl: string;
}

/**
 * Builds the visit and claim URLs from a source and its public storefront key.
 * `baseUrl` is the API root and defaults to Siren Cloud's.
 */
export function storefrontUrls(params: {
  source: StorefrontSource;
  key: string;
  baseUrl?: string;
}): StorefrontUrls {
  const root = (params.baseUrl ?? STOREFRONT_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const base = `${root}/storefront/${encodeURIComponent(params.source)}/${encodeURIComponent(params.key)}`;
  return { visitUrl: `${base}/visits`, claimUrl: `${base}/orders` };
}

/** Whether a value is shaped like a visit token. Only Siren can say whether it is genuine. */
export function isVisitToken(value: unknown): value is string {
  return typeof value === 'string' && VISIT_TOKEN_PATTERN.test(value);
}

/** The token spelled for Stripe, which drops a reference that holds a dot. Siren reads both spellings. */
export function stripeSafeToken(token: string): string {
  return token.replace('.', '_');
}

/** The token spelled as Siren issues it, with a dot. */
export function canonicalToken(token: string): string {
  return token.replace('_', '.');
}

/**
 * The number of days to keep a visit token, from a window Siren returned.
 * Anything that is not a number of at least one gives the default, and the
 * result never passes {@link MAX_ATTRIBUTION_WINDOW_DAYS}.
 */
export function attributionWindowDays(days: unknown, fallback = DEFAULT_ATTRIBUTION_WINDOW_DAYS): number {
  return typeof days === 'number' && Number.isFinite(days) && days >= 1
    ? Math.min(MAX_ATTRIBUTION_WINDOW_DAYS, Math.floor(days))
    : fallback;
}

/** Records referral visits and claims orders through Siren's public storefront routes. */
export class SirenStorefront {
  private readonly visitUrl: string;
  private readonly claimUrl: string | null;
  private readonly fetchImpl: StorefrontFetch | undefined;

  constructor(options: StorefrontOptions) {
    this.visitUrl = options.visitUrl;
    this.claimUrl = options.claimUrl ?? null;
    this.fetchImpl = options.fetch;
  }

  /**
   * Records a referral visit.
   *
   * Resolves to Siren's answer, or null when Siren refused the request, such
   * as in a busy minute, so the caller can try again on the next page. A
   * network failure rejects. Siren answers `recorded: false` for a code that
   * names no active collaborator.
   */
  async recordVisit(params: StorefrontVisitRequest): Promise<StorefrontVisitResponse | null> {
    return this.post<StorefrontVisitResponse>(this.visitUrl, {
      ref: params.ref,
      visitToken: params.visitToken ?? null,
    });
  }

  /**
   * Claims an order for a visit token, for a checkout that skips the cart.
   *
   * Resolves to Siren's answer, or null when Siren refused the request. A
   * network failure rejects, and so does a source that takes no claims.
   * `claimed` true with `credited` false means the order's webhook has not
   * arrived yet, so asking again a little later can settle it.
   */
  async claimOrder(params: StorefrontClaimRequest): Promise<StorefrontClaimResponse | null> {
    if (!this.claimUrl) throw new Error('This storefront takes no order claims.');
    return this.post<StorefrontClaimResponse>(this.claimUrl, {
      visitToken: params.visitToken,
      orderId: params.orderId,
      total: params.total,
      currency: params.currency,
    });
  }

  private async post<T>(url: string, body: unknown): Promise<T | null> {
    const send = this.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    const response = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
    });
    return response.ok ? ((await response.json()) as T) : null;
  }
}
