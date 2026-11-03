/**
 * Siren Cloud application forms, run from a merchant's own site.
 *
 * The three routes are public and answer any origin, so a page calls them
 * from the visitor's browser with no API key. Call them from the browser, not
 * from a server: Siren limits applications per visitor address, and a server
 * that relays them sends every application from one address.
 */
import { STOREFRONT_DEFAULT_BASE_URL } from './constants';
import type { StorefrontFetch } from './types';

/** A field every application asks first: the nickname, name and email. */
export interface ApplicationBuiltInField {
  key: 'nickname' | 'fullName' | 'email' | (string & {});
  label: string;
  type: 'short_text' | 'email' | (string & {});
  required: boolean;
  minLength: number;
  maxLength: number;
}

/** The types of question a merchant can add to a form. */
export type ApplicationQuestionType =
  | 'short_text'
  | 'long_text'
  | 'url'
  | 'number'
  | 'select'
  | 'checkboxes'
  | 'checkbox'
  | (string & {});

/** One of the merchant's own questions. */
export interface ApplicationQuestion {
  /** The answer's key in `answers`. It never changes, even when the label does. */
  key: string;
  label: string;
  type: ApplicationQuestionType;
  /** A required checkbox must be checked. */
  required: boolean;
  help: string;
  /** The choices, for `select` and `checkboxes`. */
  options: string[];
  /** The longest answer Siren takes, or null for a choice or a checkbox. */
  maxLength: number | null;
}

/** What a page needs to render a form and check it before sending. */
export interface ApplicationFormDefinition {
  orgName: string;
  orgSlug: string;
  formName: string;
  formSlug: string;
  /** Sent at the top level of the application. */
  builtInFields: ApplicationBuiltInField[];
  /** Answered inside `answers`, keyed by `key`. */
  fields: ApplicationQuestion[];
  /** The field a page renders, hides from people, and sends empty. */
  honeypot: string;
}

/** An answer: text, the chosen options, or a yes or no. */
export type ApplicationAnswerValue = string | number | string[] | boolean;

/** What an applicant entered. */
export interface ApplicationInput {
  nickname: string;
  fullName: string;
  email: string;
  /** Answers to the form's own questions, by key. */
  answers?: Record<string, ApplicationAnswerValue>;
  /** The honeypot's value, which a person leaves empty. */
  honeypot?: string;
}

/** Where to reach Siren, shared by the three calls. */
export interface ApplicationFormTarget {
  /** The organization's slug, the first part of the form's hosted link. */
  orgSlug: string;
  /** The form's address ending. Left out, it is the organization's older single form. */
  formSlug?: string;
}

export interface ApplicationRequestOptions {
  /** The API root. Defaults to Siren Cloud's. */
  baseUrl?: string;
  /** The `fetch` to use. Defaults to the global one, looked up at call time. */
  fetch?: StorefrontFetch;
}

/** The referral the visitor arrived with, so Siren can credit the collaborator who referred them. */
export interface ApplicationReferral {
  /** The signed tracking token Siren Cloud gave the visit. Sent as `X-Siren-Token`. */
  trackingToken?: string | null;
  /** The visit's opportunity id, such as the `opportunityId` a storefront visit returned. Sent as `X-Siren-OID`. */
  opportunityId?: number | string | null;
}

/** Siren's answer to an application. */
export type SubmitApplicationResult =
  | { ok: true; message: string }
  | {
      ok: false;
      /** 400 for a built-in field, 422 for an answer, 404 for a form that is off, 429 over a rate limit. */
      status: number;
      message: string;
      /** A message for the applicant per field key, built-in fields and questions alike. */
      fieldErrors: Record<string, string>;
      /** Seconds to wait, on a 429. */
      retryAfter?: number;
    };

/** What confirming an application led to. */
export type VerifyApplicationResult =
  | {
      ok: true;
      /** `pending` waits for review, `active` is approved, `received` confirms a request to join more. */
      outcome: 'pending' | 'active' | 'received' | (string & {});
      /** Whether a `pending` applicant was emailed the link to set up their account now. */
      setupEmailed: boolean;
    }
  | { ok: false; status: number; message: string };

function root(baseUrl?: string): string {
  return (baseUrl ?? STOREFRONT_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** The public URL of a form, which reads it on GET and takes applications on POST. */
export function applicationFormUrl(target: ApplicationFormTarget & { baseUrl?: string }): string {
  const base = `${root(target.baseUrl)}/applications/forms/${encodeURIComponent(target.orgSlug)}`;
  return target.formSlug ? `${base}/${encodeURIComponent(target.formSlug)}` : base;
}

function sender(fetchImpl?: StorefrontFetch): StorefrontFetch {
  return fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(body: any, fallback: string): string {
  const error = body?.error;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  return fallback;
}

/**
 * Reads a form's field definitions. Resolves to null when the form is off,
 * deleted, or not taking applications. Any other refusal or a network
 * failure rejects.
 */
export async function getApplicationForm(
  target: ApplicationFormTarget & ApplicationRequestOptions,
): Promise<ApplicationFormDefinition | null> {
  const response = await sender(target.fetch)(applicationFormUrl(target), {
    method: 'GET',
    credentials: 'omit',
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Siren could not read the application form (HTTP ${response.status}).`);

  return (await response.json()) as ApplicationFormDefinition;
}

/**
 * Sends an application from the visitor's browser.
 *
 * Resolves to `{ ok: true, message }` with the merchant's message, or to a
 * refusal with a message per field to show the applicant. A network failure
 * rejects. An application that fills in the honeypot resolves as accepted,
 * and Siren saves nothing.
 */
export async function submitApplication(
  params: ApplicationFormTarget &
    ApplicationRequestOptions & {
      application: ApplicationInput;
      honeypotField?: string;
      referral?: ApplicationReferral;
    },
): Promise<SubmitApplicationResult> {
  const { application, referral } = params;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (referral?.trackingToken) headers['X-Siren-Token'] = referral.trackingToken;
  if (referral?.opportunityId !== undefined && referral.opportunityId !== null && `${referral.opportunityId}` !== '') {
    headers['X-Siren-OID'] = `${referral.opportunityId}`;
  }

  const body = {
    nickname: application.nickname,
    fullName: application.fullName,
    email: application.email,
    answers: application.answers ?? {},
    [params.honeypotField ?? 'homepage']: application.honeypot ?? '',
  };

  const response = await sender(params.fetch)(applicationFormUrl(params), {
    method: 'POST',
    headers,
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  const json = await readJson(response);

  if (response.ok) {
    return { ok: true, message: typeof json?.message === 'string' ? json.message : '' };
  }

  const fieldErrors: Record<string, string> = {};
  const context = json?.error?.context;

  if (context?.fields && typeof context.fields === 'object') {
    for (const [key, value] of Object.entries(context.fields)) {
      if (typeof value === 'string') fieldErrors[key] = value;
    }
  }

  if (Array.isArray(context?.failedValidations)) {
    for (const failure of context.failedValidations) {
      if (typeof failure?.field === 'string' && typeof failure?.message === 'string') {
        fieldErrors[failure.field] = failure.message;
      }
    }
  }

  const retryAfter = Number(context?.retryAfter ?? response.headers.get('Retry-After'));

  return {
    ok: false,
    status: response.status,
    message: errorMessage(json, 'Your application could not be sent. Please try again.'),
    fieldErrors,
    ...(response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
  };
}

/**
 * Confirms an application with the token from the confirmation email's link,
 * from the confirmation page on the merchant's own site. A network failure
 * rejects. An expired or unknown token resolves as a refusal with a message
 * to show.
 */
export async function verifyApplication(
  params: ApplicationRequestOptions & { token: string },
): Promise<VerifyApplicationResult> {
  const response = await sender(params.fetch)(`${root(params.baseUrl)}/applications/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ token: params.token }),
  });
  const json = await readJson(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: errorMessage(json, 'Your application could not be confirmed.'),
    };
  }

  const outcome = typeof json?.outcome === 'string' ? json.outcome : 'received';

  return { ok: true, outcome, setupEmailed: outcome === 'pending' && json?.setupEmailed === true };
}
