/**
 * Typed error hierarchy for the Siren SDK.
 *
 * One base error (`SirenError`) plus a subclass per HTTP status family, so
 * callers can `catch` precisely:
 *
 * | status          | error class            |
 * |-----------------|------------------------|
 * | 400             | BadRequestError        |
 * | 401             | AuthenticationError, or SiteDisconnectedError for `site_disconnected` and ApiKeyNotAcceptedError for `api_key_not_accepted` |
 * | 403             | PermissionError, or MissingScopeError for `missing_scope`, StoreKeyNotAllowedError for `store_key_not_allowed` and PolicyError for the {@link POLICY_ERROR_CODES} |
 * | 404             | NotFoundError          |
 * | 409             | ConflictError. A resource that knows the conflict raises CodeConflictError or HoldConflictError |
 * | 422             | ValidationError        |
 * | 429             | RateLimitError         |
 * | 5xx             | ApiError               |
 * | 2xx, wrong body | UnexpectedResponseError, an ApiError, from a read that checks its body |
 * | network/timeout | ConnectionError        |
 *
 * `SignatureVerificationError` is thrown by webhook verification and carries
 * no HTTP status.
 *
 * A specialized 401 or 403 class is chosen from `error.code` first. When the
 * reply carries a code this SDK knows ({@link isKnownErrorCode}), the code
 * alone decides. When it carries no code, or one this SDK does not know, the
 * reply comes from an older or newer Siren deployment, and the class is
 * chosen from Siren's wording instead, as the Siren PHP SDK does.
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

/**
 * The machine-readable `error.code` values Siren sends beside a refusal's
 * message, as in `{"error": {"message": "...", "code": "hold_no_credit"}}`.
 * Compare `error.code` against these, not the message, which can change.
 * The list matches the Siren service's own list of codes.
 */
export const ErrorCode = {
  /** 401: the organization revoked or deleted the connected site's connection. A {@link SiteDisconnectedError}. */
  SiteDisconnected: 'site_disconnected',
  /**
   * 401: the route does not accept an API key, such as every `/api-keys`
   * route. It takes a signed-in dashboard session. An {@link ApiKeyNotAcceptedError}.
   */
  ApiKeyNotAccepted: 'api_key_not_accepted',
  /**
   * 403: the API key holds none of the scopes the route needs.
   * `error.context.scope` names one and `error.context.anyOf` lists every
   * scope that opens the route. A {@link MissingScopeError}.
   */
  MissingScope: 'missing_scope',
  /**
   * 403: an API key bound to one store asked for records that are not kept by
   * store, such as payouts or webhook subscriptions. A {@link StoreKeyNotAllowedError}.
   */
  StoreKeyNotAllowed: 'store_key_not_allowed',
  /** 403: a site may not send this field here. `error.context.param` names it. A {@link PolicyError}. */
  FieldNotAllowed: 'field_not_allowed',
  /** 403: a site creates collaborators as pending, and sent another status. A {@link PolicyError}. */
  PendingStatusRequired: 'pending_status_required',
  /** 403: a site may not use the `user` mapping type, which names a Cloud account. A {@link PolicyError}. */
  UserTypeNotAllowed: 'user_type_not_allowed',
  /** 403: the program does not run on the site's Property. A {@link PolicyError}. */
  ProgramNotOnSite: 'program_not_on_site',
  /** 403: the collaborator does not belong to the site's Property. A {@link PolicyError}. */
  CollaboratorNotOnSite: 'collaborator_not_on_site',
  /**
   * 403: a site reads these records only through a filter that ties them to
   * its own store. `error.context.anyOf` names the filters. A {@link PolicyError}.
   */
  SiteFilterRequired: 'site_filter_required',
  /**
   * 403: a site reads only the reports its collaborator portal shows.
   * `error.context.param` names the part of the query that asked for another.
   * A {@link PolicyError}.
   */
  ReportNotAllowed: 'report_not_allowed',
  /** 403: the route's own authorization refused the caller, and no plan or role change would lift it. A {@link PolicyError}. */
  NotPermitted: 'not_permitted',
  /**
   * 403: the site's migration into Cloud is closed. A plain {@link PermissionError},
   * because an organization admin reopens it by approving the connection again.
   */
  MigrationClosed: 'migration_closed',
  /**
   * 403: the organization's plan does not include the feature.
   * `error.context.capability` names it. A plain {@link PermissionError}.
   */
  PlanRequired: 'plan_required',
  /** 403: only an organization admin may do this. A plain {@link PermissionError}. */
  AdminRequired: 'admin_required',
  /**
   * 403: the organization's owner has not confirmed their email address, and
   * the request would reach people or move money. A plain {@link PermissionError}.
   */
  EmailConfirmationRequired: 'email_confirmation_required',
  /** 409: someone already holds the code under that type, in any namespace. See {@link CodeConflictError}. */
  CodeHeld: 'code_held',
  /** 409: the mapping already exists. */
  MappingExists: 'mapping_exists',
  /** 409: the collaborator has no credit available in that currency. See {@link HoldConflictError}. */
  HoldNoCredit: 'hold_no_credit',
  /** 409: another checkout already holds credit under that token. See {@link HoldConflictError}. */
  HoldTokenInUse: 'hold_token_in_use',
  /** 409: the currency is not bound to the store asking, so its credit cannot be held there. */
  HoldCurrencyNotAtStore: 'hold_currency_not_at_store',
  /** 409: a migration batch names currencies the organization already has, and the merchant has not chosen what to do with them. */
  CurrencyResolutionRequired: 'currency_resolution_required',
  /** 422: a choice for a migrating store's currency cannot be used, such as a new code that is taken. */
  InvalidCurrencyResolution: 'invalid_currency_resolution',
  /** 422: the collaborator cannot be deleted or erased yet, because money is still owed to them. */
  CollaboratorDeletionRefused: 'collaborator_deletion_refused',
  /** 422: the email address is one Siren keeps for its own records, so no sign-up may use it. */
  ReservedAddress: 'reserved_address',
  /** 503: Siren could not read the organization's plan because its entitlement service did not answer. An {@link ApiError}. */
  PlanUnavailable: 'plan_unavailable',
} as const;

/** Union of the {@link ErrorCode} strings. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The 403 codes that mean Siren's policy refused the request, so repeating it
 * fails again. Each is a {@link PolicyError}. Matches the Siren PHP SDK's
 * `ErrorCode::POLICY`.
 */
export const POLICY_ERROR_CODES: readonly ErrorCode[] = [
  ErrorCode.FieldNotAllowed,
  ErrorCode.PendingStatusRequired,
  ErrorCode.UserTypeNotAllowed,
  ErrorCode.ProgramNotOnSite,
  ErrorCode.CollaboratorNotOnSite,
  ErrorCode.SiteFilterRequired,
  ErrorCode.ReportNotAllowed,
  ErrorCode.NotPermitted,
];

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>(Object.values(ErrorCode));

/**
 * Whether `code` is one of the {@link ErrorCode} values. A known code decides
 * the error class on its own. A missing or unknown one leaves the choice to
 * Siren's wording.
 */
export function isKnownErrorCode(code: string | null | undefined): code is ErrorCode {
  return typeof code === 'string' && KNOWN_ERROR_CODES.has(code);
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

/** 401 — missing, invalid, expired or revoked API key. */
export class AuthenticationError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 401 });
    this.name = 'AuthenticationError';
  }
}

/**
 * 401 with `code` `api_key_not_accepted` — the key may be valid, but the route
 * takes a signed-in dashboard session instead, as every `apiKeys` route does.
 * Retrying with the same key fails again.
 */
export class ApiKeyNotAcceptedError extends AuthenticationError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, code: details.code ?? ErrorCode.ApiKeyNotAccepted });
    this.name = 'ApiKeyNotAcceptedError';
  }

  /**
   * Whether a 401 is Siren's refusal of an API key on a route that takes a
   * session: the `api_key_not_accepted` code, or, from a Siren deployment
   * that sends no code this SDK knows, a message that says the route "does
   * not accept API keys".
   */
  static matches(message: string, code?: string): boolean {
    if (isKnownErrorCode(code)) return code === ErrorCode.ApiKeyNotAccepted;
    return message.toLowerCase().includes('does not accept api keys');
  }
}

/**
 * 401 with `code` `site_disconnected`: the organization revoked or deleted
 * the connected site's connection ("This site is no longer connected.").
 * Stop calling Siren for this site until it reconnects, rather than retry.
 */
export class SiteDisconnectedError extends AuthenticationError {
  /** The message Siren sends for a revoked site. */
  static readonly MESSAGE = 'This site is no longer connected.';

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, code: details.code ?? ErrorCode.SiteDisconnected });
    this.name = 'SiteDisconnectedError';
  }

  /**
   * Whether a 401 is Siren's revoked-site refusal: the `site_disconnected`
   * code, or, from a Siren deployment that sends no code this SDK knows, a
   * message that says the site is "no longer connected", in any case.
   */
  static matches(message: string, code?: string): boolean {
    if (isKnownErrorCode(code)) return code === ErrorCode.SiteDisconnected;
    return message.toLowerCase().includes('no longer connected');
  }
}

/** 403 — the credential may not do this. */
export class PermissionError extends SirenError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, statusCode: details.statusCode ?? 403 });
    this.name = 'PermissionError';
  }
}

function contextOf(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * 403 with `code` `missing_scope` — the API key holds none of the scopes the
 * route needs, such as a key without `ledger:conversions:read` reading
 * conversions. Create a key that holds one of {@link anyOf}. Retrying with the
 * same key fails again.
 */
export class MissingScopeError extends PermissionError {
  /** The scope the route needs, from `error.context.scope`, when Siren names it. */
  readonly scope?: string;
  /**
   * Every scope that opens the route, from `error.context.anyOf`, such as
   * `['webhook-subscriptions:read', 'webhook-subscriptions:manage']`. Holding
   * any one is enough. Empty when Siren does not list them.
   */
  readonly anyOf: string[];

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, code: details.code ?? ErrorCode.MissingScope });
    this.name = 'MissingScopeError';
    const context = contextOf(details.data);
    if (typeof context.scope === 'string' && context.scope !== '') this.scope = context.scope;
    this.anyOf = Array.isArray(context.anyOf)
      ? context.anyOf.filter((scope): scope is string => typeof scope === 'string' && scope !== '')
      : [];
    if (this.scope === undefined) {
      const named = MissingScopeError.MESSAGE_PATTERN.exec(message)?.[1]?.replace(/:+$/, '');
      if (named) this.scope = named;
    }
  }

  /**
   * How Siren words the refusal when it sends no code, such as "This token
   * is not authorized for connect:records:read." The first group is the scope.
   */
  static readonly MESSAGE_PATTERN = /\bnot authorized for ([A-Za-z0-9_:*-]+)/;

  /**
   * Whether a 403 is Siren's missing-scope refusal: the `missing_scope`
   * code, or, from a Siren deployment that sends no code this SDK knows, a
   * message that matches {@link MissingScopeError.MESSAGE_PATTERN}. When the
   * context names no scope, {@link scope} is read from that message, with
   * any trailing `:` removed.
   */
  static matches(message: string, code?: string): boolean {
    if (isKnownErrorCode(code)) return code === ErrorCode.MissingScope;
    return MissingScopeError.MESSAGE_PATTERN.test(message);
  }
}

/**
 * 403 with `code` `store_key_not_allowed` — an API key bound to one store asked
 * for payouts or webhook subscriptions, which are not kept by store. Use an
 * organization-wide key, one created without a `propertyId`.
 */
export class StoreKeyNotAllowedError extends PermissionError {
  /** The store the key is bound to, from `error.context.propertyId`, when Siren names it. */
  readonly propertyId?: number;

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, { ...details, code: details.code ?? ErrorCode.StoreKeyNotAllowed });
    this.name = 'StoreKeyNotAllowedError';
    const propertyId = contextOf(details.data).propertyId;
    if (typeof propertyId === 'number' && Number.isInteger(propertyId)) this.propertyId = propertyId;
  }

  /**
   * Whether a 403 is Siren's store-bound key refusal: the
   * `store_key_not_allowed` code, or, from a Siren deployment that sends no
   * code this SDK knows, a message that says the key is "bound to one store",
   * in any case.
   */
  static matches(message: string, code?: string): boolean {
    if (isKnownErrorCode(code)) return code === ErrorCode.StoreKeyNotAllowed;
    return message.toLowerCase().includes('bound to one store');
  }
}

/**
 * 403 that is not about scopes: the credential may use the route, but
 * Siren's policy refuses this request, so repeating it fails again. For a
 * connected site that is one of the connector rules, such as sending a field
 * a site may not set, or enrolling a collaborator in a program that does not
 * run on the site. {@link param} names the refused field when Siren says which.
 */
export class PolicyError extends PermissionError {
  /** What Siren says when a route's authorization policy refuses the caller. */
  static readonly DENIED_MESSAGE = "You don't have permission to do that.";

  /** The request field Siren refused, from `error.context.param`, when it names one. */
  readonly param?: string;

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'PolicyError';
    // Stub: slice 1 packet P3 reads `param` from the context.
  }

  /**
   * Whether a 403 is a policy refusal: one of the {@link POLICY_ERROR_CODES}.
   * From a Siren deployment that sends no code this SDK knows, it is a policy
   * refusal when `error.context.param` is a string, when the message is
   * {@link PolicyError.DENIED_MESSAGE} in any case, or when the message
   * mentions a "connected site" or says a program does not "run on this site".
   */
  static matches(message: string, code?: string, data?: unknown): boolean {
    // Stub: slice 1 packet P3 implements this.
    void message;
    void code;
    void data;
    return false;
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
 * 409: Siren refused to give out a tracking or coupon code because someone
 * already holds it. A code has one holder per type across every namespace,
 * so the holder may be another connected site or the dashboard. Free the code
 * first, or pick another one. A resource that assigns codes raises this from
 * the {@link ConflictError} Siren answered with, through {@link CodeConflictError.fromConflict}.
 */
export class CodeConflictError extends ConflictError {
  /** The code that is already held. */
  readonly conflictingCode: string;
  /** The plain type the code was asked for under, such as `coupon`. */
  readonly type: string;

  constructor(message: string, conflictingCode: string, type: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'CodeConflictError';
    this.conflictingCode = conflictingCode;
    this.type = type;
  }

  /**
   * Wrap the {@link ConflictError} Siren answered with. Keeps its message,
   * status, code and data, and sets it as the `cause`.
   */
  static fromConflict(conflict: ConflictError, code: string, type: string): CodeConflictError {
    return new CodeConflictError(conflict.message, code, type, {
      code: conflict.code,
      statusCode: conflict.statusCode,
      data: conflict.data,
      cause: conflict,
    });
  }
}

/** Why Siren refused a store credit hold, as {@link HoldConflictError.reason} reports it. */
export const HoldConflictReason = {
  /** The collaborator has no credit available in that currency. Apply no credit. */
  NoCredit: 'no_credit',
  /** Another site's checkout already holds credit under the same token. Mint a new token. */
  TokenInUse: 'token_in_use',
} as const;

/** Union of the {@link HoldConflictReason} strings. */
export type HoldConflictReason = (typeof HoldConflictReason)[keyof typeof HoldConflictReason];

/**
 * 409: Siren refused to place a store credit hold. {@link reason} tells the
 * causes apart. A resource that places holds raises this from the
 * {@link ConflictError} Siren answered with, through {@link HoldConflictError.fromConflict}.
 */
export class HoldConflictError extends ConflictError {
  /**
   * `no_credit` for the `hold_no_credit` code, `token_in_use` for
   * `hold_token_in_use`, and `null` for any other code this SDK knows. With
   * no code, or one this SDK does not know, it reads Siren's wording:
   * "under that token" means `token_in_use`, "no credit available" means
   * `no_credit`, in any case, and anything else is `null`. Set once, from the
   * message and code the error is built with.
   */
  readonly reason: HoldConflictReason | null;

  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'HoldConflictError';
    const code = details.code;
    const wording = message.toLowerCase();
    if (code === ErrorCode.HoldTokenInUse) this.reason = HoldConflictReason.TokenInUse;
    else if (code === ErrorCode.HoldNoCredit) this.reason = HoldConflictReason.NoCredit;
    else if (isKnownErrorCode(code)) this.reason = null;
    else if (wording.includes('under that token')) this.reason = HoldConflictReason.TokenInUse;
    else if (wording.includes('no credit available')) this.reason = HoldConflictReason.NoCredit;
    else this.reason = null;
  }

  /**
   * Wrap the {@link ConflictError} Siren answered with. Keeps its message,
   * status, code and data, and sets it as the `cause`.
   */
  static fromConflict(conflict: ConflictError): HoldConflictError {
    return new HoldConflictError(conflict.message, {
      code: conflict.code,
      statusCode: conflict.statusCode,
      data: conflict.data,
      cause: conflict,
    });
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

/**
 * Siren answered with a success status, but the body does not have the shape
 * the route documents, such as an object where a list belongs. The SDK throws
 * this rather than guess, so a broken reply never reads as an empty answer.
 * `statusCode` is the reply's status and `data` holds the body as parsed.
 */
export class UnexpectedResponseError extends ApiError {
  constructor(message: string, details: SirenErrorDetails = {}) {
    super(message, details);
    this.name = 'UnexpectedResponseError';
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
      if (SiteDisconnectedError.matches(message, parsed.code)) return new SiteDisconnectedError(message, details);
      if (ApiKeyNotAcceptedError.matches(message, parsed.code)) return new ApiKeyNotAcceptedError(message, details);
      return new AuthenticationError(message, details);
    case 403:
      if (MissingScopeError.matches(message, parsed.code)) return new MissingScopeError(message, details);
      if (StoreKeyNotAllowedError.matches(message, parsed.code)) return new StoreKeyNotAllowedError(message, details);
      if (PolicyError.matches(message, parsed.code, parsed.data)) return new PolicyError(message, details);
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
