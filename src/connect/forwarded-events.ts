import type { RefundKind } from '../taxonomy';

/**
 * The forwarded event envelope: how a connected site, or an API key with an
 * exact `event:{slug}` scope, sends a Siren event to `POST /event/{slug}`.
 *
 * Siren Cloud owns these slugs and fields. Each data type below lists the
 * keys Cloud's codec for that slug reads, and Cloud refuses any other key in
 * `data`, so a type here never carries a key Cloud would refuse. The field
 * rules come from Siren's `lib/EventForwarding` at b6f7140d0 (the codec named
 * on each type, `EventWireFormat`, `WirePayloadReader` and the wire helpers).
 *
 * ```ts
 * await siren.events.forward(ForwardedEventSlug.ProductDeleted, {
 *   version: 1,
 *   eventId: '5f0c2b1e-9d8a-4c3f-8e7d-6c5b4a392817',
 *   origin: 'site',
 *   occurredAt: '2026-11-12T09:30:00+00:00',
 *   data: { integration: 'medusa', platformId: 'prod_01J...' },
 * });
 * ```
 */

/** The slugs a forwarded event is sent to, as in `POST /event/{slug}`. Siren's `ForwardedEventSlug`. */
export const ForwardedEventSlug = {
  SaleTriggered: 'sale-triggered',
  TransactionCompleted: 'transaction-completed',
  RefundTriggered: 'refund-triggered',
  PartialRefundReceived: 'partial-refund-received',
  RenewalTriggered: 'renewal-triggered',
  LeadTriggered: 'lead-triggered',
  BlogPostVisited: 'blog-post-visited',
  CouponApplied: 'coupon-applied',
  StudentCompletedLesson: 'student-completed-lesson',
  StudentCompletedCourse: 'student-completed-course',
  OrderDiscountsDetected: 'order-discounts-detected',
  OrderDiscountsReversed: 'order-discounts-reversed',
  CustomerIdentified: 'customer-identified',
  EarlierSaleCustomerIdentified: 'earlier-sale-customer-identified',
  EarlierOrderRefundsFound: 'earlier-order-refunds-found',
  EarlierSaleCouponsIdentified: 'earlier-sale-coupons-identified',
  SaleLineVariationsIdentified: 'sale-line-variations-identified',
  CustomerCreated: 'customer-created',
  CustomerUpdated: 'customer-updated',
  CustomerDeleted: 'customer-deleted',
  CouponCreated: 'coupon-created',
  CouponUpdated: 'coupon-updated',
  CouponDeleted: 'coupon-deleted',
  CouponsImported: 'coupons-imported',
  ProductCreated: 'product-created',
  ProductUpdated: 'product-updated',
  ProductDeleted: 'product-deleted',
  ProductsImported: 'products-imported',
} as const;

/** Union of the {@link ForwardedEventSlug} strings. */
export type ForwardedEventSlug = (typeof ForwardedEventSlug)[keyof typeof ForwardedEventSlug];

/** The wire format version this SDK writes. Cloud refuses a version newer than it knows. */
export const FORWARDED_EVENT_VERSION = 1;

/** A whole number or text id, as `WirePayloadReader::identifier` reads one. */
export type WireIdentifier = string | number;

/**
 * The customer type a forwarded sale may name: a WordPress user on the
 * sending site, or `{integration}_customer` for an integration the site
 * reported, such as `medusa_customer`. Siren's `SiteCustomerTypes`.
 */
export type SiteCustomerType = 'wordpress_user' | `${string}_customer`;

/** The customer a sale names. Siren's `SaleTriggeredCodec::readCustomer`. */
export interface ForwardedSaleCustomer {
  type: SiteCustomerType;
  /** Text with no surrounding white space. A positive whole number reads as text. */
  id: WireIdentifier;
}

/** A plain transaction line attribute value. Text holds at most 255 characters. */
export type ForwardedAttributeValue = string | number | boolean | null;

/**
 * One line of a sale's `transactionDetails`. Siren's
 * `TransactionDetailsWireFormat::FIELDS`. Every key is optional, and Cloud
 * reads only the keys present.
 */
export interface ForwardedTransactionDetail {
  name?: string | null;
  description?: string | null;
  /** Such as `product`, `shipping`, `tax` or `discount`. */
  type?: string;
  /** Minor currency units. */
  value?: number;
  /** Zero or more. A fraction is rounded. */
  quantity?: number;
  units?: string | null;
  externalId?: WireIdentifier | null;
  /** Up to 50 entries, each a plain value or a list of up to 500 non-null plain values. */
  attributes?: Record<string, ForwardedAttributeValue | Array<string | number | boolean>> | null;
}

/**
 * The transaction an event acts on. Siren's `TransactionReferenceWireFormat`.
 * A connected site names it by the order it was recorded for. An
 * organization-wide sender may name it by Cloud's id instead.
 */
export type ForwardedTransactionReference =
  | { id?: number | null; bindingId: WireIdentifier; bindingType: string }
  | { id: number; bindingId?: null; bindingType?: null };

/** One refunded line. Siren's `RefundDetailsWireFormat` line fields. */
export interface ForwardedRefundLine {
  lineId?: WireIdentifier | null;
  quantity?: number | null;
  /** Minor currency units. */
  amount?: number | null;
  sku?: string | null;
}

/** What a refund was. Siren's `RefundDetailsWireFormat` fields. */
export interface ForwardedRefundDetails {
  /** The store's own id for the refund, up to 191 characters. */
  reference?: WireIdentifier | null;
  /** Minor currency units. */
  amount?: number | null;
  /** Whether `amount` is the running total refunded on the order. */
  cumulative?: boolean | null;
  source?: string | null;
  /** Up to 500 lines. */
  lines?: ForwardedRefundLine[] | null;
}

/** `data` for `sale-triggered`. Siren's `SaleTriggeredCodec`. */
export type SaleTriggeredData = SaleTriggeredFields &
  (
    | {
        /** The shopper's tracking token, or `null` for an unattributed sale. A connected site always sends this. */
        trackingToken: string | null;
        opportunityId?: never;
      }
    | {
        /** Cloud's opportunity id. Only an organization-wide sender may send it. */
        opportunityId: number;
        trackingToken?: never;
      }
  );

/** The `sale-triggered` fields besides the attribution. */
export interface SaleTriggeredFields {
  source: string;
  /** The order id. */
  bindingId: WireIdentifier;
  /** Such as `medusa_order`. */
  bindingType: string;
  transactionDetails: ForwardedTransactionDetail[];
  /** Up to 20 codes of 1 to 255 characters. */
  couponCodes?: string[];
  customer?: ForwardedSaleCustomer;
}

/** `data` for `transaction-completed`. Siren's `TransactionCompletedCodec`. */
export interface TransactionCompletedData {
  transaction: ForwardedTransactionReference;
}

/** `data` for `refund-triggered`. Siren's `RefundTriggeredCodec`. */
export interface RefundTriggeredData {
  transaction: ForwardedTransactionReference;
  refund?: ForwardedRefundDetails | null;
}

/** `data` for `partial-refund-received`. Siren's `PartialRefundReceivedCodec`. */
export interface PartialRefundReceivedData {
  transaction: ForwardedTransactionReference;
  /** Up to 64 characters. */
  source: string;
  /** Minor currency units. */
  refundedAmount?: number | null;
  /** Minor currency units. */
  orderAmount?: number | null;
  /** Up to 255 characters. */
  reason?: string | null;
  refund?: ForwardedRefundDetails | null;
}

/**
 * `data` for the four customer slugs. Siren's `CustomerEventCodecBase`.
 * Cloud reads `onSale` on `customer-identified` only.
 */
export type CustomerEventData = CustomerEventFields &
  (
    | { trackingToken?: string | null; opportunityId?: never }
    | { opportunityId?: number; trackingToken?: never }
  );

/** The customer event fields besides the attribution. */
export interface CustomerEventFields {
  /** Up to 50 characters. */
  integration: string;
  platformId?: string | null;
  /** The keyed HMAC SHA-256 hash of the email, 64 lower-case hex digits. Never the email. */
  emailHash?: string | null;
  /** The id of the key the hash was made with, from `GET /connect/customer-email-key`. */
  emailKeyId?: string | null;
  name?: string | null;
  /** ISO 8601 in ATOM form, such as `2026-11-12T09:30:00+00:00`. */
  changedAt?: string | null;
  onSale?: boolean;
}

/** One store coupon. Siren's `StoreCouponWire`. A coupon needs a `platformId` or a `code`. */
export interface ForwardedStoreCoupon {
  platformId?: string | null;
  code?: string | null;
  bindingCode?: string | null;
  deleted?: boolean | null;
}

/** `data` for `coupon-created`, `coupon-updated` and `coupon-deleted`. Siren's `StoreCouponWire` codecs. */
export interface CouponEventData extends ForwardedStoreCoupon {
  /** Lower-case letters, digits, `_` and `-`, up to 32 characters. */
  integration: string;
  /** Unix time, 2020 or later. */
  changedAt: number;
}

/** `data` for `coupons-imported`. Siren's `CouponsImportedCodec`. */
export interface CouponsImportedData {
  integration: string;
  /** Up to 100 coupons. */
  coupons: ForwardedStoreCoupon[];
  /** Unix time, 2020 or later. */
  changedAt: number;
}

/** One store product. Siren's `WithStoreProductFields::PRODUCT_FIELDS`. */
export interface ForwardedStoreProduct {
  platformId: WireIdentifier;
  /** Up to 1,000 characters. */
  name: string;
  sku?: string | null;
  /** Whether the store offers it. Cloud reads `true` when it is left out. */
  offered?: boolean | null;
  /** ISO 8601 in ATOM form. */
  changedAt?: string | null;
  parentPlatformId?: WireIdentifier | null;
}

/** `data` for `product-created` and `product-updated`. Siren's `ProductCreatedCodec` and `ProductUpdatedCodec`. */
export interface ProductEventData extends ForwardedStoreProduct {
  /** Lower-case letters, digits, `_` and `-`. */
  integration: string;
}

/** `data` for `product-deleted`. Siren's `ProductDeletedCodec`. */
export interface ProductDeletedData {
  integration: string;
  platformId: WireIdentifier;
  /** ISO 8601 in ATOM form. */
  changedAt?: string | null;
}

/** `data` for `products-imported`. Siren's `ProductsImportedCodec`. */
export interface ProductsImportedData {
  integration: string;
  /** Up to 500 products. */
  products: ForwardedStoreProduct[];
  /** ISO 8601 in ATOM form. Marks the import's last page: Cloud forgets products no page since then named. */
  completedImportStartedAt?: string | null;
}

/**
 * `data` for a slug this SDK does not type yet. Cloud's codec for the slug
 * still decides which keys it takes.
 */
export type UntypedForwardedEventData = Readonly<Record<string, unknown>>;

/** The `data` each slug carries. */
export interface ForwardedEventData {
  'sale-triggered': SaleTriggeredData;
  'transaction-completed': TransactionCompletedData;
  'refund-triggered': RefundTriggeredData;
  'partial-refund-received': PartialRefundReceivedData;
  'renewal-triggered': UntypedForwardedEventData;
  'lead-triggered': UntypedForwardedEventData;
  'blog-post-visited': UntypedForwardedEventData;
  'coupon-applied': UntypedForwardedEventData;
  'student-completed-lesson': UntypedForwardedEventData;
  'student-completed-course': UntypedForwardedEventData;
  'order-discounts-detected': UntypedForwardedEventData;
  'order-discounts-reversed': UntypedForwardedEventData;
  'customer-identified': CustomerEventData;
  'earlier-sale-customer-identified': UntypedForwardedEventData;
  'earlier-order-refunds-found': UntypedForwardedEventData;
  'earlier-sale-coupons-identified': UntypedForwardedEventData;
  'sale-line-variations-identified': UntypedForwardedEventData;
  'customer-created': CustomerEventData;
  'customer-updated': CustomerEventData;
  'customer-deleted': CustomerEventData;
  'coupon-created': CouponEventData;
  'coupon-updated': CouponEventData;
  'coupon-deleted': CouponEventData;
  'coupons-imported': CouponsImportedData;
  'product-created': ProductEventData;
  'product-updated': ProductEventData;
  'product-deleted': ProductDeletedData;
  'products-imported': ProductsImportedData;
}

/**
 * Fields a receiver may go without, sent beside `data`. Siren's
 * `CarriesOptionalFields`, which only `RefundTriggeredCodec` implements at
 * b6f7140d0. Cloud ignores a field it does not know, so the type names only
 * the ones it reads, and a misspelt field fails to compile.
 */
export interface ForwardedEventOptionalFields {
  /** `refund-triggered` only: what the refund was. */
  refundKind?: RefundKind;
}

/**
 * The body of a forwarded event. Siren's `EventWireFormat`.
 *
 * `eventId` is a UUID the sender picks when it first queues the event and
 * keeps for every retry, so Cloud can recognise a second delivery. `origin`
 * is always `site`: Cloud refuses an event that came from Cloud with 409, so
 * an event never travels round in a loop. `occurredAt` is when the event
 * happened, in ISO 8601 with an offset, or `null`. `optional` is left out
 * when there is nothing to send in it.
 */
export interface ForwardedEventEnvelope<S extends ForwardedEventSlug = ForwardedEventSlug> {
  version: typeof FORWARDED_EVENT_VERSION;
  eventId: string;
  origin: 'site';
  occurredAt: string | null;
  data: ForwardedEventData[S];
  optional?: ForwardedEventOptionalFields;
}

/** Options for one `events.forward` call. */
export interface ForwardOptions {
  /**
   * Marks the outbox's last try of this event. Sends
   * `X-Siren-Final-Attempt: 1` on the one send `forward` makes, so Cloud
   * logs an event it will never record instead of waiting for a resend.
   */
  finalAttempt?: boolean;
}
