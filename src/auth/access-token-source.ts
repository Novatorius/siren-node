/**
 * Supplies the bearer token the SDK sends with every request.
 *
 * A fixed API key needs nothing more than the `apiKey` option. A host that
 * holds an OAuth grant, such as a connected store, implements this interface
 * (or uses {@link CallbackAccessTokenSource}) and passes it as the
 * `accessToken` option:
 *
 * ```ts
 * const siren = new Siren({ accessToken: new MyStoredGrant() });
 * ```
 *
 * The SDK asks for the token once per call, before the first send, so a token
 * the host rotated elsewhere is picked up on the next call. When Siren answers
 * 401, the SDK calls {@link refreshAccessToken} once with the token it sent
 * and repeats the request with the new token, whether or not the request may
 * be retried, because a 401 means Siren refused the credential before doing
 * any work. A second 401 surfaces as an `AuthenticationError`, a
 * `SiteDisconnectedError` when Siren says the site is no longer connected,
 * which means the grant itself is gone and the site needs to reconnect.
 *
 * Either method may answer with a value or a promise. An error either one
 * throws reaches the caller unchanged, and nothing more is sent. That error
 * replaces the 401, `SiteDisconnectedError` included, so a refresh that Siren
 * refuses because the grant is gone answers `null` rather than throwing, and
 * the caller still sees the disconnect. Throw only for a fault, such as an
 * unreachable token store.
 *
 * The SDK does not share one refresh between calls that fail at the same
 * time. Each call refreshes at most once, so a source used by concurrent
 * callers keeps its own lock, and returns the stored token when another
 * caller already rotated it.
 */
export interface AccessTokenSource {
  /**
   * The token to send as `Authorization: Bearer <token>`. It must be a
   * non-empty string. The SDK raises `SirenError` and sends nothing when it
   * is not.
   */
  getAccessToken(): string | Promise<string>;

  /**
   * Gets a fresh token after Siren rejected `rejectedToken` with a 401.
   *
   * Store the new token, and any rotated refresh token, before returning,
   * because later calls read it through {@link getAccessToken}. If another
   * caller already rotated the token, return the stored one instead of
   * refreshing again. Return `null` when no refresh is possible, and the SDK
   * raises the 401 it received. The SDK reads any answer but a non-empty
   * string as `null`.
   */
  refreshAccessToken(rejectedToken: string): string | null | Promise<string | null>;
}
