import { vi } from 'vitest';
import type { AccessTokenSource } from '../src/auth/access-token-source';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http';

/*
 * Slice 2 test doubles. The network boundary in this slice is the SDK's
 * `HttpClient` seam, so the integration tests mock there and keep the real
 * transport and the real resources, per Integration Testing Standards (KB 568).
 */

/** An `HttpResponse` with a JSON body, or an empty body when `body` is undefined. */
export function reply(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
  statusText?: string,
): HttpResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ...(statusText !== undefined ? { statusText } : {}),
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: text,
  };
}

/**
 * An `HttpClient` that records every request it is handed, by reference, and
 * answers with the given replies in order, repeating the last one. An `Error`
 * in the list is thrown instead of answered.
 *
 * It keeps the request objects themselves, so a transport that changed one
 * request's headers in place to build the next would show the change here.
 */
export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private index = 0;

  constructor(private readonly replies: Array<HttpResponse | Error>) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.replies[Math.min(this.index, this.replies.length - 1)];
    this.index += 1;
    if (next === undefined) throw new Error('FakeHttpClient: no replies configured');
    if (next instanceof Error) throw next;
    return next;
  }

  /** The bearer token each request carried, in send order. */
  bearers(): Array<string | undefined> {
    return this.requests.map((request) => {
      const header = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization');
      return header?.[1];
    });
  }
}

/**
 * A token source whose two methods are spies. `getAccessToken` answers each
 * token in `tokens` in turn, repeating the last. `refreshAccessToken`
 * answers `refreshed`, or throws it when it is an `Error`.
 */
export function spySource(
  tokens: string[] = ['tok-1'],
  refreshed: string | null | Error = 'tok-2',
): AccessTokenSource & {
  getAccessToken: ReturnType<typeof vi.fn>;
  refreshAccessToken: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  return {
    getAccessToken: vi.fn(async () => tokens[Math.min(index++, tokens.length - 1)]!),
    refreshAccessToken: vi.fn(async (_rejected: string) => {
      if (refreshed instanceof Error) throw refreshed;
      return refreshed;
    }),
  };
}

/*
 * Siren Cloud answers, written from Siren's source at bb49b7d (the clone in
 * the research clones folder). The error envelope is the one
 * saas/Strategies/RestStrategy.php builds: `{ error: { message, code?, context } }`,
 * where an empty PHP context array encodes as `[]`.
 */
export const CloudAnswers = {
  /**
   * An expired or unknown access token. ConnectorTokenMiddleware ignores a
   * token it cannot verify, the route then reaches org data with no
   * credential, and RestStrategy's TenantContextMissingException branch
   * answers 401 with this body and no code.
   */
  authenticationRequired: { error: { message: 'Authentication required.', context: [] } },
  /**
   * An expired or unknown token on the event routes. ApiKeyAuthMiddleware
   * (saas/Auth/ApiKeyAuthMiddleware.php line 228) answers 401 with this body
   * and no code after the token fails and no key matches it.
   */
  eventTokenRefused: {
    error: {
      message: 'Invalid API key. Copy the key from Siren again, or make a new one under API keys.',
      context: [],
    },
  },
  /**
   * A revoked or inactive connected site on the event routes.
   * ApiKeyAuthMiddleware lines 384 and 394 answer 401 with this body and no
   * code, so the SDK raises AuthenticationError, not SiteDisconnectedError
   * (A137).
   */
  eventSiteRevoked: {
    error: {
      message: "This site's connection to Siren Cloud was revoked. Reconnect it from the plugin.",
      context: [],
    },
  },
  /**
   * A revoked, cut-off or closed site. ConnectorTokenMiddleware::refuseInactive
   * throws ConnectorRefusedException with ApiErrorCode::SITE_DISCONNECTED.
   */
  siteDisconnected: {
    error: { message: 'This site is no longer connected.', code: 'site_disconnected', context: [] },
  },
  /** Response::setError in saas/Http/Response.php, as GetConversionById and GetTransactionById call it. */
  notFound: { error: 'No record found with that ID.' },
  /** GetConversionById's DEFAULT_FIELDS, with the dates ResponseNormalizerInterceptor writes as ATOM. */
  conversion: {
    id: 7,
    engagementId: 31,
    transactionId: 12,
    obligationId: null,
    status: 'approved',
    type: 'sale',
    dateCreated: '2026-11-01T10:15:00+00:00',
    dateModified: '2026-11-02T08:00:00+00:00',
  },
  /** GetTransactionById's DEFAULT_FIELDS. */
  transaction: { id: 12, status: 'complete', dateCreated: '2026-11-01T10:14:58+00:00' },
} as const;
