/**
 * The scopes an API key may be given (`apiKeys.create`).
 *
 * A key sends events with event scopes: `AllEvents` (`event:*`), or
 * {@link eventScope} for one event type. `FullAccess` (`*`) is still accepted
 * and grants what `AllEvents` grants.
 *
 * A key also reads the ledger and manages webhook subscriptions with the
 * ledger and webhook scopes:
 *
 * - `LedgerConversionsRead`, `LedgerTransactionsRead`, `LedgerObligationsRead`
 *   and `LedgerPayoutsRead` open `list()` on `conversions`, `transactions`,
 *   `obligations` and `payouts`, and Siren's read by id on each.
 * - `WebhookSubscriptionsRead` lists subscriptions, reads one, and reads the
 *   event catalog and a subscription's deliveries.
 * - `WebhookSubscriptionsManage` does all of that, and creates, changes and
 *   deletes subscriptions and sends a test delivery.
 *
 * Siren grants each of these six only by its exact name. `*`, `event:*`,
 * wildcards such as `ledger:*`, and older names such as `conversions:read`
 * grant none of them, and Siren refuses those older names on a new key with
 * a 400. No scope reaches API key management, which takes a signed-in
 * dashboard session.
 *
 * ```ts
 * await siren.apiKeys.create({
 *   label: 'Accounting export',
 *   scopes: [ApiKeyScope.LedgerConversionsRead, ApiKeyScope.LedgerPayoutsRead],
 * });
 * ```
 */
export const ApiKeyScope = {
  /** Every event type the key may send. */
  AllEvents: 'event:*',
  /** The full wildcard. Siren treats it as `event:*`, and it opens no ledger or webhook route. */
  FullAccess: '*',
  Sale: 'event:sale',
  Refund: 'event:refund',
  SiteVisited: 'event:site-visited',
  /** Lists and reads conversions (`GET /conversions`, `GET /conversions/{id}`). */
  LedgerConversionsRead: 'ledger:conversions:read',
  /** Lists and reads transactions (`GET /transactions`, `GET /transactions/{id}`). */
  LedgerTransactionsRead: 'ledger:transactions:read',
  /** Lists and reads obligations (`GET /obligations`, `GET /obligations/{id}`). */
  LedgerObligationsRead: 'ledger:obligations:read',
  /**
   * Lists and reads payouts (`GET /payouts`, `GET /payouts/{id}`). Payouts are
   * not kept by store, so a key bound to one store is refused here.
   */
  LedgerPayoutsRead: 'ledger:payouts:read',
  /**
   * Lists webhook subscriptions, reads one, and reads the event catalog and a
   * subscription's deliveries. A key bound to one store is refused here.
   */
  WebhookSubscriptionsRead: 'webhook-subscriptions:read',
  /**
   * Everything `WebhookSubscriptionsRead` opens, plus creating, changing and
   * deleting subscriptions and sending a test delivery
   * (`POST /webhooks/{id}/test`).
   */
  WebhookSubscriptionsManage: 'webhook-subscriptions:manage',
} as const;

/** Union of the named API key scope strings. */
export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

/** The four ledger read scopes. */
export const LEDGER_READ_SCOPES: readonly ApiKeyScope[] = [
  ApiKeyScope.LedgerConversionsRead,
  ApiKeyScope.LedgerTransactionsRead,
  ApiKeyScope.LedgerObligationsRead,
  ApiKeyScope.LedgerPayoutsRead,
];

/** The scope for one event type, such as `event:loyalty-points-earned`. */
export function eventScope(slug: string): `event:${string}` {
  if (typeof slug !== 'string' || slug === '') {
    throw new TypeError('An event scope needs a non-empty event slug.');
  }
  return `event:${slug}`;
}
