import { ConnectorScope } from '../auth/connector-scope';
import { DEFAULT_BASE_URL } from '../http';
import type { HttpClient } from '../http';
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
 * - It is sent exactly once, whatever the answer. Cloud revokes a refresh
 *   token's whole family when it sees the token again more than 30 seconds
 *   after it rotated, and an authorization code is single use, so only the
 *   caller may decide to send again, with the same `attemptId` for a refresh.
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
 * - No error message, `data` or field it raises carries a secret the call
 *   sent: the code, the verifier or the refresh token, each replaced in the
 *   client error's message.
 */
export class OAuthClient {
  /**
   * Throws `SirenError`, as `new Siren()` does, for an `httpClient` without a
   * `send` function, `null` included.
   */
  constructor(options: OAuthClientOptions = {}) {
    // Stub: slice 5 packet P2.
    void options;
    void DEFAULT_BASE_URL;
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
    // Stub: slice 5 packet P2.
    void params;
    void ConnectorScope;
    return {
      client_id: '',
      client_name: '',
      redirect_uris: [],
      grant_types: [],
      token_endpoint_auth_method: 'none',
      scope: '',
    };
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
   * mistake never lands in a browser's address bar. No message quotes the
   * value it refused.
   */
  authorizeUrl(params: OAuthAuthorizeParams): string {
    // Stub: slice 5 packet P2.
    void params;
    return DEFAULT_CONSENT_SCREEN_URL;
  }

  /**
   * Exchanges the callback's code, `POST /oauth/token` with body
   * `{ grant_type: 'authorization_code', client_id, code, redirect_uri,
   * code_verifier }`.
   *
   * Throws `SirenError` before sending when any of the four is empty.
   */
  async exchangeCode(params: OAuthExchangeCodeParams): Promise<OAuthTokenResponse> {
    // Stub: slice 5 packet P2.
    void params;
    return { access_token: '', token_type: 'Bearer', expires_in: 0, scope: '', refresh_token: '' };
  }

  /**
   * Spends the refresh token for a new pair, `POST /oauth/token` with body
   * `{ grant_type: 'refresh_token', client_id, refresh_token }` plus
   * `attempt_id` when given. Cloud rotates the token on every refresh, so
   * store the answer's `refresh_token` before anything else reads the pair.
   *
   * Throws `SirenError` before sending when `clientId` or `refreshToken` is
   * empty, or `attemptId` is given and empty.
   */
  async refresh(params: OAuthRefreshParams): Promise<OAuthTokenResponse> {
    // Stub: slice 5 packet P2.
    void params;
    return { access_token: '', token_type: 'Bearer', expires_in: 0, scope: '', refresh_token: '' };
  }
}

export type { HttpClient };
