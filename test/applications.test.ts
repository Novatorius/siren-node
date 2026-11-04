import { describe, expect, it, vi } from 'vitest';
import {
  applicationFormUrl,
  getApplicationForm,
  submitApplication,
  verifyApplication,
} from '../src/storefront';
import { jsonResponse } from './helpers';

const BASE = 'https://api.example.test/siren/v1';

const FORM = {
  orgName: 'Acme Outdoors',
  orgSlug: 'acme',
  formName: 'Partners',
  formSlug: 'partners',
  builtInFields: [
    { key: 'nickname', label: 'Nickname', type: 'short_text', required: true, minLength: 0, maxLength: 255 },
    { key: 'fullName', label: 'Name', type: 'short_text', required: true, minLength: 1, maxLength: 255 },
    { key: 'email', label: 'Email', type: 'email', required: true, minLength: 1, maxLength: 254 },
  ],
  fields: [
    { key: 'website', label: 'Website', type: 'url', required: true, help: '', options: [], maxLength: 2048 },
  ],
  honeypot: 'homepage',
};

function fetchReturning(response: Response | Error) {
  return vi.fn(async (_url: string, _init: RequestInit) => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
}

function sent(fetchMock: ReturnType<typeof fetchReturning>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    url,
    method: init.method,
    headers: (init.headers ?? {}) as Record<string, string>,
    credentials: init.credentials,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

const APPLICATION = {
  nickname: 'trailjen',
  fullName: 'Jen Alvarez',
  email: 'jen@example.com',
  answers: { website: 'https://trailjen.example.com' },
};

describe('applicationFormUrl', () => {
  it('builds a form URL under the default API root, encoding the slugs', () => {
    expect(applicationFormUrl({ orgSlug: 'acme', formSlug: 'partners' })).toBe(
      'https://api.sirenaffiliates.com/siren/v1/applications/forms/acme/partners',
    );
    expect(applicationFormUrl({ orgSlug: 'a b', formSlug: 'x/y', baseUrl: `${BASE}//` })).toBe(
      `${BASE}/applications/forms/a%20b/x%2Fy`,
    );
  });

  it('names the organization\'s older single form without a form slug', () => {
    expect(applicationFormUrl({ orgSlug: 'acme', baseUrl: BASE })).toBe(`${BASE}/applications/forms/acme`);
  });
});

describe('getApplicationForm', () => {
  it('reads the field definitions with no credentials', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, FORM));

    expect(await getApplicationForm({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock })).toEqual(FORM);
    expect(sent(fetchMock)).toMatchObject({ url: `${BASE}/applications/forms/acme/partners`, method: 'GET', credentials: 'omit' });
  });

  it('resolves to null for a form that is off or gone', async () => {
    const fetchMock = fetchReturning(jsonResponse(404, { error: 'This form is not accepting applications.' }));

    expect(await getApplicationForm({ orgSlug: 'acme', formSlug: 'gone', baseUrl: BASE, fetch: fetchMock })).toBeNull();
  });

  it('rejects on any other refusal', async () => {
    const fetchMock = fetchReturning(jsonResponse(500, {}));

    await expect(getApplicationForm({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock })).rejects.toThrow('HTTP 500');
  });
});

describe('submitApplication', () => {
  it('sends the application with the empty honeypot and returns the merchant\'s message', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, { message: 'Thanks! Check your inbox.' }));

    const result = await submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: APPLICATION });

    expect(result).toEqual({ ok: true, message: 'Thanks! Check your inbox.' });
    const call = sent(fetchMock);
    expect(call).toMatchObject({ url: `${BASE}/applications/forms/acme/partners`, method: 'POST', credentials: 'omit' });
    expect(call.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(call.body).toEqual({ ...APPLICATION, homepage: '' });
  });

  it('sends the referral as the tracking token and opportunity headers', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, { message: 'Thanks' }));

    await submitApplication({
      orgSlug: 'acme',
      formSlug: 'partners',
      baseUrl: BASE,
      fetch: fetchMock,
      application: APPLICATION,
      referral: { trackingToken: `6.${'a'.repeat(24)}`, opportunityId: 6 },
    });

    expect(sent(fetchMock).headers).toEqual({
      'Content-Type': 'application/json',
      'X-Siren-Token': `6.${'a'.repeat(24)}`,
      'X-Siren-OID': '6',
    });
  });

  it('sends no referral header for an empty referral', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, { message: 'Thanks' }));

    await submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: APPLICATION, referral: { trackingToken: null, opportunityId: null } });

    expect(sent(fetchMock).headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('uses the honeypot name the form gives', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, { message: 'Thanks' }));

    await submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: { ...APPLICATION, honeypot: 'spam' }, honeypotField: 'website_url' });

    expect(sent(fetchMock).body.website_url).toBe('spam');
  });

  it('returns a message per question on a 422', async () => {
    const fetchMock = fetchReturning(
      jsonResponse(422, {
        error: {
          message: 'Some answers need another look.',
          context: { type: 'APPLICATION_ANSWERS_INVALID', fields: { website: 'Enter a web address that starts with http:// or https://.' } },
        },
      }),
    );

    expect(await submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: APPLICATION })).toEqual({
      ok: false,
      status: 422,
      message: 'Some answers need another look.',
      fieldErrors: { website: 'Enter a web address that starts with http:// or https://.' },
    });
  });

  it('returns a message per built-in field on a 400', async () => {
    const fetchMock = fetchReturning(
      jsonResponse(400, {
        error: {
          message: 'Validations failed.',
          context: {
            type: 'VALIDATION_FAILED',
            failedValidations: [{ field: 'email', message: 'email must be a valid email address of 254 characters or fewer.', type: 'INVALID_EMAIL' }],
          },
        },
      }),
    );

    const result = await submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: APPLICATION });

    expect(result).toMatchObject({ ok: false, status: 400, fieldErrors: { email: 'email must be a valid email address of 254 characters or fewer.' } });
  });

  it('says how long to wait over a rate limit', async () => {
    const fetchMock = fetchReturning(
      jsonResponse(429, { error: { message: 'Too many requests. Please try again later.', context: { retryAfter: 3600 } } }, { 'Retry-After': '3600' }),
    );

    expect(await submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: APPLICATION })).toEqual({
      ok: false,
      status: 429,
      message: 'Too many requests. Please try again later.',
      fieldErrors: {},
      retryAfter: 3600,
    });
  });

  it('rejects on a network failure', async () => {
    const fetchMock = fetchReturning(new TypeError('Failed to fetch'));

    await expect(submitApplication({ orgSlug: 'acme', formSlug: 'partners', baseUrl: BASE, fetch: fetchMock, application: APPLICATION })).rejects.toThrow('Failed to fetch');
  });
});

describe('verifyApplication', () => {
  it('confirms with the token from the email and returns the outcome', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, { outcome: 'pending', setupEmailed: true }));

    expect(await verifyApplication({ token: 'tok.en', baseUrl: BASE, fetch: fetchMock })).toEqual({ ok: true, outcome: 'pending', setupEmailed: true });
    expect(sent(fetchMock)).toMatchObject({ url: `${BASE}/applications/verify`, method: 'POST', credentials: 'omit', body: { token: 'tok.en' } });
  });

  it('reports setupEmailed only for a pending applicant', async () => {
    const fetchMock = fetchReturning(jsonResponse(200, { outcome: 'active', setupEmailed: true }));

    expect(await verifyApplication({ token: 't', baseUrl: BASE, fetch: fetchMock })).toEqual({ ok: true, outcome: 'active', setupEmailed: false });
  });

  it('returns Siren\'s message for an expired link', async () => {
    const fetchMock = fetchReturning(jsonResponse(410, { error: { message: 'This link has expired.' } }));

    expect(await verifyApplication({ token: 't', baseUrl: BASE, fetch: fetchMock })).toEqual({ ok: false, status: 410, message: 'This link has expired.' });
  });
});
