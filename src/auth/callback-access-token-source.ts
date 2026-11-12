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
   *   Without it, a 401 surfaces straight away. An empty string or any value
   *   that is not a string counts as `null`.
   */
  constructor(
    private readonly get: () => string | Promise<string>,
    private readonly refresh?: (rejectedToken: string) => string | null | Promise<string | null>,
  ) {}

  async getAccessToken(): Promise<string> {
    // Stub: slice 2 packet P2.
    return '';
  }

  async refreshAccessToken(_rejectedToken: string): Promise<string | null> {
    // Stub: slice 2 packet P2.
    return '';
  }
}
