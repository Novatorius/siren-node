/*
 * Slice 5 acceptance tests that run at compile time: the forwarded event
 * envelope types against Siren Cloud's codecs.
 *
 * `npm run typecheck` compiles this file. Vitest never runs it. Each
 * `@ts-expect-error` line must stay an error, and every other line must keep
 * compiling. The types are vocabulary, written in full in the architecture
 * commit, so these tests hold now and belong to no packet.
 *
 * The done condition: for each of the 16 typed slugs, the keys the SDK's
 * `data` type can carry are exactly the keys Cloud's codec accepts, and the
 * keys every form of the type requires are exactly the keys the codec
 * requires. test/fixtures/forwarded-event-fields.ts holds the codec lists.
 */
import { ForwardedEventSlug } from '../../src/index';
import type {
  CouponEventData,
  ForwardedEventData,
  ForwardedEventEnvelope,
  ForwardedRefundDetails,
  ForwardedRefundLine,
  ForwardedSaleCustomer,
  ForwardedStoreCoupon,
  ForwardedStoreProduct,
  ForwardedTransactionDetail,
  ForwardedTransactionReference,
  SaleTriggeredData,
  Siren,
} from '../../src/index';
import { FORWARDED_EVENT_FIELDS, FORWARDED_NESTED_FIELDS } from '../fixtures/forwarded-event-fields';

/** `true` only when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Every key any form of the union T can carry. */
type AllKeys<T> = T extends unknown ? keyof T : never;

/** The keys one form requires. */
type RequiredIn<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

/** The keys some form of T leaves optional or lacks. */
type NotRequiredSomewhere<T, All extends PropertyKey> = T extends unknown ? Exclude<All, RequiredIn<T>> : never;

/** The keys every form of the union T requires. */
type RequiredKeys<T> = Exclude<AllKeys<T>, NotRequiredSomewhere<T, AllKeys<T>>>;

type Fields = typeof FORWARDED_EVENT_FIELDS;
type Nested = typeof FORWARDED_NESTED_FIELDS;
type TypedSlug = keyof Fields;

type AcceptedMatches = { [S in TypedSlug]: Equal<AllKeys<ForwardedEventData[S]>, Fields[S]['accepted'][number]> };
type RequiredMatches = { [S in TypedSlug]: Equal<RequiredKeys<ForwardedEventData[S]>, Fields[S]['required'][number]> };

/** Each entry must be `true`. A mismatch names its slug in the compiler's error. */
export const acceptedKeysMatchCloud: AcceptedMatches = {
  'sale-triggered': true,
  'transaction-completed': true,
  'refund-triggered': true,
  'partial-refund-received': true,
  'customer-identified': true,
  'customer-created': true,
  'customer-updated': true,
  'customer-deleted': true,
  'coupon-created': true,
  'coupon-updated': true,
  'coupon-deleted': true,
  'coupons-imported': true,
  'product-created': true,
  'product-updated': true,
  'product-deleted': true,
  'products-imported': true,
};

export const requiredKeysMatchCloud: RequiredMatches = {
  'sale-triggered': true,
  'transaction-completed': true,
  'refund-triggered': true,
  'partial-refund-received': true,
  'customer-identified': true,
  'customer-created': true,
  'customer-updated': true,
  'customer-deleted': true,
  'coupon-created': true,
  'coupon-updated': true,
  'coupon-deleted': true,
  'coupons-imported': true,
  'product-created': true,
  'product-updated': true,
  'product-deleted': true,
  'products-imported': true,
};

type NestedTypes = {
  transactionReference: ForwardedTransactionReference;
  refundDetails: ForwardedRefundDetails;
  refundLine: ForwardedRefundLine;
  transactionDetail: ForwardedTransactionDetail;
  saleCustomer: ForwardedSaleCustomer;
  storeCoupon: ForwardedStoreCoupon;
  storeProduct: ForwardedStoreProduct;
};

export const nestedKeysMatchCloud: {
  [N in keyof Nested]: [
    Equal<AllKeys<NestedTypes[N]>, Nested[N]['accepted'][number]>,
    Equal<RequiredKeys<NestedTypes[N]>, Nested[N]['required'][number]>,
  ];
} = {
  transactionReference: [true, true],
  refundDetails: [true, true],
  refundLine: [true, true],
  transactionDetail: [true, true],
  saleCustomer: [true, true],
  storeCoupon: [true, true],
  storeProduct: [true, true],
};

/** The 16 typed slugs are each a `ForwardedEventSlug` value, so `forward` takes every one. */
export const typedSlugsAreSlugs: Equal<Exclude<TypedSlug, ForwardedEventSlug>, never> = true;

/** Every slug has a `data` type, and nothing else does. */
export const everySlugHasData: Equal<keyof ForwardedEventData, ForwardedEventSlug> = true;

const sale = {
  trackingToken: 'tt_1',
  source: 'medusa',
  bindingId: 'order_01',
  bindingType: 'medusa_order',
  transactionDetails: [{ name: 'Hat', type: 'product', value: 2500, quantity: 1, externalId: 'line_1' }],
  couponCodes: ['SPRING'],
  customer: { type: 'medusa_customer', id: 'cus_01' },
} satisfies SaleTriggeredData;

export function envelopeContract(siren: Siren): void {
  const base = { version: 1, eventId: '5f0c2b1e-9d8a-4c3f-8e7d-6c5b4a392817', origin: 'site', occurredAt: null } as const;

  void siren.events.forward(ForwardedEventSlug.SaleTriggered, { ...base, data: sale });
  void siren.events.forward('sale-triggered', { ...base, data: { ...sale, trackingToken: null } });
  void siren.events.forward('refund-triggered', {
    ...base,
    data: { transaction: { bindingId: 'order_01', bindingType: 'medusa_order' }, refund: { reference: 'ref_1', amount: 500 } },
    optional: { refundKind: 'cancelled' },
  });
  void siren.events.forward('coupon-created', { ...base, data: { integration: 'medusa', code: 'SPRING', changedAt: 1_762_000_000 } });
  void siren.events.forward('products-imported', {
    ...base,
    data: { integration: 'medusa', products: [{ platformId: 'prod_1', name: 'Hat' }], completedImportStartedAt: null },
  });
  void siren.events.forward('lead-triggered', { ...base, data: { anything: 'the SDK does not type this slug yet' } });

  // @ts-expect-error a sale names its shopper by trackingToken or opportunityId, never both
  void siren.events.forward('sale-triggered', { ...base, data: { ...sale, opportunityId: 4 } });

  const { trackingToken: _dropped, ...unattributed } = sale;
  // @ts-expect-error a sale needs trackingToken (null for none) or opportunityId
  void siren.events.forward('sale-triggered', { ...base, data: unattributed });

  const { bindingId: _order, ...noOrder } = sale;
  // @ts-expect-error a sale needs bindingId
  void siren.events.forward('sale-triggered', { ...base, data: noOrder });

  // @ts-expect-error Cloud refuses a key its codec does not read
  void siren.events.forward('product-deleted', { ...base, data: { integration: 'medusa', platformId: 'p', sku: 'HAT' } });

  // @ts-expect-error a coupon event's changedAt is Unix time, not text
  const coupon: CouponEventData = { integration: 'medusa', code: 'SPRING', changedAt: '2026-11-12T09:30:00+00:00' };
  void coupon;

  // @ts-expect-error a customer type is wordpress_user or {integration}_customer
  const customer: ForwardedSaleCustomer = { type: 'guest', id: 1 };
  void customer;

  // @ts-expect-error Cloud refuses an event whose origin is cloud
  const looped: ForwardedEventEnvelope<'product-deleted'> = { ...base, origin: 'cloud', data: { integration: 'm', platformId: 'p' } };
  void looped;

  // @ts-expect-error version 1 is the only version this SDK writes
  const newer: ForwardedEventEnvelope<'product-deleted'> = { ...base, version: 2, data: { integration: 'm', platformId: 'p' } };
  void newer;

  // @ts-expect-error each slug takes its own data: a product event is not a sale
  void siren.events.forward('product-created', { ...base, data: sale });

  // @ts-expect-error refundKind is refund, cancelled or voided
  void siren.events.forward('refund-triggered', { ...base, data: { transaction: { id: 1 } }, optional: { refundKind: 'returned' } });

  // @ts-expect-error Cloud ignores an optional field it does not know, so a misspelt one must not compile
  void siren.events.forward('refund-triggered', { ...base, data: { transaction: { id: 1 } }, optional: { refundKnd: 'refund' } });
}
