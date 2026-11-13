import { ConflictError, HoldConflictError, SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { PropertyQualifier } from '../property-qualifier';
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
import { deleteRecord, listRecords, readObject, recordId, writeRecord } from './record-requests';

const CURRENCY_MESSAGE = 'Send a currency code as letters, digits, underscores and hyphens, such as STORE_CREDIT.';
const ZERO_MESSAGE = 'A credit adjustment amount must not be zero.';
const ENTRIES_MESSAGE = 'Send at least one of: collaboratorId, idempotencyKey.';
const HOLDS_MESSAGE = 'Send at least one of: collaboratorId, reference, idempotencyKey.';

/** The message a malformed hold reference throws, naming the parameter it came in. */
function referenceMessage(field: 'reference' | 'excludeReference'): string {
  return `Send ${field} as hold:{platform}:{token}. Build it with CreditsResource.holdReference().`;
}

/** Returns `value` when it is a currency code. Otherwise throws `SirenError` before sending. */
function currencyCode(value: unknown): string {
  if (!PropertyQualifier.isValidName(value)) throw new SirenError(CURRENCY_MESSAGE);
  return value;
}

/** Whether `value` is a positive safe integer, so it names one record. */
function isRecordId(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Whether `value` is a string with something in it besides white space. */
function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Returns `name` when it passes `PropertyQualifier.assertName` and is at most
 * `max` characters long. Otherwise throws `SirenError` naming `field`.
 */
function holdName(name: unknown, field: string, max: number): string {
  const checked = PropertyQualifier.assertName(name, field);
  if (checked.length > max) throw new SirenError(`Send ${field} of at most ${max} characters.`);
  return checked;
}

/** Whether `name` is a plain name of at most `max` characters, as a hold's platform id and token must be. */
function isHoldName(name: unknown, max: number): boolean {
  return PropertyQualifier.isValidName(name) && name.length <= max;
}

/** Whether `value` is `hold:{platform}:{token}` with two plain names within their limits, as `holdReference` builds it. */
function isReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return (
    parts.length === 3 &&
    parts[0] === 'hold' &&
    isHoldName(parts[1], CreditsResource.HOLD_PLATFORM_MAX_LENGTH) &&
    isHoldName(parts[2], CreditsResource.HOLD_TOKEN_MAX_LENGTH)
  );
}

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
 * Reads retry on a network error, 429 or 5xx inside the client's
 * `maxRetries`, so a caller that runs them from its own durable queue builds
 * the client with `maxRetries: 0`. {@link adjust}, {@link placeHold} and
 * {@link releaseHold} are sent once, whatever the client's `maxRetries`,
 * apart from the one resend after a 401 that every request gets. A write's
 * answer is lost when it throws `ConnectionError` or a 5xx `ApiError`, since
 * Siren may have written first. Each write's doc says how to find out before sending it again.
 * Every id must be a positive whole number, and every currency, wherever
 * a method takes one, a code of letters, digits, underscores and hyphens,
 * or the method throws `SirenError` with exactly `Send a currency code as
 * letters, digits, underscores and hyphens, such as STORE_CREDIT.` Every
 * check here throws `SirenError` before anything is sent.
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
  // A plain class, not a RecordsResource: its routes are not one
  // collection, so each read names its own filters below.
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
   * own `description`, with no comma, since {@link entries} reads a comma as
   * "any of" and refuses one. After a lost answer, it looks for that entry
   * with {@link entries}, `{ collaboratorId, sourceType: 'adjustment',
   * description }`, before sending again. Without a unique `description`, a lost answer
   * cannot be checked, so set the adjustment aside instead of resending it.
   *
   * Throws `SirenError` before sending when `collaboratorId` is not a
   * positive whole number, `currency` is not a currency code, `amount` is
   * not a safe whole number or is zero (exactly `A credit adjustment amount
   * must not be zero.`), or `description` is given and is not a string.
   * A connected site's token is refused with a 403.
   */
  async adjust(collaboratorId: number, currency: string, amount: number, description?: string): Promise<CreditAdjustment> {
    const body: Record<string, unknown> = {
      collaboratorId: recordId(collaboratorId, 'credits.adjust', 'collaboratorId'),
      currency: currencyCode(currency),
      amount,
    };
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
      throw new SirenError(`credits.adjust needs a whole number amount, and got ${String(amount)}.`);
    }
    if (amount === 0) throw new SirenError(ZERO_MESSAGE);
    if (description !== undefined) {
      if (typeof description !== 'string') throw new SirenError('credits.adjust needs a description that is a string.');
      body.description = description;
    }
    return writeRecord<CreditAdjustment>(this.http, 'POST', '/credits/adjust', body);
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
   * answer. The read goes through `readObject` with a `check`, as
   * `transactions.details` does. A connected site's token cannot read this
   * field (403 `field_not_allowed`), so a checkout uses
   * {@link checkoutBalances}.
   */
  async balances(collaboratorId: number): Promise<CreditBalance[]> {
    const path = `/collaborators/${recordId(collaboratorId, 'credits.balances', 'collaboratorId')}`;
    const record = await readObject<{ creditBalances: CreditBalance[] }>(this.http, path, { fields: 'id,creditBalances' }, (body) => {
      const entries = body.creditBalances;
      return !Array.isArray(entries) || entries.some((entry) => typeof entry !== 'object' || entry === null || Array.isArray(entry))
        ? `Siren answered GET ${path} with no creditBalances list of objects.`
        : undefined;
    });
    return record.creditBalances;
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
   * `UnexpectedResponseError`. Throws `SirenError` before sending when
   * `collaboratorId` is not a positive whole number, a missing one
   * included, since Siren answers 400 for a read that names no collaborator.
   */
  async checkoutBalances(collaboratorId: number, currency?: string, excludeReference?: string): Promise<CheckoutBalance[]> {
    const query = {
      collaboratorId: recordId(collaboratorId, 'credits.checkoutBalances', 'collaboratorId'),
      currency: currency === undefined ? undefined : currencyCode(currency),
      excludeReference,
    };
    if (excludeReference !== undefined && !isReference(excludeReference)) {
      throw new SirenError(referenceMessage('excludeReference'));
    }
    return listRecords<CheckoutBalance>(
      this.http,
      '/credit-balances',
      query,
      CreditsResource.BALANCE_FILTERS,
      CreditsResource.ID_FILTERS,
    );
  }

  /**
   * One currency's checkout row: {@link checkoutBalances} with `currency`
   * sent as the filter, then the first row whose `currency` equals it, or
   * `null` when Siren answers a list with no such row. A body that is not a
   * list throws `UnexpectedResponseError`, as {@link checkoutBalances} does,
   * never `null`.
   */
  async checkoutBalance(collaboratorId: number, currency: string, excludeReference?: string): Promise<CheckoutBalance | null> {
    const code = currencyCode(currency);
    const rows = await this.checkoutBalances(collaboratorId, code, excludeReference);
    return rows.find((row) => row.currency === code) ?? null;
  }

  /**
   * Lists ledger entries with `GET /credit-entries`. Each entry holds `id`,
   * `collaboratorId`, `currency`, `amount` (signed), `sourceType`,
   * `sourceId`, `description`, `idempotencyKey` and `createdDate`.
   *
   * A query must name `collaboratorId` (a positive whole number) or
   * `idempotencyKey` (a string that is not blank), so it never lists a whole
   * organization's ledger. Otherwise it throws `SirenError` before sending,
   * with exactly `Send at least one of: collaboratorId, idempotencyKey.`
   * That check comes first, and a `collaboratorId` that is not a positive
   * whole number, or a blank `idempotencyKey`, does not satisfy it. A
   * `collaboratorId` given beside a good `idempotencyKey` must still be a
   * positive whole number, or `listRecords` refuses it, naming the key.
   * Other filters, each an exact match: `currency`, `sourceType`, `sourceId`
   * and `description`. Sort with `orderBy` (`id`, `dateCreated`, `amount`)
   * and `order`. Sent through `listRecords` with {@link ENTRY_FILTERS} and
   * {@link ID_FILTERS}, so any other key throws `SirenError`. It reads each
   * own key of `params` once and no inherited key, so the check and the
   * query see the same values.
   */
  async entries(params: CreditEntryListParams): Promise<SirenList<CreditEntry>> {
    // Each own key read once, so the scope check and the query see the same
    // values and no inherited key reaches either.
    params = { ...params };
    if (!isRecordId(params.collaboratorId) && !filled(params.idempotencyKey)) throw new SirenError(ENTRIES_MESSAGE);
    if (params.currency !== undefined) currencyCode(params.currency);
    return listRecords<CreditEntry>(
      this.http,
      '/credit-entries',
      params,
      CreditsResource.ENTRY_FILTERS,
      CreditsResource.ID_FILTERS,
    );
  }

  /**
   * Lists credit holds with `GET /credit-holds`. Each hold carries `id`,
   * `collaboratorId`, `currency`, `amount`, `status`, `reference`,
   * `idempotencyKey`, `expiresAt` and `createdDate`.
   *
   * A query must name `collaboratorId` (a positive whole number),
   * `reference` or `idempotencyKey` (strings that are not blank), or it
   * throws `SirenError` before sending, with exactly `Send at least one of:
   * collaboratorId, reference, idempotencyKey.` That check comes first, so a
   * blank `reference` does not satisfy it, and a `collaboratorId` given
   * beside another key must still be a positive whole number. Send
   * `reference` as {@link holdReference} builds it, or it throws
   * `SirenError` with exactly `Send reference as hold:{platform}:{token}.
   * Build it with CreditsResource.holdReference().` Other filters: `currency` and `status`
   * (`CreditHoldStatus`). Sort with `orderBy` (`id`, `dateCreated`,
   * `expiresAt`). A connected site reads only the holds its own checkouts
   * placed, and their references come back as Siren stores them, with the
   * site's Property (`hold:woocommerce@property:5:{token}`). Sent through
   * `listRecords` with {@link HOLD_FILTERS} and {@link ID_FILTERS}. It reads
   * each own key of `params` once and no inherited key, so the check and the
   * query see the same values.
   *
   * An API key cannot filter by the reference Siren stores for a site's
   * hold, with the site's Property in it, since this method takes only the
   * plain form {@link holdReference} builds. Filter such a hold by
   * `collaboratorId` and `status` and match its `reference` in the answer.
   */
  async holds(params: CreditHoldListParams): Promise<SirenList<CreditHold>> {
    // Each own key read once, so the scope check and the query see the same
    // values and no inherited key reaches either.
    params = { ...params };
    if (!isRecordId(params.collaboratorId) && !filled(params.reference) && !filled(params.idempotencyKey)) {
      throw new SirenError(HOLDS_MESSAGE);
    }
    if (params.currency !== undefined) currencyCode(params.currency);
    if (params.reference !== undefined && !isReference(params.reference)) throw new SirenError(referenceMessage('reference'));
    return listRecords<CreditHold>(this.http, '/credit-holds', params, CreditsResource.HOLD_FILTERS, CreditsResource.ID_FILTERS);
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
   * again, or find the hold with {@link holds} by {@link holdReference}.
   * The hold's `amount` may be lower than asked, because Siren caps it at
   * the credit available outside this session's own hold.
   *
   * Throws `SirenError` before sending when `collaboratorId` is not a
   * positive whole number, `currency` is not a currency code, `amount` is
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
  async placeHold(
    collaboratorId: number,
    currency: string,
    amount: number,
    token: string,
    platformId: string,
    ttl?: number,
  ): Promise<CreditHold> {
    const body: Record<string, unknown> = {
      collaboratorId: recordId(collaboratorId, 'credits.placeHold', 'collaboratorId'),
      currency: currencyCode(currency),
      amount,
      token: holdName(token, 'token', CreditsResource.HOLD_TOKEN_MAX_LENGTH),
      platformId: holdName(platformId, 'platformId', CreditsResource.HOLD_PLATFORM_MAX_LENGTH),
    };
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
      throw new SirenError(`credits.placeHold needs a whole number amount of 1 or more, and got ${String(amount)}.`);
    }
    if (ttl !== undefined) {
      if (
        typeof ttl !== 'number' ||
        !Number.isSafeInteger(ttl) ||
        ttl < CreditsResource.HOLD_MIN_TTL ||
        ttl > CreditsResource.HOLD_MAX_TTL
      ) {
        throw new SirenError(
          `credits.placeHold needs a ttl of ${CreditsResource.HOLD_MIN_TTL} to ${CreditsResource.HOLD_MAX_TTL} whole seconds, and got ${String(ttl)}.`,
        );
      }
      body.ttl = ttl;
    }
    try {
      return await writeRecord<CreditHold>(this.http, 'POST', '/credit-holds', body);
    } catch (error) {
      if (error instanceof ConflictError) throw HoldConflictError.fromConflict(error);
      throw error;
    }
  }

  /**
   * Releases a hold early with `DELETE /credit-holds/{id}`, sent once, so the
   * credit it reserved is free again, and answers the hold as Siren now
   * stores it. Call it only when the shopper drops the credit, or it no
   * longer applies to a cart that never became an order. Never release the
   * hold of a checkout that became an order. Settlement spends that hold, so
   * a hold released first lets the shopper spend the same credit twice.
   *
   * Releasing again is safe: a hold that already ended comes back unchanged
   * with no error, so a caller whose release lost its answer sends it again
   * itself. Siren answers 404, raised as `NotFoundError`, for a hold this
   * site's checkouts did not place. Throws `SirenError` before sending for an
   * id that is not a positive whole number, and `UnexpectedResponseError`
   * when a 2xx carries no hold object.
   */
  async releaseHold(holdId: number): Promise<CreditHold> {
    const path = `/credit-holds/${recordId(holdId, 'credits.releaseHold')}`;
    const hold = await deleteRecord<CreditHold>(this.http, path);
    if (hold === null) throw new UnexpectedResponseError(`Siren answered DELETE ${path} with no hold.`, { statusCode: 204 });
    return hold;
  }

  /**
   * The reference a checkout session's holds carry, `hold:{platform}:{token}`,
   * as a site sends it. Use it as {@link holds}'s `reference` filter and as
   * {@link checkoutBalances}'s `excludeReference`. Throws `SirenError` when
   * either part fails `PropertyQualifier.assertName` or is longer than its
   * limit.
   */
  static holdReference(platformId: string, token: string): string {
    const platform = holdName(platformId, 'platformId', CreditsResource.HOLD_PLATFORM_MAX_LENGTH);
    const checkout = holdName(token, 'token', CreditsResource.HOLD_TOKEN_MAX_LENGTH);
    return `hold:${platform}:${checkout}`;
  }
}
