import { SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { PropertyQualifier } from '../property-qualifier';
import type {
  CreateCustomCurrencyParams,
  CustomCurrency,
  CustomCurrencyListParams,
  DeletedCustomCurrency,
  RecordListParams,
  UpdateCustomCurrencyParams,
} from '../record-types';
import type { SirenList } from '../types';
import { deleteRecord, listRecords, writeRecord } from './record-requests';
import { pickFields } from './create-fields';
import { RecordsResource } from './records';

/** The one message every refused currency code throws. */
const CODE_MESSAGE = 'Send a currency code as letters, digits, underscores and hyphens, such as STORE_CREDIT.';

/** Returns `value` when Siren's route reads it as one code. Otherwise throws `SirenError` before sending. */
function currencyCode(value: unknown): string {
  if (!PropertyQualifier.isValidName(value)) throw new SirenError(CODE_MESSAGE);
  return value;
}

/**
 * Custom currencies (`/currencies/custom`): points, store credit and other
 * units an organization defines beside real money. Records are keyed by
 * their `code`, not a numeric id.
 *
 * Every method that takes a code throws `SirenError` before sending when it
 * is not a non-empty string of letters, digits, underscores and hyphens
 * (`PropertyQualifier.NAME_PATTERN`, the characters Siren's route reads),
 * with exactly `Send a currency code as letters, digits, underscores and
 * hyphens, such as STORE_CREDIT.` The code is sent as given, in its case.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * Every write is sent once, apart from the one resend after a 401 that
 * every request gets.
 *
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 *
 * Writes need the Essentials plan: without it Siren answers 403
 * `plan_required`, raised as `PermissionError`. A connected site's token
 * may read with `connect:records:read` and cannot write.
 */
export class CustomCurrenciesResource<T = CustomCurrency> extends RecordsResource<T> {
  /** The filters `GET /currencies/custom` reads. {@link list} refuses any other key, `propertyId` included. No filter takes an id, so there is no `ID_FILTERS`. */
  static readonly LIST_FILTERS = ['type', 'code'] as const;

  /**
   * The fields {@link create} sends: the eight Siren's create route reads
   * (`CreateCustomCurrency.php`). The PHP SDK documents six of them, and
   * `scale` and `propertyIds` are the two it leaves out, which Siren Cloud
   * reads (it requires `propertyIds`). `create` refuses any other key before
   * sending.
   */
  static readonly CREATE_FIELDS = [
    'code',
    'name',
    'symbol',
    'symbolPosition',
    'type',
    'exchangeRate',
    'scale',
    'propertyIds',
  ] as const;

  constructor(http: HttpTransport) {
    super(http, '/currencies/custom');
  }

  /**
   * Lists custom currencies with `GET /currencies/custom`. Filters: `type`
   * (`CustomCurrencyType`) and `code`. Sort with `orderBy` (`code`, `name`,
   * `symbol`, `symbolPosition`, `type`, `exchangeRate`, `dateCreated`,
   * `dateModified`) and `order`. Sends through `listRecords` with
   * {@link LIST_FILTERS}: any other key and an empty filter list throw
   * `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  override async list(params: CustomCurrencyListParams = {}): Promise<SirenList<T>> {
    return listRecords<T>(this.http, this.path, params, CustomCurrenciesResource.LIST_FILTERS);
  }

  /**
   * Reads one custom currency by its code, or `null` when there is none.
   * Siren has no read route by code, so this lists with `code` and
   * `number: 1`, which a connected site's token may read, and answers the
   * first row. `params.fields` picks the fields. The code and `number`
   * always win over anything else in `params`.
   */
  async retrieve(code: string, params: Pick<RecordListParams, 'fields'> = {}): Promise<T | null> {
    const checked = currencyCode(code);
    const query = { fields: params.fields, code: checked, number: 1 };
    const rows = await listRecords<T>(this.http, this.path, query, CustomCurrenciesResource.LIST_FILTERS);
    return rows[0] ?? null;
  }

  /**
   * Creates a custom currency with `POST /currencies/custom`, sent once, and
   * answers it, status 201. Siren refuses a code that is not upper case
   * letters, digits and underscores, a built-in currency's code, a code it
   * already holds, and any `type` but `internal`, each with a 400 raised as
   * `BadRequestError`. Siren Cloud also requires `propertyIds`. A resend
   * after a lost answer is refused as a code Siren already holds, so read
   * the currency with {@link retrieve} first: an answer means the first
   * send worked.
   *
   * Sends a new object holding only the {@link CREATE_FIELDS} that `params`
   * gives. Throws `SirenError` before sending when `params` holds any other
   * key, whatever its value, `undefined` included, with exactly
   * `customCurrencies.create() cannot send "{key}". Siren's create route
   * reads only code, name, symbol, symbolPosition, type, exchangeRate, scale
   * and propertyIds.`
   */
  async create(params: CreateCustomCurrencyParams): Promise<T> {
    // Each own key read once, so the code check and the body see the same
    // value and no inherited key reaches either.
    params = { ...params };
    currencyCode(params.code);
    const body = pickFields(
      params,
      CustomCurrenciesResource.CREATE_FIELDS,
      (key) =>
        `customCurrencies.create() cannot send "${key}". Siren's create route reads only code, name, symbol, symbolPosition, type, exchangeRate, scale and propertyIds.`,
    );
    return writeRecord<T>(this.http, 'POST', this.path, body);
  }

  /**
   * Updates a custom currency with `PUT /currencies/custom/{code}`, sent
   * once. Siren refuses any `type` or `scale`, even the current one, with a
   * 400. Delete and recreate the currency instead. Throws `NotFoundError`
   * for an unknown code. Sending it again after a lost answer sets the same
   * values, so it is safe.
   */
  async update(code: string, params: UpdateCustomCurrencyParams): Promise<T> {
    return writeRecord<T>(this.http, 'PUT', `${this.path}/${currencyCode(code)}`, params);
  }

  /**
   * Deletes a custom currency with `DELETE /currencies/custom/{code}`, sent
   * once, at once and for good. Siren first sets every active program that
   * pays in it to `inactive`, then answers `{ success, deactivatedPrograms }`.
   * With `wipeLedger` true it sends `wipeLedger=true`, and the ledger entries
   * in the currency go too. Siren answers 409, raised as `ConflictError`,
   * while unpaid payouts, open obligations or (without `wipeLedger`) held
   * balances remain, and `NotFoundError` for an unknown code. Throws
   * `UnexpectedResponseError` when a 2xx carries no object. A resend after
   * a lost answer answers `NotFoundError` when the first send worked.
   */
  async delete(code: string, wipeLedger = false): Promise<DeletedCustomCurrency> {
    const path = `${this.path}/${currencyCode(code)}`;
    const answer = await deleteRecord<DeletedCustomCurrency>(this.http, path, wipeLedger === true ? { wipeLedger: true } : {});
    if (answer === null) {
      throw new UnexpectedResponseError(`Siren answered DELETE ${path} with no body.`, { statusCode: 204 });
    }
    return answer;
  }
}
