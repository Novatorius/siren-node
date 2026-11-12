import { DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, FetchHttpClient, HttpTransport } from '../http';
import { StaticAccessToken } from '../auth/static-access-token';
import { EventsResource } from '../resources/events';
import { ConnectResource } from './connect-resource';
import type { SirenConnectOptions } from './types';

/**
 * The client a connected site holds once it has an OAuth grant. It sends the
 * site's access token to the connected-site routes, and to the event route
 * for forwarded events, and refreshes the token once after a 401 when
 * `accessToken` is an `AccessTokenSource`.
 *
 * ```ts
 * import { SirenConnect } from '@novatorius/siren/connect';
 *
 * const siren = new SirenConnect({
 *   accessToken: new CallbackAccessTokenSource(
 *     () => store.accessToken(),
 *     (rejected) => store.refresh(rejected),
 *   ),
 * });
 * const plan = await siren.connect.plan();
 * ```
 */
export class SirenConnect {
  /** The `/connect/*` routes and `/ping`. */
  readonly connect: ConnectResource;
  /** `events.forward`, and the rest of the events resource, sent with the site's token. */
  readonly events: EventsResource;

  /**
   * Takes the options `new Siren()` takes, with `accessToken` required, and
   * resolves them by the same rules, through the same code, so the two
   * clients never disagree about an option. It throws `SirenError` where
   * `new Siren()` would, and also when `apiKey` is given, naming
   * `accessToken`: an API key has no connected-site scope.
   */
  constructor(options: SirenConnectOptions) {
    // Stub: slice 5 packet P5.
    void options;
    const http = new HttpTransport({
      tokens: new StaticAccessToken('stub'),
      client: new FetchHttpClient(),
      baseUrl: DEFAULT_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
    });
    this.connect = new ConnectResource(http);
    this.events = new EventsResource(http);
  }
}
