import { ConnectorScope } from '../auth/connector-scope';

/**
 * The six operation scopes of Siren Cloud's `connect` resource, one per kind
 * of thing a connected site does. Siren's `ScopeService::RESOURCES` at
 * b6f7140d0. Each connected-site method names the one its route requires.
 *
 * The `connect:*` wildcard grants `Read`, `Ingest` and `Migrate`. The other
 * three are explicit only: no wildcard grants them, so a site holds one only
 * when it asked for it by name. `ConnectorScope.CONNECTED_SITE` asks for the
 * wildcard and those three, so a site that sends it holds all six.
 *
 * `ConnectorScope` names what a site asks for at the consent screen.
 * `ConnectScope` names what each route requires. The three explicit scopes
 * are the same strings in both, taken from `ConnectorScope`.
 */
export const ConnectScope = {
  /** Read the connection's state and plan, report site state, disconnect. */
  Read: 'connect:read',
  /** Send events to `POST /event/{slug}`. */
  Ingest: 'connect:ingest',
  /** Migrate a site's data into Cloud, and read its migration window. */
  Migrate: 'connect:migrate',
  /** Manage the webhook subscription that sends the site its own events. Explicit only. */
  Webhooks: ConnectorScope.Webhooks,
  /** Read the organization's records and the customer email key. Explicit only. */
  RecordsRead: ConnectorScope.RecordsRead,
  /** Change the records a person manages, and report integrations and products. Explicit only. */
  RecordsWrite: ConnectorScope.RecordsWrite,
} as const;

/** Union of the {@link ConnectScope} strings. */
export type ConnectScope = (typeof ConnectScope)[keyof typeof ConnectScope];
