import { ConnectorScope } from '../auth/connector-scope';
import { ConnectionError, SirenError, UnexpectedResponseError, errorFromResponse } from '../errors';
import { DEFAULT_BASE_URL, FetchHttpClient, HttpClientError } from '../http';
import type { HttpClient, HttpResponse } from '../http';
import { OAuthError } from './errors';
import { ConnectorSoftware } from './types';
import type {
  OAuthAuthorizeParams,
  OAuthClientOptions,
  OAuthClientRegistration,
  OAuthExchangeCodeParams,
  OAuthRefreshParams,
  OAuthRegisterParams,
  OAuthTokenResponse,
} from './types';

/** Where the merchant's browser approves a connection. Siren's `WpConnectUrlProvider::getConsentScreenUrl`. */
export const DEFAULT_CONSENT_SCREEN_URL = 'https://api.sirenaffiliates.com/connect-site';

/**
 * The OAuth wait. Siren Cloud answers a repeat of a rotated refresh token
 * for 30 seconds, sized for a site that waits up to 15 (`OAuthService::
 * REFRESH_REUSE_GRACE_SECONDS`).
 */
export const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;

/** The SDK's `User-Agent`, the one `HttpTransport` sends. */
const USER_AGENT = 'siren-sdk-typescript/0.3.0';

/**
 * Token fields of an OAuth answer, named in lower case with no `_` or `-`,
 * so `refresh_token` and `refreshToken` both match. No error built from an
 * answer carries their values.
 */
const TOKEN_FIELDS: ReadonlySet<string> = new Set(['accesstoken', 'refreshtoken', 'idtoken']);

/** How deep an error's copy of an answer goes. Anything deeper is replaced whole. */
const MAX_SCRUB_DEPTH = 32;

/** The only shape an S256 challenge has: 43 base64url characters, no padding. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const SOFTWARE_IDS: readonly string[] = Object.values(ConnectorSoftware);

/**
 * Siren Cloud's OAuth provider, as a connected site calls it: register once,
 * send the merchant to the consent screen, exchange the code, refresh.
 * Mirrors Siren's `ProviderClient` and `WpOAuthProviderClient`. It holds no
 * state: the store keeps the client id, the state, the verifier and the
 * token pair.
 *
 * Every call follows the same rules:
 *
 * - It sends one JSON `POST` through the `HttpClient` to `{baseUrl}/oauth/...`,
 *   with `Content-Type: application/json`, `Accept: application/json` and
 *   the SDK's `User-Agent`, and no `Authorization` header. The body is the
 *   grant itself.
 * - It is sent exactly once, whatever the answer, with the SDK's headers and
 *   the client's `timeout`. Cloud revokes a refresh token's whole family
 *   when it sees the token again more than 30 seconds after it rotated, an
 *   authorization code is single use, and each registration makes a new
 *   client, so only the caller may decide to send again.
 * - A 2xx answer whose body is a JSON object with the field the call needs
 *   (`client_id` for `register`, `access_token` and `refresh_token` for a
 *   token) resolves with that body as Cloud sent it. Any other 2xx raises
 *   `UnexpectedResponseError`.
 * - A 400 or 401 whose JSON body has a text `error` raises {@link OAuthError}
 *   with that code. A 3xx raises `SirenError` and is never followed. Any
 *   other status raises the error `errorFromResponse` builds for it:
 *   `RateLimitError` for 429, `ApiError` for 5xx.
 * - An `HttpClientError` raises `ConnectionError` whose `cause` is the client
 *   error's own `cause`, or nothing when it has none. Unlike the transport,
 *   it never makes the client error itself the cause, because that error's
 *   message may quote the grant. Any other error from the client reaches the
 *   caller unchanged.
 * - No error it builds carries a secret the call sent (the code, the
 *   verifier, the refresh token or the `attemptId`, each replaced in the
 *   client error's message) or a token from Cloud's answer, in its message,
 *   `data`, `code`, any other field or a `cause` it sets. A
 *   `ConnectionError`'s `cause` is the host's own error, as the host built
 *   it.
 */
export class OAuthClient {
  private readonly client: HttpClient;
  private readonly baseUrl: string;
  private readonly consentScreenUrl: string;
  private readonly timeout: number;

  /**
   * Throws `SirenError`, as `new Siren()` does, for an `httpClient` without a
   * `send` function, `null` included.
   */
  constructor(options: OAuthClientOptions = {}) {
    const given: OAuthClientOptions = options ?? {};
    this.client = resolveHttpClient(given.httpClient);
    this.baseUrl = (given.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.consentScreenUrl = given.consentScreenUrl ?? DEFAULT_CONSENT_SCREEN_URL;
    this.timeout = given.timeout ?? DEFAULT_OAUTH_TIMEOUT_MS;
  }

  /**
   * RFC 7591 dynamic registration, `POST /oauth/register`, with body
   * `{ client_name, redirect_uris, scope }` plus `software_id` when given.
   * `scope` defaults to `ConnectorScope.CONNECTED_SITE`. Cloud answers 201.
   *
   * Throws `SirenError` before sending when `clientName` is empty or only
   * white space, `redirectUris` is empty or holds a value that is not a
   * non-empty string, or `softwareId` is given and is not a
   * `ConnectorSoftware` value.
   */
  async register(params: OAuthRegisterParams): Promise<OAuthClientRegistration> {
    const { clientName, redirectUris, scope, softwareId } = params ?? ({} as OAuthRegisterParams);
    if (typeof clientName !== 'string' || clientName.trim() === '') {
      throw new SirenError('Siren: register needs a clientName that is not empty.');
    }
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isFilled)) {
      throw new SirenError('Siren: register needs redirectUris, a list of one or more non-empty strings.');
    }
    if (softwareId !== undefined && !SOFTWARE_IDS.includes(softwareId)) {
      throw new SirenError(`Siren: register needs a softwareId from ConnectorSoftware (${SOFTWARE_IDS.join(', ')}).`);
    }

    const body: Record<string, unknown> = {
      client_name: clientName,
      redirect_uris: redirectUris,
      scope: scope ?? ConnectorScope.CONNECTED_SITE,
    };
    if (softwareId !== undefined) body.software_id = softwareId;
    return this.send<OAuthClientRegistration>('/oauth/register', body, ['client_id'], []);
  }

  /**
   * The consent screen URL to send the merchant's browser to:
   * `consentScreenUrl` with the query `client_id`, `redirect_uri`,
   * `code_challenge`, `code_challenge_method=S256`, `state` and `scope`, in
   * that order, as `OAuthConnectService::begin()` builds it. `scope`
   * defaults to `ConnectorScope.CONNECTED_SITE`. Sends nothing.
   *
   * Throws `SirenError` when `clientId`, `redirectUri` or `state` is empty,
   * or when `codeChallenge` is not 43 characters of `A-Z`, `a-z`, `0-9`, `-`
   * and `_`, the only shape an S256 challenge has, so a verifier passed by
   * mistake never lands in a browser's address bar, when the verifier came
   * from `createCodeVerifier`, whose 64 hex digits never pass. No message
   * quotes the value it refused.
   */
  authorizeUrl(params: OAuthAuthorizeParams): string {
    const { clientId, redirectUri, state, codeChallenge, scope } = params ?? ({} as OAuthAuthorizeParams);
    requireFilled('authorizeUrl', { clientId, redirectUri, state });
    if (typeof codeChallenge !== 'string' || !S256_CHALLENGE.test(codeChallenge)) {
      throw new SirenError(
        'Siren: authorizeUrl needs codeChallenge to be codeChallengeS256(verifier), 43 characters of A-Z, a-z, 0-9, "-" and "_". Never pass the verifier itself.',
      );
    }

    const query = new URLSearchParams();
    query.append('client_id', clientId);
    query.append('redirect_uri', redirectUri);
    query.append('code_challenge', codeChallenge);
    query.append('code_challenge_method', 'S256');
    query.append('state', state);
    query.append('scope', scope ?? ConnectorScope.CONNECTED_SITE);
    const separator = this.consentScreenUrl.includes('?') ? '&' : '?';
    return `${this.consentScreenUrl}${separator}${query.toString()}`;
  }

  /**
   * Exchanges the callback's code, `POST /oauth/token` with body
   * `{ grant_type: 'authorization_code', client_id, code, redirect_uri,
   * code_verifier }`.
   *
   * Throws `SirenError` before sending when any of the four is empty. A
   * `ConnectionError` leaves it unknown whether Cloud spent the code, so the
   * store starts the connection over with a new verifier and state rather
   * than sending the code again.
   */
  async exchangeCode(params: OAuthExchangeCodeParams): Promise<OAuthTokenResponse> {
    const { clientId, code, redirectUri, codeVerifier } = params ?? ({} as OAuthExchangeCodeParams);
    requireFilled('exchangeCode', { clientId, code, redirectUri, codeVerifier });

    return this.send<OAuthTokenResponse>(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      },
      ['access_token', 'refresh_token'],
      [code, codeVerifier],
    );
  }

  /**
   * Spends the refresh token for a new pair, `POST /oauth/token` with body
   * `{ grant_type: 'refresh_token', client_id, refresh_token }` plus
   * `attempt_id` when given. Cloud rotates the token on every refresh, so
   * store the answer's `refresh_token` before anything else reads the pair.
   *
   * The store takes its own lock around a refresh, so two refreshes of one
   * token never race. After a `ConnectionError`, a 429 or a 5xx it may send
   * the same refresh again once, with the same `attemptId`, within 30
   * seconds of the first try. Any further recovery goes through its queue
   * with that `attemptId`. Later than 30 seconds, Cloud reads the repeat as
   * a stolen token and revokes the whole family.
   * That one resend is the only exception to the rule that the site's
   * queue owns retries. A queue waits minutes between tries, and Cloud's
   * window closes after 30 seconds. The SDK itself never resends a refresh.
   *
   * Throws `SirenError` before sending when `clientId` or `refreshToken` is
   * empty, or `attemptId` is given and empty.
   */
  async refresh(params: OAuthRefreshParams): Promise<OAuthTokenResponse> {
    const { clientId, refreshToken, attemptId } = params ?? ({} as OAuthRefreshParams);
    requireFilled('refresh', { clientId, refreshToken });
    if (attemptId !== undefined) requireFilled('refresh', { attemptId });

    const body: Record<string, unknown> = { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken };
    const secrets = [refreshToken];
    if (attemptId !== undefined) {
      body.attempt_id = attemptId;
      secrets.push(attemptId);
    }
    return this.send<OAuthTokenResponse>('/oauth/token', body, ['access_token', 'refresh_token'], secrets);
  }

  /**
   * Sends one JSON `POST` to `{baseUrl}{path}`, once, and maps the answer as
   * the class comment says. `needs` names the fields a 2xx body must carry
   * as non-empty strings. `secrets` are the values this call sent that no
   * error may show.
   */
  private async send<T>(path: string, body: Record<string, unknown>, needs: readonly string[], secrets: readonly string[]): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let reply: HttpResponse;
    try {
      reply = await this.client.send({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        timeout: this.timeout,
      });
    } catch (error) {
      if (!(error instanceof HttpClientError)) throw error;
      throw new ConnectionError(
        `Siren: POST ${url} failed: ${redact(error.message, secrets)}`,
        error.cause !== undefined ? { cause: error.cause } : {},
      );
    }

    const status = reply.status;
    const answer = parseJson(reply.body);

    if (status >= 200 && status < 300) {
      if (isJsonObject(answer) && needs.every((field) => isFilled(answer[field]))) return answer as T;
      throw new UnexpectedResponseError(
        `Siren: POST ${path} answered ${status} without a JSON object holding ${needs.join(' and ')}.`,
        { statusCode: status },
      );
    }

    // Past this point the answer only feeds an error, which carries no
    // secret this call sent and no token value from the answer.
    const shown = scrub(answer, secrets);

    if (status >= 300 && status < 400) {
      throw new SirenError(`Siren: POST ${path} answered a redirect (${status}), which the SDK never follows.`, {
        statusCode: status,
      });
    }

    if ((status === 400 || status === 401) && isJsonObject(shown) && isFilled(shown.error)) {
      const description = isFilled(shown.error_description) ? shown.error_description : shown.error;
      throw new OAuthError(description, { code: shown.error, statusCode: status });
    }

    throw errorFromResponse(status, redact(reply.statusText ?? '', secrets), shown, headerOf(reply, 'retry-after'));
  }
}

/** A non-empty string. */
function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Throws `SirenError` naming the first field that is not a non-empty string, never its value. */
function requireFilled(method: string, fields: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!isFilled(value)) throw new SirenError(`Siren: ${method} needs ${name} to be a non-empty string.`);
  }
}

/** A JSON object, not an array or `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parsed body, or `undefined` when it is empty or not JSON. */
function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A reply header, looked up in any case. */
function headerOf(reply: HttpResponse, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = Object.entries(reply.headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return found ? found[1] : null;
}

/**
 * Replaces every occurrence of every secret in `text` in one pass, longest
 * first, so a secret that holds another is removed whole. The same rule as
 * the transport's token scrub.
 */
function redact(text: string, secrets: readonly string[]): string {
  const filled = [...new Set(secrets.filter(isFilled))];
  if (filled.length === 0) return text;
  const pattern = filled
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), '[redacted]');
}

/**
 * A copy of a parsed answer that an error may carry. Every secret is
 * replaced in each string and each key, the value of each token field is
 * replaced whole, and anything nested deeper than {@link MAX_SCRUB_DEPTH}
 * is replaced whole, so a deep answer still raises a `SirenError`.
 */
function scrub(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_SCRUB_DEPTH) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // defineProperty keeps a `__proto__` key an own field of the copy.
    Object.defineProperty(copy, redact(key, secrets), {
      value: isTokenField(key) ? '[redacted]' : scrub(item, secrets, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** A token field's name, in any case, with or without `_` or `-`. */
function isTokenField(key: string): boolean {
  return TOKEN_FIELDS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/**
 * Answers the given `httpClient`, any object with a `send` function, or a
 * `FetchHttpClient` that reads the global fetch at each send when the
 * option is absent. The same rule as `new Siren()`.
 */
function resolveHttpClient(httpClient: unknown): HttpClient {
  if (httpClient === undefined) return new FetchHttpClient();
  if (typeof httpClient === 'object' && httpClient !== null && typeof (httpClient as HttpClient).send === 'function') {
    return httpClient as HttpClient;
  }
  throw new SirenError('Siren: httpClient must be an object with a send function.');
}
