import { SirenError } from '../errors';
import type { AccessTokenSource } from './access-token-source';

/** A server token is replaced when fewer than this many seconds of its life are left. */
export const SERVER_REFRESH_MARGIN_SECONDS = 120;

/** A browser token is replaced when fewer than this many seconds of its life are left. */
export const BROWSER_REFRESH_MARGIN_SECONDS = 60;

/** The scope that asks the token route for a browser token, followed by the event key. */
export const BROWSER_SCOPE_PREFIX = 'browser:';

/** What the token route answers a granted request with. */
export interface GrantedToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

/**
 * Sends one `client_credentials` grant to `POST /oauth/token` and answers
 * the token, or throws the error Siren's answer maps to. The transport
 * supplies it.
 *
 * @internal
 */
export type GrantRequester = (fields: Readonly<Record<string, string>>) => Promise<GrantedToken>;

interface HeldToken {
  readonly token: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * Trades an app's key for short-lived app tokens and keeps them, so a
 * caller never handles a token (slice C13, apps-event-tokens).
 *
 * Siren takes only an app token at a custom event's send address. As the
 * {@link AccessTokenSource} for those sends, this asks the token route for
 * a server token the first time one is needed, keeps it, and asks again
 * when fewer than {@link SERVER_REFRESH_MARGIN_SECONDS} are left. Callers
 * that need a token at the same moment share one request. After Siren
 * answers 401 to a token, {@link refreshAccessToken} drops it and gets a new
 * one, and the transport sends once more.
 *
 * A key that belongs to no app gets 400 `unauthorized_client` from the
 * token route. From then on this source answers the key itself, so such a
 * key sends custom events as it did before.
 *
 * Browser tokens are kept one per event in the same way, until fewer than
 * {@link BROWSER_REFRESH_MARGIN_SECONDS} are left.
 *
 * @internal
 */
export class AppAccessTokens implements AccessTokenSource {
  private readonly held = new Map<string, HeldToken>();
  private readonly pending = new Map<string, Promise<HeldToken>>();
  private keyHasNoApp = false;

  constructor(
    private readonly apiKey: string,
    private readonly requestGrant: GrantRequester,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.keyHasNoApp) return this.apiKey;
    try {
      return (await this.token('', SERVER_REFRESH_MARGIN_SECONDS)).token;
    } catch (error) {
      if (error instanceof SirenError && error.code === 'unauthorized_client') {
        this.keyHasNoApp = true;
        return this.apiKey;
      }
      throw error;
    }
  }

  async refreshAccessToken(rejectedToken: string): Promise<string | null> {
    if (rejectedToken === this.apiKey) return null;
    if (this.held.get('')?.token === rejectedToken) this.held.delete('');
    return this.getAccessToken();
  }

  /**
   * A browser token for one custom event of the app, with the seconds it
   * has left. Throws the error Siren answers when it refuses the grant, such
   * as `BadRequestError` with code `invalid_scope` for an event that is not
   * the app's or allows no domain.
   */
  async browserToken(eventKey: string): Promise<{ token: string; expiresIn: number }> {
    const held = await this.token(BROWSER_SCOPE_PREFIX + eventKey, BROWSER_REFRESH_MARGIN_SECONDS);
    return { token: held.token, expiresIn: Math.max(0, Math.round((held.expiresAt - this.now()) / 1000)) };
  }

  private token(scope: string, marginSeconds: number): Promise<HeldToken> {
    const held = this.held.get(scope);
    if (held !== undefined && held.expiresAt - this.now() >= marginSeconds * 1000) return Promise.resolve(held);

    const waiting = this.pending.get(scope);
    if (waiting !== undefined) return waiting;

    const fields: Record<string, string> = { grant_type: 'client_credentials', client_secret: this.apiKey };
    if (scope !== '') fields.scope = scope;

    const asked = this.requestGrant(fields)
      .then((granted) => {
        const fresh = { token: granted.accessToken, expiresAt: this.now() + granted.expiresIn * 1000 };
        this.held.set(scope, fresh);
        return fresh;
      })
      .finally(() => {
        this.pending.delete(scope);
      });
    this.pending.set(scope, asked);
    return asked;
  }
}
