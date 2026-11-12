import { describe, expect, it } from 'vitest';
import {
  ConversionStatus,
  ConversionsResource,
  CustomCurrenciesResource,
  CustomCurrencyType,
  DistributorStatus,
  DistributorsResource,
  SirenError,
  TransactionsResource,
} from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, transportOver } from './record-fakes';
import { ConversionAnswers, CustomCurrencyAnswers, DistributorAnswers, TransactionAnswers } from './record-fakes-2';

/*
 * Slice 4 contract fix, packet F3: the create allow lists, under the
 * orchestrator's ruling O2. `conversions.create`, `transactions.create`,
 * `customCurrencies.create` and `distributors.create` send a new object
 * holding only the fields their Cloud create route reads, and refuse any
 * other key before sending, naming it. Siren ignores a key it does not read,
 * so a misspelt field would go out and come back as a record without it.
 *
 * The lists, read from Siren's source at b6f7140 and checked against the PHP
 * SDK 0.3.0's documented parameters:
 * - conversions: CreateNewConversion.php and ConversionFromRequestService.php,
 *   the five PHP documents.
 * - transactions: CreateTransaction.php, the three PHP documents, and the
 *   seven keys of a line that TransactionDetailChecks.php reads.
 * - custom currencies: CreateCustomCurrency.php reads eight. PHP documents
 *   six and leaves out `scale` and `propertyIds`, which Cloud reads (it
 *   requires `propertyIds`), so the SDK allows both.
 * - distributors: CreateNewDistributor.php, ValidatesDistributorFields.php
 *   and the listeners of DistributorActionEvent, the fifteen PHP documents.
 *
 * Integration shape (KB 568): the real resources over the real
 * HttpTransport, with a FakeHttpClient at the HttpClient seam, aimed at
 * example.invalid.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * packet F3, named in its describe block. The F3 implementer deletes the
 * `.skip` from each of them, so `it.skip(` becomes `it(` and `it.skip.each(`
 * becomes `it.each(`, and deletes the one-line comment above each, and this
 * paragraph. Nothing else here changes. The tests with no `.skip` pass now
 * and guard against a list that refuses a field Cloud reads.
 */

interface Case {
  name: string;
  /** Builds the resource and sends `params` through its create. */
  send: (transport: HttpTransport, params: Record<string, unknown>) => Promise<unknown>;
  answer: unknown;
  /** Every field the create sends. */
  full: Record<string, unknown>;
  message: (key: string) => string;
}

const CONVERSION: Case = {
  name: 'conversions.create',
  send: (transport, params) => new ConversionsResource(transport).create(params as never),
  answer: ConversionAnswers.created,
  full: { engagementId: 31, type: 'sale', status: ConversionStatus.Pending, transactionId: 71, obligationId: 5 },
  message: (key) =>
    `conversions.create() cannot send "${key}". Siren's create route reads only engagementId, type, status, transactionId and obligationId.`,
};

const line = {
  name: 'Mug',
  description: 'Blue',
  type: 'product',
  value: 1200,
  quantity: 2,
  units: 'USD',
  attributes: { sku: 'MUG-1' },
};

const TRANSACTION: Case = {
  name: 'transactions.create',
  send: (transport, params) => new TransactionsResource(transport).create(params as never),
  answer: TransactionAnswers.created,
  full: { details: [line, { name: 'Wrap', value: 300 }], bindingId: 'order-91', bindingDataType: 'crm_order' },
  message: (key) =>
    `transactions.create() cannot send "${key}". Siren's create route reads only details, bindingId and bindingDataType.`,
};

const CURRENCY: Case = {
  name: 'customCurrencies.create',
  send: (transport, params) => new CustomCurrenciesResource(transport).create(params as never),
  answer: CustomCurrencyAnswers.created,
  full: {
    code: 'STORE_CREDIT',
    name: 'Store credit',
    symbol: 'SC',
    symbolPosition: 'before',
    type: CustomCurrencyType.Internal,
    exchangeRate: 1,
    scale: 0,
    propertyIds: [5],
  },
  message: (key) =>
    `customCurrencies.create() cannot send "${key}". Siren's create route reads only code, name, symbol, symbolPosition, type, exchangeRate, scale and propertyIds.`,
};

const DISTRIBUTOR: Case = {
  name: 'distributors.create',
  send: (transport, params) => new DistributorsResource(transport).create(params as never),
  answer: DistributorAnswers.created,
  full: {
    name: 'Quarterly pool',
    description: 'Shares two percent of revenue',
    distributionResolver: 'equalShare',
    distributionPoolResolver: 'revenueSinceLastDistribution',
    status: DistributorStatus.Active,
    units: 'USD',
    revenuePercentage: 2,
    schedule: ['first day of next month'],
    engagementTypes: [{ type: 'sale', calculationType: 'fixed', calculationArgs: { amount: 1 } }],
    collaboratorIds: [4, 5],
    collaboratorGroupId: 3,
    transactionCompilers: ['default'],
    lineItemFilters: { product: ['7'] },
    postAllocationActions: [{ type: 'notify' }],
    metricFilters: [{ type: 'country' }],
  },
  message: (key) =>
    `distributors.create() cannot send "${key}". Siren's create route reads only the fifteen fields in DistributorsResource.CREATE_FIELDS.`,
};

const CASES: Array<[string, Case]> = [CONVERSION, TRANSACTION, CURRENCY, DISTRIBUTOR].map((c) => [c.name, c]);

/** Keys no create route reads: ids Siren sets, a store filter, a misspelling, and one whose value is undefined. */
const STRAYS: Array<[string, unknown]> = [
  ['id', 9],
  ['propertyId', 5],
  ['stauts', 'active'],
  ['dateCreated', undefined],
];

const ROWS = CASES.flatMap(([name, c]) => STRAYS.map(([key, value]) => [name, key, value, c] as const));

describe('4 fix F3: create allow lists surface', () => {
  it('names the fields each create sends', () => {
    expect(ConversionsResource.CREATE_FIELDS).toEqual(['engagementId', 'type', 'status', 'transactionId', 'obligationId']);
    expect(TransactionsResource.CREATE_FIELDS).toEqual(['details', 'bindingId', 'bindingDataType']);
    expect(TransactionsResource.DETAIL_FIELDS).toEqual(['name', 'description', 'type', 'value', 'quantity', 'units', 'attributes']);
    expect(CustomCurrenciesResource.CREATE_FIELDS).toEqual([
      'code',
      'name',
      'symbol',
      'symbolPosition',
      'type',
      'exchangeRate',
      'scale',
      'propertyIds',
    ]);
    expect(DistributorsResource.CREATE_FIELDS).toEqual([
      'name',
      'description',
      'distributionResolver',
      'distributionPoolResolver',
      'status',
      'units',
      'revenuePercentage',
      'schedule',
      'engagementTypes',
      'collaboratorIds',
      'collaboratorGroupId',
      'transactionCompilers',
      'lineItemFilters',
      'postAllocationActions',
      'metricFilters',
    ]);
  });

  it.each(CASES)('%s holds every field its own list names', (_name, c) => {
    const lists: Record<string, readonly string[]> = {
      'conversions.create': ConversionsResource.CREATE_FIELDS,
      'transactions.create': TransactionsResource.CREATE_FIELDS,
      'customCurrencies.create': CustomCurrenciesResource.CREATE_FIELDS,
      'distributors.create': DistributorsResource.CREATE_FIELDS,
    };
    expect(Object.keys(c.full)).toEqual(lists[c.name]);
  });
});

describe('4 fix F3: creates send only the fields Siren reads', () => {
  it.each(CASES)('%s sends every field Siren reads, as given', async (_name, c) => {
    const { http, transport } = transportOver([reply(201, c.answer)]);

    expect(await c.send(transport, c.full)).toEqual(c.answer);
    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0])).toEqual(c.full);
  });

  // Skipped until fix packet F3 (the create allow lists) lands.
  it.skip.each(ROWS)('%s refuses "%s" (%j) before sending, naming it', async (_name, key, value, c) => {
    const { http, transport } = transportOver([reply(201, c.answer)]);

    const error = await c.send(transport, { ...c.full, [key]: value }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(c.message(key));
    expect(http.requests).toHaveLength(0);
  });

  // Skipped until fix packet F3 (the create allow lists) lands.
  it.skip.each(CASES)('%s sends a new object, so a toJSON the caller inherits cannot change the body', async (_name, c) => {
    const { http, transport } = transportOver([reply(201, c.answer)]);
    const params = Object.assign(Object.create({ toJSON: () => ({ id: 9 }) }) as object, c.full);

    await c.send(transport, params);

    expect(bodyOf(http.requests[0])).toEqual(c.full);
  });
});

describe('4 fix F3: transactions.create lines', () => {
  // Skipped until fix packet F3 (the create allow lists) lands.
  it.skip.each([
    ['quanity', 2, 2],
    ['price', 1200, 1],
    ['id', 81, 2],
    ['transactionId', undefined, 1],
  ])('refuses a line key "%s" (%j) on line %i before sending, naming the key and the line', async (key, value, n) => {
    const { http, transport } = transportOver([reply(201, TransactionAnswers.created)]);
    const details = [{ ...line }, { name: 'Wrap', value: 300 }] as Array<Record<string, unknown>>;
    details[n - 1]![key] = value;

    const error = await new TransactionsResource(transport).create({ details } as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      `transactions.create() cannot send "${key}" on line ${n}. A line holds only name, description, type, value, quantity, units and attributes.`,
    );
    expect(http.requests).toHaveLength(0);
  });

  // Skipped until fix packet F3 (the create allow lists) lands.
  it.skip('sends each line as a new object, so a toJSON a line inherits cannot change it', async () => {
    const { http, transport } = transportOver([reply(201, TransactionAnswers.created)]);
    const inherited = Object.assign(Object.create({ toJSON: () => ({ name: 'Mug', value: 1 }) }) as object, line);

    await new TransactionsResource(transport).create({ details: [inherited as typeof line] });

    expect(bodyOf(http.requests[0])).toEqual({ details: [line] });
  });

  it('keeps the details message for details that are not a list of objects', async () => {
    const { http, transport } = transportOver([reply(201, TransactionAnswers.created)]);

    const error = await new TransactionsResource(transport).create({ details: [7] } as never).catch((thrown: unknown) => thrown);

    expect((error as SirenError).message).toBe('transactions.create() needs details: a list of 1 to 500 lines.');
    expect(http.requests).toHaveLength(0);
  });
});
