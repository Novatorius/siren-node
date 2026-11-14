/*
 * The `data` keys Siren Cloud's codec reads for each of the 16 forwarded
 * event slugs the SDK types in full, copied from Siren at b6f7140d0.
 *
 * `accepted` is the list the codec passes to `WirePayloadReader::refuseUnknown`,
 * in the codec's own order, so Cloud refuses any key outside it. `required`
 * is the keys the codec reads with a reader that has no null or absent form
 * (`text`, `identifier`, `wholeNumber`, `object`, `listOfObjects`), so Cloud
 * refuses a body without one. A key Cloud needs one of, such as
 * `trackingToken` or `opportunityId` on a sale, is in neither `required`
 * list. test/types/forwarded-events.ts checks the SDK's types against this
 * file at compile time.
 *
 * Paths are under lib/EventForwarding/Core in Siren. The lists are
 * hand-read from the cited codecs, not captured from a running Cloud.
 * Slice 20 runs the connector golden path against a local Cloud and checks
 * them there.
 */
export const FORWARDED_EVENT_FIELDS = {
  /** Codecs/SaleTriggeredCodec.php line 202, reads at lines 204 to 207. */
  'sale-triggered': {
    accepted: ['opportunityId', 'trackingToken', 'source', 'bindingId', 'bindingType', 'transactionDetails', 'couponCodes', 'customer'],
    required: ['source', 'bindingId', 'bindingType', 'transactionDetails'],
  },
  /** Codecs/TransactionCompletedCodec.php line 47. */
  'transaction-completed': { accepted: ['transaction'], required: ['transaction'] },
  /** Codecs/RefundTriggeredCodec.php line 70. */
  'refund-triggered': { accepted: ['transaction', 'refund'], required: ['transaction'] },
  /** Codecs/PartialRefundReceivedCodec.php line 77, reads at lines 79 to 86. */
  'partial-refund-received': {
    accepted: ['transaction', 'source', 'refundedAmount', 'orderAmount', 'reason', 'refund'],
    required: ['transaction', 'source'],
  },
  /** Codecs/CustomerEventCodecBase.php line 95, reads at lines 97 to 117. The four customer slugs share it. */
  'customer-identified': {
    accepted: ['integration', 'platformId', 'emailHash', 'emailKeyId', 'name', 'trackingToken', 'opportunityId', 'changedAt', 'onSale'],
    required: ['integration'],
  },
  'customer-created': {
    accepted: ['integration', 'platformId', 'emailHash', 'emailKeyId', 'name', 'trackingToken', 'opportunityId', 'changedAt', 'onSale'],
    required: ['integration'],
  },
  'customer-updated': {
    accepted: ['integration', 'platformId', 'emailHash', 'emailKeyId', 'name', 'trackingToken', 'opportunityId', 'changedAt', 'onSale'],
    required: ['integration'],
  },
  'customer-deleted': {
    accepted: ['integration', 'platformId', 'emailHash', 'emailKeyId', 'name', 'trackingToken', 'opportunityId', 'changedAt', 'onSale'],
    required: ['integration'],
  },
  /** Codecs/StoreCouponWire.php: the coupon fields, lines 47 to 50, plus integration (line 65) and changedAt (line 76). */
  'coupon-created': {
    accepted: ['integration', 'platformId', 'code', 'bindingCode', 'deleted', 'changedAt'],
    required: ['integration', 'changedAt'],
  },
  'coupon-updated': {
    accepted: ['integration', 'platformId', 'code', 'bindingCode', 'deleted', 'changedAt'],
    required: ['integration', 'changedAt'],
  },
  'coupon-deleted': {
    accepted: ['integration', 'platformId', 'code', 'bindingCode', 'deleted', 'changedAt'],
    required: ['integration', 'changedAt'],
  },
  /** Codecs/CouponsImportedCodec.php line 48. */
  'coupons-imported': { accepted: ['integration', 'coupons', 'changedAt'], required: ['integration', 'coupons', 'changedAt'] },
  /** Codecs/WithStoreProductFields.php PRODUCT_FIELDS (line 31) plus integration, reads at lines 64 to 86. */
  'product-created': {
    accepted: ['integration', 'platformId', 'name', 'sku', 'offered', 'changedAt', 'parentPlatformId'],
    required: ['integration', 'platformId', 'name'],
  },
  'product-updated': {
    accepted: ['integration', 'platformId', 'name', 'sku', 'offered', 'changedAt', 'parentPlatformId'],
    required: ['integration', 'platformId', 'name'],
  },
  /** Codecs/ProductDeletedCodec.php line 50. */
  'product-deleted': { accepted: ['integration', 'platformId', 'changedAt'], required: ['integration', 'platformId'] },
  /** Codecs/ProductsImportedCodec.php line 59. */
  'products-imported': {
    accepted: ['integration', 'products', 'completedImportStartedAt'],
    required: ['integration', 'products'],
  },
} as const;

/** The objects nested inside `data`, by the same rules. */
export const FORWARDED_NESTED_FIELDS = {
  /** Services/TransactionReferenceWireFormat.php line 88. Either `id` or both binding fields. */
  transactionReference: { accepted: ['id', 'bindingId', 'bindingType'], required: [] },
  /** Services/RefundDetailsWireFormat.php line 64. */
  refundDetails: { accepted: ['reference', 'amount', 'cumulative', 'source', 'lines'], required: [] },
  /** Services/RefundDetailsWireFormat.php line 76. */
  refundLine: { accepted: ['lineId', 'quantity', 'amount', 'sku'], required: [] },
  /** Services/TransactionDetailsWireFormat.php FIELDS, line 38. */
  transactionDetail: {
    accepted: ['name', 'description', 'type', 'value', 'quantity', 'units', 'externalId', 'attributes'],
    required: [],
  },
  /** Codecs/SaleTriggeredCodec.php readCustomer, line 167: exactly these two keys. */
  saleCustomer: { accepted: ['type', 'id'], required: ['type', 'id'] },
  /** Codecs/CouponsImportedCodec.php line 52. A coupon needs a platformId or a code, so neither is required alone. */
  storeCoupon: { accepted: ['platformId', 'code', 'bindingCode', 'deleted'], required: [] },
  /** Codecs/WithStoreProductFields.php PRODUCT_FIELDS (line 31), as ProductsImportedCodec.php line 64 reads each product. */
  storeProduct: {
    accepted: ['platformId', 'name', 'sku', 'offered', 'changedAt', 'parentPlatformId'],
    required: ['platformId', 'name'],
  },
} as const;
