/**
 * The OAuth scopes a connected site asks Siren Cloud for.
 *
 * Siren grants these through its consent screen, so a host that runs the
 * OAuth flow itself puts {@link ConnectorScope.CONNECTED_SITE} in the
 * authorization request's `scope` parameter. `connect:webhooks` and the two
 * record scopes are explicit only: no wildcard grants them, `connect:*` and
 * `*` included, so a site holds one only when it asked for it by name. A site
 * that connected before the record scopes existed holds neither, and Siren
 * answers its record calls with a 403 raised as `MissingScopeError`. The fix
 * is to reconnect.
 *
 * ```ts
 * const url = new URL('/oauth/authorize', cloudAppUrl);
 * url.searchParams.set('scope', ConnectorScope.CONNECTED_SITE);
 * ```
 */
export const ConnectorScope = {
  /** Every `connect:` operation a wildcard grants: read status, ingest events, run a migration. */
  ConnectAll: 'connect:*',
  /** Manage the webhook subscription that sends the site's own events back to it. Explicit only. */
  Webhooks: 'connect:webhooks',
  /** Read the organization's records through the record routes. Explicit only. */
  RecordsRead: 'connect:records:read',
  /** Change the records a person manages: collaborators, codes, enrollments, mappings, credit holds. Explicit only. */
  RecordsWrite: 'connect:records:write',
  /** The space-separated `scope` value a connected site asks for: all four, in this order. */
  CONNECTED_SITE: 'connect:* connect:webhooks connect:records:read connect:records:write',

  /** The scopes a connected site asks for, one per entry, in the order of `CONNECTED_SITE`. */
  forConnectedSite(): ConnectorScope[] {
    // Stub: slice 2 packet P6.
    return [];
  },
} as const;

/** One scope a connected site may hold. */
export type ConnectorScope = 'connect:*' | 'connect:webhooks' | 'connect:records:read' | 'connect:records:write';
