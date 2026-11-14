import { createHttpTransport, ownOption } from '../client';
import { SirenError } from '../errors';
import { EventsResource } from '../resources/events';
import { ConnectResource } from './connect-resource';
import type { SirenOptions } from '../types';
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
    // Read each option once, as `new Siren()` reads it, and hand that one
    // reading on, so a getter cannot pass these checks with one value and
    // reach the transport with another.
    const given: unknown = options ?? {};
    const read = {
      apiKey: ownOption(given, 'apiKey'),
      accessToken: ownOption(given, 'accessToken'),
      httpClient: ownOption(given, 'httpClient'),
      baseUrl: ownOption(given, 'baseUrl'),
      timeout: ownOption(given, 'timeout'),
      maxRetries: ownOption(given, 'maxRetries'),
    };
    if (read.apiKey !== undefined) {
      throw new SirenError(
        "SirenConnect: an apiKey has no connected-site scope. Pass the site's OAuth accessToken instead, and no apiKey.",
      );
    }
    if (read.accessToken === undefined) {
      throw new SirenError(
        "SirenConnect: an accessToken is required. Pass the site's OAuth access token, or an AccessTokenSource that refreshes it.",
      );
    }

    const http = createHttpTransport(read as SirenOptions);
    this.connect = new ConnectResource(http);
    this.events = new EventsResource(http);
  }
}
