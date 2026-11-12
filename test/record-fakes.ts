import { expect } from 'vitest';
import { ApiError, ConnectionError } from '../src/errors';
import { HttpClientError, HttpTransport } from '../src/http';
import type { HttpRequest, HttpResponse } from '../src/http';
import { FakeHttpClient, reply, spySource } from './http-fakes';

/*
 * Slice 3 test doubles for the record resources. The network boundary is the
 * SDK's `HttpClient` seam, so these tests keep the real transport and the
 * real resources, and answer at that seam, per
 * "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568). No test here builds a
 * `Siren` client or reaches the global fetch, so nothing can leave the
 * machine.
 */

/** A reserved host (RFC 6761), so even a request that slipped past the fake could not reach Siren. */
export const BASE = 'https://example.invalid/siren/v1';

/**
 * The real transport over a fake client that answers `replies` in order and
 * repeats the last. `maxRetries` defaults to 2, so a request that should
 * be sent once is visibly sent once against a client that would retry it.
 */
export function transportOver(replies: Array<HttpResponse | Error>, maxRetries = 2) {
  const http = new FakeHttpClient(replies);
  const tokens = spySource(['tok-1'], 'tok-2');
  const transport = new HttpTransport({ tokens, client: http, baseUrl: BASE, timeout: 30_000, maxRetries });
  return { http, tokens, transport };
}

/**
 * A 503 from the gateway in front of Siren while Siren is down. Siren does not
 * write this body, so any body may come with it. `Retry-After: 0` makes a
 * retry instant.
 */
export function unavailable(): HttpResponse {
  return reply(503, { error: { message: 'Service unavailable.', context: [] } }, { 'Retry-After': '0' });
}

/** A network failure at the seam, which the transport turns into `ConnectionError`. */
export function networkDown(): HttpClientError {
  return new HttpClientError('socket hang up');
}

/** The request's URL, parsed. */
export function urlOf(request: HttpRequest | undefined): URL {
  if (request === undefined) throw new Error('no request was sent');
  return new URL(request.url);
}

/** The request's path under the API base, such as `/collaborators/9`. */
export function pathOf(request: HttpRequest | undefined): string {
  return urlOf(request).pathname.replace(/^\/siren\/v1/, '');
}

/** The request's query string as a plain object. */
export function queryOf(request: HttpRequest | undefined): Record<string, string> {
  return Object.fromEntries(urlOf(request).searchParams.entries());
}

/** The request's JSON body, or undefined when it has none. */
export function bodyOf(request: HttpRequest | undefined): unknown {
  if (request === undefined) throw new Error('no request was sent');
  return request.body === undefined ? undefined : (JSON.parse(request.body) as unknown);
}

/**
 * Proves a write is sent once. Siren answers a 503 and then `then`, and the
 * client may retry twice, so a write marked retriable would be sent again and
 * resolve. It must reject with `ApiError` after one send. A second run answers
 * with a network failure first, which must reject with `ConnectionError`
 * after one send.
 */
export async function expectSentOnce(
  send: (transport: HttpTransport) => Promise<unknown>,
  then: HttpResponse,
): Promise<void> {
  const down = transportOver([unavailable(), then]);
  await expect(send(down.transport)).rejects.toBeInstanceOf(ApiError);
  expect(down.http.requests).toHaveLength(1);

  const offline = transportOver([networkDown(), then]);
  await expect(send(offline.transport)).rejects.toBeInstanceOf(ConnectionError);
  expect(offline.http.requests).toHaveLength(1);
}

/**
 * Proves a read retries. Siren answers a 503 and then `then`, and the read
 * must resolve after two sends.
 */
export async function expectRetried(
  send: (transport: HttpTransport) => Promise<unknown>,
  then: HttpResponse,
): Promise<void> {
  const down = transportOver([unavailable(), then]);
  await expect(send(down.transport)).resolves.toBeDefined();
  expect(down.http.requests).toHaveLength(2);
}

/** A list body as Cloud's ListResponseWrapperInterceptor wraps it (lib/Core/Service/Interceptors, lines 41 to 67). */
export function page<T>(items: T[], total = items.length, number = 10, offset = 0) {
  return {
    items,
    total,
    page: Math.floor(offset / number) + 1,
    perPage: number,
    totalPages: total > 0 ? Math.ceil(total / number) : 1,
  };
}

/*
 * Siren Cloud answers for the collaborator routes, written from Siren's
 * source at b6f7140 (origin/feat/node-commerce-connectors). Controllers live
 * in lib/Collaborators/Rest/Service unless a comment names another place.
 * Reads write dates as ISO 8601 (ResponseNormalizerInterceptor), and the
 * adapters behind a write's answer write `Y-m-d H:i:s`.
 */
export const CollaboratorAnswers = {
  /** GetCollaborators.php line 94, the default fields of one row. */
  listed: {
    id: 4,
    status: 'active',
    fullName: 'Flo',
    nickname: 'flo',
    email: 'flo@example.com',
    createdDate: '2026-01-15T10:30:00+00:00',
    modifiedDate: '2026-01-15T10:30:00+00:00',
  },
  /** GetCollaboratorById.php lines 54 to 68, the default fields. */
  record: {
    id: 4,
    status: 'active',
    fullName: 'Flo',
    nickname: 'flo',
    email: 'flo@example.com',
    referralCode: 'FLO',
    programs: [{ id: 2, name: 'Partners' }],
    distributors: [],
    createdDate: '2026-01-15T10:30:00+00:00',
    modifiedDate: '2026-01-15T10:30:00+00:00',
    fields: {},
  },
  /** CreateNewCollaborator through the vendor CreateController, CollaboratorAdapter::toArray. Status 201. */
  created: {
    id: 12,
    email: 'ada@example.com',
    fullName: 'Ada Lovelace',
    nickname: 'ada',
    status: 'pending',
    dateCreated: '2026-10-16 12:00:00',
    dateModified: '2026-10-16 12:00:00',
  },
  /** UpdateCollaborator.php lines 265 to 275, the record read back after the write. */
  updated: {
    id: 4,
    email: 'flo@example.com',
    fullName: 'Flo',
    nickname: 'countess',
    status: 'active',
    dateCreated: '2026-01-15 10:30:00',
    dateModified: '2026-10-16 12:00:00',
  },
  /** DeleteCollaborator.php lines 101 to 120, the first call: the record marked deleted. The second answers 204. */
  softDeleted: {
    id: 4,
    email: 'flo@example.com',
    fullName: 'Flo',
    nickname: 'flo',
    status: 'deleted',
    dateCreated: '2026-01-15 10:30:00',
    dateModified: '2026-10-16 12:00:00',
  },
  /** CollaboratorBulkAction.php line 194. */
  bulk: { success: true, affected: 2 },
  /** lib/Collaborators/Service/Providers/CollaboratorStatusProvider.php lines 34 to 58. */
  statusTypes: {
    options: { active: 'Active', inactive: 'Inactive', pending: 'Pending', rejected: 'Rejected', invited: 'Invited' },
    tones: { active: 'positive', inactive: 'negative', pending: 'warning', rejected: 'negative', invited: 'info' },
  },
  /** GenerateReferralCode.php, its docblock's example. */
  referralCode: { code: 'BCDGHJK' },
  /** lib/Collaborators/Core/Models/Adapters/AliasAdapter.php lines 24 to 32, a site's code as Cloud stores it. */
  alias: { code: 'SAVE10', type: 'coupon@property:5', collaboratorId: 4, dateIssued: '2026-10-16 12:00:00' },
  /** The same adapter, a code in no site's namespace. */
  dashboardAlias: { code: 'FLO', type: 'tracking', collaboratorId: 4, dateIssued: '2026-01-15 10:30:00' },
  /** Aliases/DeleteCollaboratorAliases.php line 77, also for a code nobody holds. */
  freed: { deleted: true },
  /** Enrollments/AddCollaboratorToProgram.php, status 201, the same for a repeat. */
  enrolled: { collaboratorId: 4, programId: 2 },
  /** Enrollments/RemoveCollaboratorFromProgram.php, also for an enrollment that does not exist. */
  unenrolled: { deleted: true },
  /**
   * Aliases/CreateCollaboratorAlias.php lines 75 to 80, through
   * ApiErrorCode::respond (lib/Core/Service/Rest/ApiErrorCode.php line 153),
   * which sends no context. Status 409.
   */
  codeHeld: { error: { message: 'That code is already held for this type.', code: 'code_held' } },
  /** saas/Auth/ConnectorRequestRules.php lines 943 to 966, through RestStrategy. Status 403. */
  programNotOnSite: {
    error: { message: "That program doesn't run on this site.", code: 'program_not_on_site', context: { param: 'programId' } },
  },
  /** saas/Auth/ConnectorRequestRules.php lines 849 to 856, a site's PUT with a field it may not send. Status 403. */
  fieldNotAllowed: {
    error: { message: 'A connected site may not send trackingId here.', code: 'field_not_allowed', context: { param: 'trackingId' } },
  },
  /** saas/Auth/ConnectorRequestRules.php line 257. Status 403. */
  pendingStatusRequired: {
    error: {
      message: 'A connected site creates collaborators as pending. The organization approves them.',
      code: 'pending_status_required',
      context: { param: 'status' },
    },
  },
  /** saas/Auth/ConnectorRequestRules.php line 980, refuseReservedAddress, raised through RestStrategy. Status 422. */
  reservedAddress: {
    error: {
      message: 'This address is reserved by Siren Cloud. Sign up with a real email address.',
      code: 'reserved_address',
      context: { param: 'email' },
    },
  },
  /** lib/Collaborators/Service/Handlers/Interceptors/SaveCollaboratorTrackingAlias.php lines 76 to 84, a tracking code another collaborator holds. Status 400. */
  trackingTaken: {
    error: {
      message: 'Validations failed.',
      context: {
        type: 'VALIDATION_FAILED',
        failedValidations: [
          {
            field: 'trackingId',
            message: 'trackingId is already in use by another collaborator. Tracking codes ignore upper and lower case.',
            type: 'DUPLICATE_ENTRY',
            context: [],
          },
        ],
      },
    },
  },
  /** CollaboratorBulkAction.php lines 181 to 190 and describeSignupEmailFailure at line 202, two of three signup emails sent. Status 502. */
  /**
   * saas/Auth/ConnectorRequestRules.php line 1081, with the code from
   * lib/Core/Service/Rest/ApiErrorCode.php line 43. Status 403, the default
   * in saas/Auth/ConnectorRefusedException.php line 19.
   */
  userTypeNotAllowed: {
    error: {
      message: 'A connected site may not use the user type, which names a Cloud account. Use wordpress_user.',
      code: 'user_type_not_allowed',
      context: { param: 'type' },
    },
  },
  signupEmailFailed: {
    error: {
      message: 'Signup email sent to 2 collaborator(s). 1 could not be sent. Please try again or contact support.',
      context: { type: 'signup_email_failed', sent: 2, failed: 1 },
    },
  },
} as const;

/**
 * saas/Auth/OrgRateLimitMiddleware.php lines 137 to 141, which
 * saas/public/index.php registers at line 316. Status 429, sent with
 * `Retry-After`.
 */
export const rateLimited = {
  error: { message: 'Too many requests. Please try again later.', context: { retryAfter: 0 } },
} as const;

/** saas/Strategies/RestStrategy.php line 330, the answer for an error nothing else caught. Status 500. */
export const unexpectedFailure = {
  error: { message: 'An unexpected error occurred. Sorry, that is all I know.' },
} as const;

/*
 * Siren Cloud answers for collaborator groups (lib/Plus/Rest/Service/Groups),
 * programs (lib/Programs/Rest/Service) and program groups
 * (lib/ProgramGroups/Rest/Service), at b6f7140.
 */
export const GroupAnswers = {
  /** GetCollaboratorGroups.php line 69, the default fields, with tests/Unit/Plus/Groups/Adapters/CollaboratorGroupAdapterTest.php values. */
  listed: { id: 7, name: 'Sales Team', description: 'Western region reps', structure: 'flat' },
  /** CreateNewCollaboratorGroup through CollaboratorGroupAdapter.php lines 21 to 28. Status 201. Members are not echoed. */
  created: {
    id: 7,
    name: 'Sales Team',
    description: '',
    structure: 'flat',
    dateCreated: '2026-11-12 10:00:00',
    dateModified: '2026-11-12 10:00:00',
  },
  /** UpdateCollaboratorGroup, the same adapter. */
  updated: {
    id: 7,
    name: 'Sales Reps',
    description: '',
    structure: 'flat',
    dateCreated: '2026-11-12 10:00:00',
    dateModified: '2026-11-12 11:00:00',
  },
  /** GetCollaboratorGroupStructureResolvers through RegistryResponseInterceptor, the flat resolver. */
  structures: {
    options: [
      {
        id: 'flat',
        name: 'Flat',
        description: 'A flat collection of collaborators with no internal hierarchy. Every member is a peer.',
        providedWalkerCapabilities: [],
      },
    ],
  },
  /** GetCollaboratorGroupMembers.php line 72, with CollaboratorGroupMemberAdapterTest.php values. */
  member: {
    id: 1,
    groupId: 5,
    collaboratorId: 42,
    metadata: { level: 'L1' },
    dateCreated: '2026-11-12 10:00:00',
    dateModified: '2026-11-12 10:00:00',
  },
  /** RequiresCapabilityMiddleware.php lines 61 to 67 on the group writes. Status 403. */
  planRequired: {
    error: { message: 'Your plan does not include this feature.', code: 'plan_required', context: { capability: 'collaborator-groups' } },
  },
  /** RemoveCollaboratorGroupMember.php line 70, through Response::setError. Status 404. */
  memberNotFound: { error: 'Collaborator group member not found.' },
} as const;

export const ProgramAnswers = {
  /** GetPrograms.php line 92, the default fields, with the extended resolvers' `{ id, name }` objects. */
  listed: {
    id: 1,
    name: 'Affiliates',
    description: 'Ten percent of each sale',
    status: 'active',
    units: 'USD',
    incentiveType: { id: 'saleTransactionPercentage', name: 'Percentage of each sale' },
    incentiveResolverType: { id: 'newestBindingWins', name: 'Newest engagement wins' },
    createdDate: '2026-01-01T00:00:00+00:00',
    modifiedDate: '2026-01-01T00:00:00+00:00',
  },
  /** CreateNewProgram through ProgramAdapter, plain ids and stored dates. Status 201. */
  created: {
    id: 1,
    name: 'Affiliates',
    incentiveType: 'saleTransactionPercentage',
    incentiveResolverType: 'newestBindingWins',
    status: 'active',
    description: 'Ten percent of each sale',
    units: 'USD',
    dateCreated: '2026-11-12 10:00:00',
    dateModified: '2026-11-12 10:00:00',
  },
  /** UpdateProgram.php lines 276 to 294, the adapter record read back. */
  updated: {
    id: 1,
    name: 'Affiliates',
    incentiveType: 'saleTransactionPercentage',
    incentiveResolverType: 'newestBindingWins',
    status: 'inactive',
    description: 'Ten percent of each sale',
    units: 'USD',
    dateCreated: '2026-11-12 10:00:00',
    dateModified: '2026-11-12 11:00:00',
  },
  /** DeleteProgram.php lines 100 to 128, the first call. The second answers 204. */
  softDeleted: {
    id: 1,
    name: 'Affiliates',
    incentiveType: 'saleTransactionPercentage',
    incentiveResolverType: 'newestBindingWins',
    status: 'deleted',
    description: 'Ten percent of each sale',
    units: 'USD',
    dateCreated: '2026-11-12 10:00:00',
    dateModified: '2026-11-12 12:00:00',
  },
  /** GetProgramById.php line 136, through Response::setError. Status 404. */
  notFound: { error: 'No record found with that ID.' },
  /** tests/Programs/Rest/Service/DeleteProgramTest.php lines 334 to 355. Status 409. */
  deleteBlocked: {
    error:
      'This program cannot be permanently deleted because it still has 1 obligation that has not been paid out. Settle or cancel them first.',
  },
  /** ProgramBulkAction.php line 152. */
  bulk: { success: true, affected: 2 },
  /** GetProgramStatusTypes.php lines 49 to 65. */
  statusTypes: { options: { active: 'Active', inactive: 'Inactive' }, tones: { active: 'positive', inactive: 'negative' } },
  /** GetProgramIncentiveTypes.php lines 56 to 67, the core resolvers. */
  incentiveTypes: {
    options: [
      { id: 'newestBindingWins', name: 'Newest engagement wins' },
      { id: 'oldestBindingWins', name: 'Oldest engagement wins' },
    ],
  },
  /** GetProgramCurrencyTypes.php line 66, a bare array of lib/Commerce/Adapters/CurrencyAdapter.php rows (lib/Commerce/Models/Currency.php for the values). */
  currencyTypes: [
    { id: 'USD', symbol: '$', position: 'before', name: 'US Dollar', scale: 2, decimalPlaces: 2, type: 'monetary' },
  ],
} as const;

export const ProgramGroupAnswers = {
  /** GetProgramGroups, the default fields `id,name,description,sorter`. */
  listed: { id: 3, name: 'Partners', description: 'Partner programs', sorter: 'newestBindingWins' },
  /** CreateNewProgramGroup through ProgramGroupAdapter::toArray, no dates. Status 201. */
  created: { id: 3, name: 'Partners', description: 'Partner programs', sorter: 'newestBindingWins' },
  /** UpdateProgramGroup through ProgramGroupAdapter::toArray. */
  updated: { id: 3, name: 'Partners', description: 'Partner programs', sorter: 'oldestBindingWins' },
  /** ProgramGroupBulkAction.php line 115. */
  bulk: { success: true, affected: 1 },
  /** RequiresCapabilityMiddleware on the program group writes. Status 403. */
  planRequired: {
    error: { message: 'Your plan does not include this feature.', code: 'plan_required', context: { capability: 'program-groups' } },
  },
} as const;
