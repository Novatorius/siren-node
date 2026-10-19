import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  MAX_ATTRIBUTION_WINDOW_DAYS,
  SHOPIFY_TRACKING_ATTRIBUTE,
  STRIPE_TRACKING_ATTRIBUTE,
  SirenStorefront,
  VISIT_STORAGE_KEY,
  attributionWindowDays,
  canonicalToken,
  isVisitToken,
  storefrontUrls,
  stripeSafeToken,
  trackingAttributeFor,
} from '../src/storefront';
import { jsonResponse } from './helpers';

const TOKEN = `4021.${'a1'.repeat(16)}`;
const VISIT_URL = 'https://api.example.test/siren/v1/storefront/shopify/abc/visits';
const CLAIM_URL = 'https://api.example.test/siren/v1/storefront/shopify/abc/orders';

afterEach(() => {
  vi.unstubAllGlobals();
});

function storefront(response: Response | Error, claimUrl: string | null = CLAIM_URL) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
  return { fetchMock, client: new SirenStorefront({ visitUrl: VISIT_URL, claimUrl, fetch: fetchMock }) };
}

describe('storefrontUrls', () => {
  it('builds the visit and claim URLs under the default API root', () => {
    expect(storefrontUrls({ source: 'stripe', key: 'k'.repeat(32) })).toEqual({
      visitUrl: `https://api.sirenaffiliates.com/siren/v1/storefront/stripe/${'k'.repeat(32)}/visits`,
      claimUrl: `https://api.sirenaffiliates.com/siren/v1/storefront/stripe/${'k'.repeat(32)}/orders`,
    });
  });

  it('uses a given base URL, trimming trailing slashes, and encodes the parts', () => {
    expect(storefrontUrls({ source: 'a b', key: 'x/y', baseUrl: 'https://api.example.test/siren/v1//' })).toEqual({
      visitUrl: 'https://api.example.test/siren/v1/storefront/a%20b/x%2Fy/visits',
      claimUrl: 'https://api.example.test/siren/v1/storefront/a%20b/x%2Fy/orders',
    });
  });
});

describe('visit tokens', () => {
  it('accepts the dot and underscore spellings and nothing else', () => {
    expect(isVisitToken(TOKEN)).toBe(true);
    expect(isVisitToken(stripeSafeToken(TOKEN))).toBe(true);
    expect(isVisitToken('4021.ABC')).toBe(false);
    expect(isVisitToken(`x.${'a'.repeat(32)}`)).toBe(false);
    expect(isVisitToken(null)).toBe(false);
    expect(isVisitToken(4021)).toBe(false);
  });

  it('converts between spellings', () => {
    expect(stripeSafeToken(TOKEN)).toBe(`4021_${'a1'.repeat(16)}`);
    expect(canonicalToken(stripeSafeToken(TOKEN))).toBe(TOKEN);
  });
});

describe('attributionWindowDays', () => {
  it('floors a valid window and caps it at 400 days', () => {
    expect(attributionWindowDays(45)).toBe(45);
    expect(attributionWindowDays(45.9)).toBe(45);
    expect(attributionWindowDays(9999)).toBe(MAX_ATTRIBUTION_WINDOW_DAYS);
  });

  it('falls back for anything that is not a number of at least one', () => {
    for (const bad of [undefined, null, '30', 0, 0.5, -3, NaN, Infinity]) {
      expect(attributionWindowDays(bad)).toBe(DEFAULT_ATTRIBUTION_WINDOW_DAYS);
    }
    expect(attributionWindowDays(undefined, 12)).toBe(12);
  });
});

describe('constants', () => {
  it('match what Siren Cloud reads', () => {
    expect(VISIT_STORAGE_KEY).toBe('siren_visit');
    expect(trackingAttributeFor('shopify')).toBe(SHOPIFY_TRACKING_ATTRIBUTE);
    expect(SHOPIFY_TRACKING_ATTRIBUTE).toBe('__siren_tracking_id');
    expect(trackingAttributeFor('stripe')).toBe(STRIPE_TRACKING_ATTRIBUTE);
    expect(STRIPE_TRACKING_ATTRIBUTE).toBe('client_reference_id');
    expect(trackingAttributeFor('other')).toBeUndefined();
  });
});

describe('SirenStorefront.recordVisit', () => {
  it('POSTs ref and visitToken as JSON with credentials omitted', async () => {
    const answer = {
      recorded: true,
      opportunityId: 4021,
      visitToken: TOKEN,
      attribute: '__siren_tracking_id',
      attributionWindowDays: 60,
    };
    const { client, fetchMock } = storefront(jsonResponse(200, answer));

    await expect(client.recordVisit({ ref: 'jane', visitToken: TOKEN })).resolves.toEqual(answer);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(VISIT_URL);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ ref: 'jane', visitToken: TOKEN });
  });

  it('sends a null visitToken when the browser has none', async () => {
    const { client, fetchMock } = storefront(jsonResponse(200, { recorded: false }));
    await client.recordVisit({ ref: 'jane' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ ref: 'jane', visitToken: null });
  });

  it('returns a queued answer (202) as is', async () => {
    const answer = { recorded: true, queued: true, opportunityId: 9, visitToken: TOKEN, attribute: 'client_reference_id' };
    const { client } = storefront(jsonResponse(202, answer));
    await expect(client.recordVisit({ ref: 'jane' })).resolves.toEqual(answer);
  });

  it('resolves to null when Siren refuses the request, so the caller can retry', async () => {
    for (const status of [400, 404, 429, 500]) {
      const { client } = storefront(jsonResponse(status, { message: 'no' }));
      await expect(client.recordVisit({ ref: 'jane' })).resolves.toBeNull();
    }
  });

  it('rejects on a network failure', async () => {
    const { client } = storefront(new TypeError('Failed to fetch'));
    await expect(client.recordVisit({ ref: 'jane' })).rejects.toThrow('Failed to fetch');
  });

  it('uses the global fetch, looked up at call time, when none is given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { recorded: false }));
    const client = new SirenStorefront({ visitUrl: VISIT_URL });
    vi.stubGlobal('fetch', fetchMock);
    await client.recordVisit({ ref: 'jane' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('SirenStorefront.claimOrder', () => {
  const claim = { visitToken: TOKEN, orderId: '5551234', total: '49.99', currency: 'USD' };

  it('POSTs exactly visitToken, orderId, total and currency', async () => {
    const { client, fetchMock } = storefront(jsonResponse(200, { claimed: true, credited: false }));

    await expect(client.claimOrder({ ...claim })).resolves.toEqual({ claimed: true, credited: false });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(CLAIM_URL);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body as string)).toEqual(claim);
  });

  it('returns a queued claim (202) as is', async () => {
    const { client } = storefront(jsonResponse(202, { claimed: false, credited: false, queued: true }));
    await expect(client.claimOrder(claim)).resolves.toEqual({ claimed: false, credited: false, queued: true });
  });

  it('resolves to null when Siren refuses the request', async () => {
    const { client } = storefront(jsonResponse(429, { message: 'busy' }));
    await expect(client.claimOrder(claim)).resolves.toBeNull();
  });

  it('rejects when the source takes no claims, without calling fetch', async () => {
    const { client, fetchMock } = storefront(jsonResponse(200, {}), null);
    await expect(client.claimOrder(claim)).rejects.toThrow('takes no order claims');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
