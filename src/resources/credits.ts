import type { HttpTransport } from '../http';
import type {
  CheckoutBalance,
  CreditAdjustment,
  CreditBalance,
  CreditEntry,
  CreditEntryListParams,
  CreditHold,
  CreditHoldListParams,
} from '../record-types';
import type { SirenList } from '../types';

/**
 * Store credit: a collaborator's balances in the organization's internal
 * custom currencies, the ledger behind them, and the holds checkouts place
 * on them. Amounts are whole minor units.
 *
 * A connected site's token may read {@link entries}, {@link checkoutBalances}
 * and {@link holds} with `connect:records:read`, and place and release holds
 * with `connect:records:write`. Only Siren writes the ledger, through its
 * engine and the dashboard's {@link adjust}. These routes need no plan.
 *
 * Reads retry. {@link adjust}, {@link placeHold} and {@link releaseHold} are
 * sent once, whatever the client's `maxRetries`, apart from the one resend
 * after a 401 that every request gets. A write's answer is lost when it
 * throws `ConnectionError` or a 5xx `ApiError`, since Siren may have written
 * first. Each write's doc says how to find out before sending it again.
 * Every id must be a positive whole number, and every check here throws
 * `SirenError` before anything is sent.
 *
 * Siren sets `idempotencyKey` itself: a hold carries
 * `place:{collaborator}:{currency}:{token}`, and the ledger entries Siren
 * writes when it settles or reverses a redemption carry a `redeem:` key. A
 * caller cannot send one, and {@link adjust} writes its entry with none.
 *
 * A hold ends when its `ttl` runs out (Siren removes expired holds every
 * five minutes, and an expired hold reserves nothing), when the same
 * checkout places again and replaces it, when the site releases it early
 * with {@link releaseHold}, or when Siren settles it from the order's
 * redemption. A 429 from {@link placeHold} is the request rate limit,
 * raised as `RateLimitError`.
 */
export class CreditsResource {
  /** The shortest hold, in seconds. */
  static readonly HOLD_MIN_TTL = 60;
  /** The longest hold, in seconds. */
  static readonly HOLD_MAX_TTL = 3600;
  /** The hold Siren places when no `ttl` is sent, in seconds. */
  static readonly HOLD_DEFAULT_TTL = 1800;
  /**
   * The longest platform id Siren accepts on a hold. The SDK checks only
   * this ceiling. Siren adds the site's Property (`@property:5`) before it
   * checks the length, and the SDK does not know the Property, so for a
   * site's token Siren's 400 is the final word on a platform id close to
   * the limit.
   */
  static readonly HOLD_PLATFORM_MAX_LENGTH = 60;
  /** The longest checkout token Siren accepts on a hold. */
  static readonly HOLD_TOKEN_MAX_LENGTH = 120;

  /** The filters {@link entries} sends. It refuses any other key. */
  static readonly ENTRY_FILTERS = ['collaboratorId', 'currency', 'sourceType', 'sourceId', 'description', 'idempotencyKey'] as const;
  /** The filters {@link holds} sends. It refuses any other key. */
  static readonly HOLD_FILTERS = ['collaboratorId', 'currency', 'status', 'reference', 'idempotencyKey'] as const;
  /** The filters {@link checkoutBalances} sends. */
  static readonly BALANCE_FILTERS = ['collaboratorId', 'currency', 'excludeReference'] as const;
  /**
   * The id filters all three lists check: {@link entries}, {@link holds}
   * and {@link checkoutBalances}. `collaboratorId` takes one
   * positive whole number, never a list: `GET /credit-balances` reads one
   * (GetCreditBalances.php line 55), and a ledger or hold query names one
   * collaborator.
   */
  static readonly ID_FILTERS = { one: ['collaboratorId'] } as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * Adds to or takes from a collaborator's balance in one internal currency
   * with `POST /credits/adjust`, body `{ collaboratorId, currency, amount }`
   * plus `description` when one is given, sent once: a second send would
   * apply the adjustment twice, and Siren takes no idempotency key for it.
   * Answers `{ success, entry }`, the ledger entry with its signed amount.
   * Siren writes the entry with `sourceType` `adjustment`.
   *
   * A caller whose queue may send it again must give each adjustment its
   * own `description`. After a lost answer, it looks for that entry with
   * {@link entries}, `{ collaboratorId, sourceType: 'adjustment', description }`,
   * before sending again. Without a unique `description`, a lost answer
   * cannot be checked, so set the adjustment aside instead of resending it.
   *
   * Throws `SirenError` before sending when `collaboratorId` is not a
   * positive whole number, `currency` is not a non-empty string, `amount` is
   * not a safe whole number or is zero (exactly `A credit adjustment amount
   * must not be zero.`), or `description` is given and is not a string.
   * A connected site's token is refused with a 403.
   */
  adjust(collaboratorId: number, currency: string, amount: number, description?: string): Promise<CreditAdjustment> {
    // Stub: slice 4 packet P5
    void collaboratorId;
    void currency;
    void amount;
    void description;
    void this.http;
    return Promise.resolve({});
  }

  /**
   * A collaborator's credit balances, read from their `creditBalances` field
   * with `GET /collaborators/{id}?fields=id,creditBalances`, one entry per
   * internal currency: `currency`, `balance` (gross), `onHold`,
   * `available`, `name`, `symbol`, `symbolPosition` and `exchangeRate`, and
   * on Siren Cloud with store bindings `stores` and `redeemAt`.
   *
   * Siren always sends a field it was asked for, so a record with no
   * `creditBalances` list, or with an entry that is not an object, throws
   * `UnexpectedResponseError` with the status Siren sent, never an empty
   * answer. The read goes through `readObject` with a `check`, as slice 3's
   * field reads do. A connected site's
   * token cannot read this field (403 `field_not_allowed`), so a checkout
   * uses {@link checkoutBalances}.
   */
  balances(collaboratorId: number): Promise<CreditBalance[]> {
    // Stub: slice 4 packet P5
    void collaboratorId;
    return Promise.resolve([]);
  }

  /**
   * A collaborator's store credit as a checkout reads it, with
   * `GET /credit-balances?collaboratorId=`, one row per internal currency
   * spendable at the caller's store: `{ collaboratorId, currency, balance,
   * reserved, available }`. `balance` is the ledger sum, `reserved` the live
   * holds and `available` the balance less reserved, never below zero.
   *
   * `currency` narrows to one currency. `excludeReference` leaves one
   * checkout's own hold out of `reserved`, so a checkout does not count its
   * hold against itself. Send it as {@link holdReference} builds it: a
   * reference that is not `hold:{platform}:{token}` with two plain names
   * throws `SirenError` before sending, with exactly `Send excludeReference
   * as hold:{platform}:{token}. Build it with CreditsResource.holdReference().`
   *
   * Siren answers `{ items }` with no paging. Sent through `listRecords`
   * with {@link BALANCE_FILTERS} and {@link ID_FILTERS}, so a 2xx that is
   * not a list, or a row that is not an object, throws
   * `UnexpectedResponseError`.
   */
  checkoutBalances(collaboratorId: number, currency?: string, excludeReference?: string): Promise<CheckoutBalance[]> {
    // Stub: slice 4 packet P5
    void collaboratorId;
    void currency;
    void excludeReference;
    return Promise.resolve([]);
  }

  /**
   * One currency's checkout row: {@link checkoutBalances} with `currency`
   * sent as the filter, then the first row whose `currency` equals it, or
   * `null` when Siren answers a list with no such row. A body that is not a
   * list throws `UnexpectedResponseError`, as {@link checkoutBalances} does,
   * never `null`.
   */
  checkoutBalance(collaboratorId: number, currency: string, excludeReference?: string): Promise<CheckoutBalance | null> {
    // Stub: slice 4 packet P5
    void collaboratorId;
    void currency;
    void excludeReference;
    return Promise.resolve(null);
  }

  /**
   * Lists ledger entries with `GET /credit-entries`. Each entry holds `id`,
   * `collaboratorId`, `currency`, `amount` (signed), `sourceType`,
   * `sourceId`, `description`, `idempotencyKey` and `createdDate`.
   *
   * A query must name `collaboratorId` (a positive whole number) or
   * `idempotencyKey` (a string that is not blank), so it never lists a whole
   * organization's ledger. Otherwise `SirenError` is thrown before sending,
   * with exactly `Send at least one of: collaboratorId, idempotencyKey.`
   * That check comes first, and a `collaboratorId` that is not a positive
   * whole number, or a blank `idempotencyKey`, does not satisfy it. A
   * `collaboratorId` given beside a good `idempotencyKey` must still be a
   * positive whole number, or `listRecords` refuses it, naming the key.
   * Other filters, each an exact match: `currency`, `sourceType`, `sourceId`
   * and `description`. Sort with `orderBy` (`id`, `dateCreated`, `amount`)
   * and `order`. Sent through `listRecords` with {@link ENTRY_FILTERS} and
   * {@link ID_FILTERS}, so any other key throws `SirenError`.
   */
  entries(params: CreditEntryListParams): Promise<SirenList<CreditEntry>> {
    // Stub: slice 4 packet P5
    void params;
    return Promise.resolve([] as unknown as SirenList<CreditEntry>);
  }

  /**
   * Lists credit holds with `GET /credit-holds`. Each hold holds `id`,
   * `collaboratorId`, `currency`, `amount`, `status`, `reference`,
   * `idempotencyKey`, `expiresAt` and `createdDate`.
   *
   * A query must name `collaboratorId` (a positive whole number),
   * `reference` or `idempotencyKey` (strings that are not blank), or
   * `SirenError` is thrown before sending, with exactly `Send at least one
   * of: collaboratorId, reference, idempotencyKey.` That check comes first,
   * so a blank `reference` does not satisfy it, and a `collaboratorId`
   * given beside another key must still be a positive whole number. Send
   * `reference` as
   * {@link holdReference} builds it, or `SirenError` is thrown with exactly
   * `Send reference as hold:{platform}:{token}. Build it with
   * CreditsResource.holdReference().` Other filters: `currency` and `status`
   * (`CreditHoldStatus`). Sort with `orderBy` (`id`, `dateCreated`,
   * `expiresAt`). A connected site reads only the holds its own checkouts
   * placed, and their references come back as Siren stores them, with the
   * site's Property (`hold:woocommerce@property:5:{token}`). Sent through
   * `listRecords` with {@link HOLD_FILTERS} and {@link ID_FILTERS}.
   */
  holds(params: CreditHoldListParams): Promise<SirenList<CreditHold>> {
    // Stub: slice 4 packet P5
    void params;
    return Promise.resolve([] as unknown as SirenList<CreditHold>);
  }

  /**
   * Reserves a collaborator's store credit for a checkout with
   * `POST /credit-holds`, body `{ collaboratorId, currency, amount, token,
   * platformId }` plus `ttl` when one is given, sent once, so two carts
   * cannot spend the same credit. Answers the hold, status 201.
   *
   * `token` names the checkout session and `platformId` the commerce
   * platform, such as `woocommerce`. Send the plain platform: Siren adds the
   * site's Property. Placing again for the same token and currency replaces
   * that session's hold, so after a lost answer the caller may send it
   * again, or find the hold with {@link holds} by {@link holdReference}. The hold's `amount` may be lower than asked, because
   * Siren caps it at the credit available outside this session's own hold.
   *
   * Throws `SirenError` before sending when `collaboratorId` is not a
   * positive whole number, `currency` is not a non-empty string, `amount` is
   * not a safe whole number of 1 or more, `token` or `platformId` fails
   * `PropertyQualifier.assertName` or is longer than
   * {@link HOLD_TOKEN_MAX_LENGTH} or {@link HOLD_PLATFORM_MAX_LENGTH}, or
   * `ttl` is given and is not a whole number from {@link HOLD_MIN_TTL} to
   * {@link HOLD_MAX_TTL}.
   *
   * Every 409 Siren answers becomes `HoldConflictError.fromConflict`, whose
   * `reason` is `no_credit` (`hold_no_credit`), `token_in_use`
   * (`hold_token_in_use`, another site's checkout used the token) or `null`
   * (such as `hold_currency_not_at_store`). Every other error passes through
   * unchanged.
   */
  placeHold(
    collaboratorId: number,
    currency: string,
    amount: number,
    token: string,
    platformId: string,
    ttl?: number,
  ): Promise<CreditHold> {
    // Stub: slice 4 packet P5
    void collaboratorId;
    void currency;
    void amount;
    void token;
    void platformId;
    void ttl;
    return Promise.resolve({ id: 1 });
  }

  /**
   * Releases a hold early with `DELETE /credit-holds/{id}`, sent once, so the
   * credit it reserved is free again, and answers the hold as Siren now
   * stores it. Call it only when the shopper drops the credit, or it no
   * longer applies to a cart that never became an order. Never release the
   * hold of a checkout that became an order: settlement spends that hold,
   * and released first, the same credit could be spent twice.
   *
   * Releasing again is safe: a hold that already ended comes back unchanged
   * with no error, so a caller whose release lost its answer sends it again
   * itself. Siren answers 404, raised as `NotFoundError`, for a hold this
   * site's checkouts did not place. Throws `SirenError` before sending for an
   * id that is not a positive whole number, and `UnexpectedResponseError`
   * when a 2xx carries no hold object.
   */
  releaseHold(holdId: number): Promise<CreditHold> {
    // Stub: slice 4 packet P5
    void holdId;
    return Promise.resolve({ id: 1 });
  }

  /**
   * The reference a checkout session's holds carry, `hold:{platform}:{token}`,
   * as a site sends it. Use it as {@link holds}'s `reference` filter and as
   * {@link checkoutBalances}'s `excludeReference`. Throws `SirenError` when
   * either part fails `PropertyQualifier.assertName` or is longer than its
   * limit.
   */
  static holdReference(platformId: string, token: string): string {
    // Stub: slice 4 packet P5
    void platformId;
    void token;
    return '';
  }
}
