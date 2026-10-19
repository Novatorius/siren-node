/**
 * Typed error hierarchy for the Siren SDK.
 *
 * One base error (`SirenError`) plus a subclass per HTTP status family, so
 * callers can `catch` precisely:
 *
 * | status          | error class            |
 * |-----------------|------------------------|
 * | 400             | BadRequestError        |
 * | 401             | AuthenticationError    |
 * | 403             | PermissionError        |
 * | 404             | NotFoundError          |
 * | 409             | ConflictError          |
 * | 422             | ValidationError        |
 * | 429             | RateLimitError         |
 * | 5xx             | ApiError               |
 * | network/timeout | ConnectionError        |
 *
 * `SignatureVerificationError` is thrown by webhook verification and carries
 * no HTTP status.
 */

export interface SirenErrorDetails {
  /**
   * The API's machine-readable `error.code`, when present. When the body has
   * no code, this is `error.context.type` instead (for example
   * `VALIDATION_FAILED` on a 400).
   */
  code?: string;
  /** HTTP status code that produced this error, when applicable. */
  statusCode?: number;
  /**
   * Extra detail from the error body: `error.context` (what Siren's REST layer
   * sends), or `error.data` when a body carries that instead.
   */
  data?: unknown;
  /** Underlying cause (e.g. the network error behind a ConnectionError). */
  cause?: unknown;
}

/** Base class for every error thrown by this SDK. */
export class SirenError extends Error {
  readonly code?: string;
  readonly statusCode?: number;
  readonly data?: unknown;

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'SirenError';
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.data = details.data;
  }
}

/** One broken rule from a 400 response's `error.context.failedValidations`. */
export interface FailedValidation {
  /** The request field that broke the rule. */
  field: string;
  /** A readable explanation. */
  message: string;
  /** A stable rule name you can branch on, such as `REQUIRED`. */
  type?: string;
  /** Limits behind the rule, such as `{ maxLength: 254 }`. */
  context?: Record<string, unknown>;
}

/**
 * 400 — the request was malformed or failed validation. Siren answers a
 * failed validation with 400, `code` set to `VALIDATION_FAILED`, and one
 * entry per broken rule in `fieldErrors`.
 */
export class BadRequestError extends SirenError {
  /** Each broken rule, from `error.context.failedValidations`. Empty when the body has none. */
  readonly fieldErrors: FailedValidation[];

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 400 });
    this.name = 'BadRequestError';
    this.fieldErrors = failedValidationsFrom(details.data);
  }
}

function failedValidationsFrom(data: unknown): FailedValidation[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const list = (data as { failedValidations?: unknown }).failedValidations;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is FailedValidation =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as { field?: unknown }).field === 'string' &&
      typeof (entry as { message?: unknown }).message === 'string',
  );
}

/** 401 — missing or invalid API key. */
export class AuthenticationError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 401 });
    this.name = 'AuthenticationError';
  }
}

/** 403 — the API key lacks the required scope. */
export class PermissionError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 403 });
    this.name = 'PermissionError';
  }
}

/** 404 — resource not found (e.g. refund for an unknown sale). */
export class NotFoundError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 404 });
    this.name = 'NotFoundError';
  }
}

/** 409 — the request conflicts with current state. */
export class ConflictError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 409 });
    this.name = 'ConflictError';
  }
}

/**
 * 422 — the request body failed validation. Siren reports most validation
 * failures as 400 ({@link BadRequestError}). A few routes still answer 422.
 */
export class ValidationError extends SirenError {
  /** Per-field validation errors from the API's `error.data`, when present. */
  readonly fieldErrors?: Record<string, unknown>;

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 422 });
    this.name = 'ValidationError';
    if (details.data && typeof details.data === 'object' && !Array.isArray(details.data)) {
      this.fieldErrors = details.data as Record<string, unknown>;
    }
  }
}

/** 429 — too many requests. */
export class RateLimitError extends SirenError {
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfter?: number;

  constructor(message: string, details: SirenErrorDetails & { retryAfter?: number } = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 429 });
    this.name = 'RateLimitError';
    this.retryAfter = details.retryAfter;
  }
}

/** 5xx — Siren had a problem. */
export class ApiError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'ApiError';
  }
}

/** The request never completed — DNS failure, refused connection, timeout. */
export class ConnectionError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'ConnectionError';
  }
}

/** Webhook signature verification failed. Carries no HTTP status. */
export class SignatureVerificationError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'SignatureVerificationError';
  }
}

/**
 * Extract message/code/data from a Siren error body. The `error` value is
 * polymorphic:
 *   - a plain string  → `{ "error": "something went wrong" }`
 *   - a structured object → `{ "error": { message, code?, context? } }`
 * Siren's REST layer puts extra detail in `context`, such as
 * `{ type: "VALIDATION_FAILED", failedValidations: [...] }`. An older `data`
 * key is read too. When there is no `code`, `context.type` stands in for it.
 * Anything else (non-JSON body, no `error` key) yields no message and the
 * caller falls back to the HTTP status text.
 */
function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  );
}

function parseErrorBody(body: unknown): {
  message?: string;
  code?: string;
  data?: unknown;
} {
  if (!body || typeof body !== 'object') return {};
  const raw = (body as { error?: unknown }).error;
  if (typeof raw === 'string') {
    return { message: raw };
  }
  if (raw && typeof raw === 'object') {
    const err = raw as { message?: unknown; code?: unknown; data?: unknown; context?: unknown };
    let data = err.data;
    if (data === undefined && isNonEmptyObject(err.context)) data = err.context;
    let code = typeof err.code === 'string' ? err.code : undefined;
    if (code === undefined && isNonEmptyObject(data)) {
      const type = (data as { type?: unknown }).type;
      if (typeof type === 'string') code = type;
    }
    return {
      message: typeof err.message === 'string' ? err.message : undefined,
      code,
      data,
    };
  }
  return {};
}

/**
 * Build the appropriate typed error for a non-2xx HTTP response, mapping by
 * status. Parses the polymorphic `error` body (string or object), falling back
 * to the HTTP status text when no message is present.
 */
export function errorFromResponse(
  status: number,
  statusText: string,
  body: unknown,
  retryAfterHeader?: string | null,
): SirenError {
  const parsed = parseErrorBody(body);
  const message =
    parsed.message ?? (statusText ? statusText : `Request failed with status ${status}`);
  const details: SirenErrorDetails = {
    code: parsed.code,
    statusCode: status,
    data: parsed.data,
  };

  switch (status) {
    case 400:
      return new BadRequestError(message, details);
    case 401:
      return new AuthenticationError(message, details);
    case 403:
      return new PermissionError(message, details);
    case 404:
      return new NotFoundError(message, details);
    case 409:
      return new ConflictError(message, details);
    case 422:
      return new ValidationError(message, details);
    case 429: {
      let retryAfter: number | undefined;
      if (retryAfterHeader != null) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) retryAfter = seconds;
      }
      return new RateLimitError(message, { ...details, retryAfter });
    }
    default:
      if (status >= 500) return new ApiError(message, details);
      return new SirenError(message, details);
  }
}
