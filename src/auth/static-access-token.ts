import { SirenError } from '../errors';
import type { AccessTokenSource } from './access-token-source';

/**
 * A token that never changes, such as an API key from the Siren dashboard.
 *
 * `new Siren({ apiKey })` and `new Siren({ accessToken: '<token>' })` use
 * this. It cannot refresh, so a 401 surfaces straight away as an
 * `AuthenticationError`.
 */
export class StaticAccessToken implements AccessTokenSource {
  /**
   * @param token The token to send. Throws `SirenError` when it fails the
   *   bearer token rule, `usableBearerToken`, which explains the rule. The
   *   message names the rule and both options that build this class,
   *   `apiKey` and `accessToken`, and never quotes the token. So
   *   `new Siren({ apiKey })` refuses such a key when the client is built.
   */
  constructor(private readonly token: string) {
    if (typeof token !== 'string' || token === '') {
      throw new SirenError('StaticAccessToken needs a non-empty string token.');
    }
  }

  getAccessToken(): string {
    return this.token;
  }

  /** Always `null`: a fixed token has nothing to refresh to. */
  refreshAccessToken(_rejectedToken: string): string | null {
    return null;
  }
}
