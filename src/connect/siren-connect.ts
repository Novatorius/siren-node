import { DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, HttpTransport } from '../http';
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
   * `new Siren()` would, with the same message. Two refusals are its own,
   * each a message that starts `SirenConnect:` and quotes no credential:
   * `accessToken` missing or `undefined` (the message says an accessToken is
   * required), and `apiKey` given as anything but `undefined`, an empty
   * string included (the message names both `apiKey` and `accessToken`,
   * since an API key has no connected-site scope). It checks those two
   * first, reading the options as `new Siren()` reads them.
   */
  constructor(options: SirenConnectOptions) {
    // Stub: slice 5 packet P5. The placeholder client answers every send
    // itself, so the stub never reaches the network.
    void options;
    const http = new HttpTransport({
      tokens: new StaticAccessToken('stub'),
      client: { send: async () => ({ status: 200, headers: {}, body: '{}' }) },
      baseUrl: DEFAULT_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
    });
    this.connect = new ConnectResource(http);
    this.events = new EventsResource(http);
  }
}
