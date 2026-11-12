import type { AccessTokenSource } from './access-token-source';

/**
 * An {@link AccessTokenSource} built from two functions, for hosts that keep
 * their OAuth grant in their own storage.
 *
 * ```ts
 * const tokens = new CallbackAccessTokenSource(
 *   () => store.accessToken(),
 *   (rejected) => oauth.refresh(rejected),
 * );
 *
 * const siren = new Siren({ accessToken: tokens });
 * ```
 */
export class CallbackAccessTokenSource implements AccessTokenSource {
  /**
   * @param get Returns the current access token, or a promise of it.
   * @param refresh Gets a fresh token after a 401, or `null` when it cannot.
   *   Without it, a 401 surfaces straight away. Every answer other than
   *   `null`, an empty string, `undefined` or a number included, goes to the
   *   transport unchanged, and the transport reads it through the bearer
   *   token rule (`usableBearerToken`). So a refresh function that forgets to
   *   return raises the 401 with a `SirenError` cause, not as a source that
   *   cannot refresh.
   */
  constructor(
    private readonly get: () => string | Promise<string>,
    private readonly refresh?: (rejectedToken: string) => string | null | Promise<string | null>,
  ) {}

  async getAccessToken(): Promise<string> {
    return this.get();
  }

  async refreshAccessToken(rejectedToken: string): Promise<string | null> {
    if (this.refresh === undefined) {
      return null;
    }

    return this.refresh(rejectedToken);
  }
}
