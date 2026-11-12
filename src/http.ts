import type { AccessTokenSource } from './auth/access-token-source';
import { usableBearerToken } from './auth/bearer-token';
import { ConnectionError, SirenError, errorFromResponse } from './errors';

export const DEFAULT_BASE_URL = 'https://api.sirenaffiliates.com/siren/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** An HTTP method the SDK sends. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One outgoing request, fully built by the SDK. The URL already carries the
 * query string, and the headers already carry `Authorization`, `Accept`,
 * `User-Agent`, and `Content-Type` when there is a body. An
 * {@link HttpClient} sends it as it is.
 */
export interface HttpRequest {
  /** The HTTP method in upper case. */
  readonly method: HttpMethod;
  /** The absolute URL, including any query string. */
  readonly url: string;
  /** Header name to value. */
  readonly headers: Readonly<Record<string, string>>;
  /** The raw request body, or `undefined` for none. */
  readonly body?: string;
  /**
   * Milliseconds to allow for this one send, the SDK's `timeout` option. A
   * retry or the resend after a 401 gets the full timeout again.
   */
  readonly timeout: number;
}

/** The HTTP response an {@link HttpClient} hands back to the SDK. */
export interface HttpResponse {
  /** The HTTP status code. */
  readonly status: number;
  /** The status line's reason text, when the client has one. */
  readonly statusText?: string;
  /** Header name to value. The SDK looks names up in any case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The raw response body, or an empty string when there is none. */
  readonly body: string;
}

/**
 * The SDK's HTTP seam. A host that brings its own HTTP stack implements this
 * one method and passes the instance as the `httpClient` option:
 *
 * ```ts
 * const siren = new Siren({ apiKey, httpClient: new MyHostHttpClient() });
 * ```
 *
 * The contract is small:
 *
 * - Send the request exactly as given: method, URL, headers and body. Honor
 *   `timeout` where the host can.
 * - Never follow a redirect. Resolve with the 3xx reply as it is. A followed
 *   redirect would send the bearer token to another host and could turn a
 *   write into a bodiless GET. The SDK raises a 3xx as `SirenError`.
 * - Keep the request's headers out of every error the client throws. They
 *   carry a live credential, and the SDK hands the client's error to the
 *   caller as `cause` without changing it.
 * - Resolve with an {@link HttpResponse} for every HTTP status, 4xx and 5xx
 *   included. The SDK maps error statuses to its own errors and decides what
 *   to resend.
 * - Reject with {@link HttpClientError} only when no complete response
 *   arrived: DNS failure, refused connection, TLS error, timeout, or a
 *   connection that dropped while the body was read. The SDK may resend
 *   these when the request allows it, and raises `ConnectionError` after
 *   that. Any other error the client throws reaches the caller unchanged and
 *   is never resent, because the SDK cannot tell whether the request left.
 *
 * The SDK uses {@link FetchHttpClient} when no `httpClient` is given.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Thrown by an {@link HttpClient} when a request produced no complete HTTP
 * response. Pass the host's own error as `cause` so it stays inspectable. The
 * SDK resends where the request allows it, then raises `ConnectionError`
 * whose `cause` is that host error, or this error when it carries none, as
 * the PHP SDK does.
 */
export class HttpClientError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'HttpClientError';
  }
}

/**
 * The default {@link HttpClient}, over the Fetch API that Node 18 and later
 * provide.
 *
 * It sends the request's method, URL, headers (as the same plain object) and
 * body with `redirect: 'manual'`, so it never follows a redirect, and aborts
 * the request when `timeout` runs out, the body read included. It resolves
 * with the status, the status text, every header under its lower-case name,
 * and the body as text, for every status, 3xx included. It rejects with
 * {@link HttpClientError}, carrying fetch's error as `cause`, when fetch
 * rejects, the connection drops while the body is read, or the timeout
 * aborts the request.
 */
export class FetchHttpClient implements HttpClient {
  /**
   * @param fetchFn The fetch to call. Without one, the global `fetch` is read
   *   at each send, so a fetch replaced after the client was built is used.
   */
  constructor(private readonly fetchFn?: typeof fetch) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout);
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        redirect: 'manual',
        signal: controller.signal,
      };
      if (request.body !== undefined) init.body = request.body;

      let response: Response;
      try {
        response = await fetchFn(request.url, init);
      } catch (cause) {
        throw clientError('Request failed', cause);
      }

      let body: string;
      try {
        body = await response.text();
      } catch (cause) {
        throw clientError('Reading the response body failed', cause);
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: lowerCaseHeaders(response.headers),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Wraps a fetch failure in {@link HttpClientError}. The message names what
 * failed and fetch's own message, never the request's headers.
 */
function clientError(what: string, cause: unknown): HttpClientError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new HttpClientError(`${what}: ${detail}`, { cause });
}

/**
 * Copies reply headers into a plain object. A Fetch `Headers` already yields
 * every name in lower case.
 */
function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/**
 * What the transport hands a resource: a 2xx reply. Its shape is the part of
 * the Fetch `Response` the resources read, so a resource reads headers with
 * `headers.get(name)`, in any case, and the body with `text()` or
 * {@link parseJsonBody}.
 *
 * @internal
 */
export interface ApiResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface SirenRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Whether this request may be auto-retried on network errors and 429/5xx.
   * Idempotent reads, sales and refunds retry. A site visit, a custom event,
   * a sale with no `externalId` and management writes are sent once.
   *
   * A 401 is not a retry. Every request, retriable or not, is sent once more
   * with a refreshed token after Siren's first 401, because Siren's routes
   * answer 401 before they write. That holds by route convention in Siren,
   * so each new write route must keep it. See {@link HttpTransport.request}.
   */
  retriable: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function parseJsonBody(response: Pick<ApiResponse, 'text'>): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface HttpTransportOptions {
  /** Supplies the bearer token, and a fresh one after a 401. */
  tokens: AccessTokenSource;
  /** Sends each built request. */
  client: HttpClient;
  baseUrl: string;
  /** Milliseconds, passed to the client as `HttpRequest.timeout`. */
  timeout: number;
  maxRetries: number;
}

/**
 * Internal transport. Builds URLs, attaches the bearer token, sends through
 * the {@link HttpClient}, maps failures to typed errors, refreshes the token
 * once after a 401, and retries retriable requests with exponential backoff
 * (honoring `Retry-After` on 429). It mirrors the PHP SDK's `HttpTransport`.
 *
 * @internal
 */
export class HttpTransport {
  private readonly tokens: AccessTokenSource;
  private readonly client: HttpClient;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(options: HttpTransportOptions) {
    this.tokens = options.tokens;
    this.client = options.client;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
  }

  /**
   * Perform a request and return the reply (guaranteed 2xx).
   *
   * 1. Reads the token once, from `tokens.getAccessToken()`, before the first
   *    send. Every send of this call carries it until a refresh replaces it.
   *    A token that fails `usableBearerToken` (not a non-empty string, or
   *    holding a control character such as a line break or any character
   *    above U+00FF) raises `SirenError` whose message names
   *    `getAccessToken`, control characters and U+00FF, never quoting the
   *    value, and nothing is sent.
   * 2. Sends through `client.send()`, building a new `HttpRequest`, headers
   *    included, for each send.
   * 3. A 2xx reply is returned. Any other reply that is not a 401 is never
   *    refreshed. A 3xx raises `SirenError` with its status and is never
   *    followed or sent again.
   * 4. The first 401 of the call asks `tokens.refreshAccessToken(sent)` for a
   *    new token, passing the token that was refused. An answer that passes
   *    `usableBearerToken` is sent at once in a new request, with no wait.
   *    An answer of `null` raises the 401 as it is. Any other answer raises
   *    the 401 with `cause` set to a `SirenError` whose message names
   *    `refreshAccessToken`, control characters and U+00FF, never quoting
   *    the value, so a broken token source shows behind the 401. A later
   *    401 in the same call, with or without retries in between, never
   *    refreshes again and raises through
   *    `errorFromResponse`, so Siren's revoked-site answer surfaces as
   *    `SiteDisconnectedError`.
   *
   *    The resend after a 401 applies to every request, retriable or not,
   *    and does not use up a retry. Siren's routes answer 401 from
   *    middleware, or from a request with no accepted credential, before
   *    they write, so the refused send left nothing to duplicate. That holds
   *    by route convention in Siren, and each new write route must keep it.
   *    A send-once request therefore reaches Siren with a usable credential
   *    exactly once, and is sent at most twice: the refused send and the
   *    resend. After the resend it is never sent again, whatever the reply.
   * 5. A retriable request with retries left is sent again after a backoff on
   *    429, 5xx or an `HttpClientError`. A retriable request is sent at most
   *    `maxRetries + 2` times: its first send, `maxRetries` retries and one
   *    resend after a 401.
   * 6. With no resend left, an `HttpClientError` raises `ConnectionError`
   *    whose `cause` is the `HttpClientError`'s own `cause`, or the
   *    `HttpClientError` when it has none. Its message carries the client
   *    error's message with every token this call sent replaced. An error
   *    reply raises the `SirenError` that `errorFromResponse` builds. Any
   *    other error from the client, or from either token method, reaches the
   *    caller unchanged and nothing more is sent.
   */
  async request(req: SirenRequest): Promise<ApiResponse> {
    const url = this.buildUrl(req);
    const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;

    let token = usableBearerToken(await this.tokens.getAccessToken());
    if (token === null) {
      throw new SirenError(
        'Siren: getAccessToken did not answer a usable token. A token must be a non-empty string with no control character and no character above U+00FF.',
      );
    }
    const sent = [token];
    let refreshed = false;
    let retries = 0;

    for (;;) {
      let reply: HttpResponse;
      try {
        reply = await this.client.send(this.buildRequest(req.method, url, token, body));
      } catch (error) {
        if (!(error instanceof HttpClientError)) throw error;
        if (req.retriable && retries < this.maxRetries) {
          await sleep(this.backoffDelay(retries));
          retries += 1;
          continue;
        }
        throw new ConnectionError(`Request to ${url} failed: ${scrubTokens(error.message, sent)}`, {
          cause: error.cause !== undefined ? error.cause : error,
        });
      }

      const response = toApiResponse(reply);
      if (response.status >= 200 && response.status < 300) return response;

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        const answer: unknown = await this.tokens.refreshAccessToken(token);
        const fresh = usableBearerToken(answer);
        if (fresh !== null) {
          token = fresh;
          sent.push(fresh);
          continue;
        }
        const refused = await errorFromApiResponse(response);
        if (answer !== null) {
          // Set as Error's own constructor sets it, so `cause` stays out of JSON.
          Object.defineProperty(refused, 'cause', {
            value: new SirenError(
              'Siren: refreshAccessToken answered neither null nor a usable token. A token must be a non-empty string with no control character and no character above U+00FF.',
            ),
            writable: true,
            configurable: true,
            enumerable: false,
          });
        }
        throw refused;
      }

      const retryAfter = response.headers.get('retry-after');
      if ((response.status === 429 || response.status >= 500) && req.retriable && retries < this.maxRetries) {
        await sleep(this.backoffDelay(retries, retryAfter));
        retries += 1;
        continue;
      }

      throw await errorFromApiResponse(response);
    }
  }

  /**
   * Perform a request and return the parsed JSON body. The API returns bare
   * payloads (no `{ data }` envelope): a bare object for create/read-by-id, a
   * bare array for list endpoints.
   */
  async requestData<T>(req: SirenRequest): Promise<T> {
    const response = await this.request(req);
    const body = await parseJsonBody(response);
    return body as T;
  }

  private buildUrl(req: SirenRequest): string {
    let url = `${this.baseUrl}${req.path}`;
    if (req.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) {
        if (value === undefined || value === null) continue;
        params.append(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  /** Builds a new request, headers included, for one send. */
  private buildRequest(method: HttpMethod, url: string, token: string, body: string | undefined): HttpRequest {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'siren-sdk-typescript/0.3.0',
    };
    if (body === undefined) return { method, url, headers, timeout: this.timeout };
    headers['Content-Type'] = 'application/json';
    return { method, url, headers, body, timeout: this.timeout };
  }

  private backoffDelay(attempt: number, retryAfterHeader?: string | null): number {
    if (retryAfterHeader != null) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_BACKOFF_MS);
      }
    }
    return Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  }
}

/**
 * Replaces every occurrence of every token in `text` in one pass, longest
 * token first, so a token that holds another is removed whole.
 */
function scrubTokens(text: string, tokens: readonly string[]): string {
  const pattern = [...new Set(tokens)]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), '[redacted]');
}

/** Wraps an {@link HttpResponse} as the {@link ApiResponse} a resource reads. */
function toApiResponse(reply: HttpResponse): ApiResponse {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(reply.headers)) {
    const key = name.toLowerCase();
    if (!headers.has(key)) headers.set(key, value);
  }
  return {
    status: reply.status,
    statusText: reply.statusText ?? '',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => reply.body,
  };
}

/** Builds the typed error for a reply that is not 2xx. */
async function errorFromApiResponse(response: ApiResponse): Promise<SirenError> {
  return errorFromResponse(
    response.status,
    response.statusText,
    await parseJsonBody(response),
    response.headers.get('retry-after'),
  );
}
