import type { StorefrontFetch } from './types';

/** Where `track` asks the app's own server for a browser token, unless told otherwise. */
export const DEFAULT_TOKEN_URL = '/siren/token';

/** A browser token is fetched again when fewer than this many seconds of its life are left. */
export const TRACK_REFRESH_MARGIN_SECONDS = 30;

/** Options for {@link createTracker} and for one {@link track} call. */
export interface TrackerOptions {
  /**
   * The app's own route that answers a browser token, where the server
   * mounts `siren.events.browserTokenHandler()`. Defaults to
   * {@link DEFAULT_TOKEN_URL}.
   */
  tokenUrl?: string;
  /** The fetch to call. Defaults to the global `fetch`. */
  fetch?: StorefrontFetch;
  /** Milliseconds since the epoch. Defaults to `Date.now`. For tests. */
  now?: () => number;
}

/**
 * Sends one custom event from the visitor's browser. Resolves to Siren's
 * JSON answer, or null when the app's server or Siren refused it.
 */
export type Track = (eventKey: string, data?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

interface HeldToken {
  token: string;
  url: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/**
 * Builds a `track` function with its own settings and its own kept tokens
 * (slice C13, apps-event-tokens).
 *
 * `track(eventKey, data)` asks `tokenUrl` for a browser token for the event,
 * posting `{"event": eventKey}` with the page's own cookies, and keeps it
 * per event until {@link TRACK_REFRESH_MARGIN_SECONDS} before it ends. Calls
 * for one event at the same moment share one request. It then posts `data`
 * as JSON to the token's `url` with `?access_token=` and the token, with no
 * cookies. When Siren answers 401 it drops the token, gets a new one and
 * sends once more.
 *
 * It resolves to Siren's JSON answer, or null when the app's server gave no
 * token or Siren refused the send. A network failure rejects, as
 * `recordVisit` does.
 */
export function createTracker(options: TrackerOptions = {}): Track {
  const tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
  const send: StorefrontFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const held = new Map<string, HeldToken>();
  const pending = new Map<string, Promise<HeldToken | null>>();

  const ask = async (eventKey: string): Promise<HeldToken | null> => {
    const response = await send(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ event: eventKey }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown; expiresIn?: unknown; url?: unknown };
    if (typeof body.token !== 'string' || typeof body.url !== 'string' || typeof body.expiresIn !== 'number') return null;
    const fresh = { token: body.token, url: body.url, expiresAt: now() + body.expiresIn * 1000 };
    held.set(eventKey, fresh);
    return fresh;
  };

  const tokenFor = (eventKey: string): Promise<HeldToken | null> => {
    const kept = held.get(eventKey);
    if (kept !== undefined && kept.expiresAt - now() >= TRACK_REFRESH_MARGIN_SECONDS * 1000) return Promise.resolve(kept);
    const waiting = pending.get(eventKey);
    if (waiting !== undefined) return waiting;
    const asked = ask(eventKey).finally(() => pending.delete(eventKey));
    pending.set(eventKey, asked);
    return asked;
  };

  const post = (kept: HeldToken, data: Record<string, unknown>): Promise<Response> => {
    const separator = kept.url.includes('?') ? '&' : '?';
    return send(`${kept.url}${separator}access_token=${encodeURIComponent(kept.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(data),
    });
  };

  return async (eventKey, data = {}) => {
    let kept = await tokenFor(eventKey);
    if (kept === null) return null;
    let response = await post(kept, data);
    if (response.status === 401) {
      if (held.get(eventKey) === kept) held.delete(eventKey);
      kept = await tokenFor(eventKey);
      if (kept === null) return null;
      response = await post(kept, data);
    }
    if (!response.ok) return null;
    const text = await response.text();
    if (text.trim() === '') return {};
    try {
      const body = JSON.parse(text) as unknown;
      return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
}

const trackers = new Map<string, Track>();

/**
 * Sends one custom event from the visitor's browser, through the app's own
 * server for the token, as
 * `await track('newsletter-signup', { collaboratorId: 12, list: 'weekly' })`.
 *
 * The server mounts `siren.events.browserTokenHandler()` at `/siren/token`,
 * or wherever `tokenUrl` points. See {@link createTracker} for what it does
 * and what it resolves to. Calls with the same `tokenUrl` share kept
 * tokens.
 */
export function track(
  eventKey: string,
  data?: Record<string, unknown>,
  options: { tokenUrl?: string } = {},
): Promise<Record<string, unknown> | null> {
  const tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
  let tracker = trackers.get(tokenUrl);
  if (tracker === undefined) {
    tracker = createTracker({ tokenUrl });
    trackers.set(tokenUrl, tracker);
  }
  return tracker(eventKey, data);
}
