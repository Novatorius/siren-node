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
 * {@link ApiKeyRecordScope} names every record scope Siren issues, these
 * six included.
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

/**
 * Every scope that lets an API key read or manage an organization's
 * records, one for each constant in Siren's `ApiKeyRecordScopes`, in the
 * order the dashboard offers them. Each name is the PHP constant's name in
 * Pascal case, so `ENGAGEMENTS_READ` is `EngagementsRead`.
 *
 * - The `ledger:` scopes only read what Siren recorded. No scope approves a
 *   reward, moves an obligation along or sends a payout.
 * - `WebhooksRead` and `WebhooksManage` read and manage webhook
 *   subscriptions. They are the same strings as
 *   `ApiKeyScope.WebhookSubscriptionsRead` and `WebhookSubscriptionsManage`.
 * - The `records:` scopes read and manage the records a merchant sets up.
 *   A manage scope reads everything its read scope reads.
 *
 * Siren grants each only by its exact name. `*` and wildcards such as
 * `records:*` grant none of them. A test reads Siren's
 * ApiKeyRecordScopes.php and fails when this list differs from it.
 *
 * ```ts
 * await siren.apiKeys.create({
 *   label: 'Payout app',
 *   scopes: [ApiKeyRecordScope.PayoutsRead, ApiKeyRecordScope.FulfillmentsRead],
 * });
 * ```
 */
export const ApiKeyRecordScope = Object.freeze({
  /** `siren.engagements` reads. A store's key reads its own store. */
  EngagementsRead: 'ledger:engagements:read',
  /** `siren.opportunities` reads. Organization keys only. */
  OpportunitiesRead: 'ledger:opportunities:read',
  /** `conversions.list()` and `retrieve()`. A store's key reads its own store. */
  ConversionsRead: 'ledger:conversions:read',
  /** `transactions.list()` and `retrieve()`. A store's key reads its own store. */
  TransactionsRead: 'ledger:transactions:read',
  /** `obligations.list()`. A store's key reads its own store. */
  ObligationsRead: 'ledger:obligations:read',
  /** `fulfillments.list()` and `retrieve()`. Organization keys only. */
  FulfillmentsRead: 'ledger:fulfillments:read',
  /** `payouts.list()` and `retrieve()`. Organization keys only. */
  PayoutsRead: 'ledger:payouts:read',
  /** Lists and reads webhook subscriptions, the event catalog and deliveries. Organization keys only. */
  WebhooksRead: 'webhook-subscriptions:read',
  /** Everything `WebhooksRead` opens, plus create, update, delete and test. Organization keys only. */
  WebhooksManage: 'webhook-subscriptions:manage',
  ProductsRead: 'records:products:read',
  ProductsManage: 'records:products:manage',
  CouponsRead: 'records:coupons:read',
  CouponsManage: 'records:coupons:manage',
  CollaboratorsRead: 'records:collaborators:read',
  CollaboratorsManage: 'records:collaborators:manage',
  CollaboratorGroupsRead: 'records:collaborator-groups:read',
  CollaboratorGroupsManage: 'records:collaborator-groups:manage',
  ProgramsRead: 'records:programs:read',
  ProgramsManage: 'records:programs:manage',
  ProgramGroupsRead: 'records:program-groups:read',
  ProgramGroupsManage: 'records:program-groups:manage',
  DistributorsRead: 'records:distributors:read',
  DistributorsManage: 'records:distributors:manage',
  ApplicationFormsRead: 'records:application-forms:read',
  ApplicationFormsManage: 'records:application-forms:manage',
  ApplicationsRead: 'records:applications:read',
  ApplicationsManage: 'records:applications:manage',
  NotificationRulesRead: 'records:notification-rules:read',
  NotificationRulesManage: 'records:notification-rules:manage',
  PropertiesRead: 'records:properties:read',
} as const);

/** Union of the {@link ApiKeyRecordScope} strings. */
export type ApiKeyRecordScope = (typeof ApiKeyRecordScope)[keyof typeof ApiKeyRecordScope];

/** Every {@link ApiKeyRecordScope}, in the order Siren lists them. */
export const API_KEY_RECORD_SCOPES: readonly ApiKeyRecordScope[] = Object.freeze(Object.values(ApiKeyRecordScope));

/** The scope for one event type, such as `event:loyalty-points-earned`. */
export function eventScope(slug: string): `event:${string}` {
  if (typeof slug !== 'string' || slug === '') {
    throw new TypeError('An event scope needs a non-empty event slug.');
  }
  return `event:${slug}`;
}
