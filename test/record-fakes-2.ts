/*
 * Slice 4 Siren Cloud answers, written from Siren's source at b6f7140
 * (origin/feat/node-commerce-connectors). The transport doubles and the
 * request helpers stay in test/record-fakes.ts, which slice 3 owns. This
 * file holds only answers, so slice 3 and slice 4 never edit the same file.
 *
 * None of these is captured from a live answer, since nothing in this build
 * calls a running Siren. Each cites the Cloud file and line it follows.
 * When Cloud's branch moves past b6f7140, whoever merges it into this work
 * checks the cited lines again.
 *
 * Paths are under lib/ unless they start with saas/. Reads write dates as
 * ISO 8601 (ResponseNormalizerInterceptor), and the adapters behind a
 * write's answer write `Y-m-d H:i:s`. Three error shapes reach the SDK: a
 * flat `{ error }` from Response::setError, `{ error: { message, code } }`
 * from ApiErrorCode::respond (Core/Service/Rest/ApiErrorCode.php line 153),
 * and `{ error: { message, code?, context } }` from a thrown exception
 * through saas/Strategies/RestStrategy.php.
 */

/** Response::setError as every RecordExists-less read and write calls it for a missing id. Status 404. */
export const notFoundById = { error: 'No record found with that ID.' } as const;

/** Users/Service/Middleware/RequiresCapabilityMiddleware.php lines 61 to 66. Status 403. */
export function planRequired(capability: string) {
  return { error: { message: 'Your plan does not include this feature.', code: 'plan_required', context: { capability } } };
}

/** saas/Auth/ConnectorRequestRules.php lines 674 to 681, requireSiteFilter. Status 403. */
export function siteFilterRequired(filters: string[]) {
  return {
    error: {
      message: `A connected site reads these records only through a filter that ties them to its own store: ${filters.join(', ')}.`,
      code: 'site_filter_required',
      context: { anyOf: filters },
    },
  };
}

/** Core/Service/Middlewares/RequireAnyParamMiddleware.php lines 39 to 43, through RestStrategy. Status 400. */
export function requireAnyParam(params: string[]) {
  return { error: { message: `Send at least one of: ${params.join(', ')}.`, context: { params } } };
}

/** Core/Service/Interceptors/RegistryResponseInterceptor.php line 57 wraps every registry read as `{ options }`. */
export function registry(options: Array<Record<string, unknown>>) {
  return { options };
}

export const OpportunityAnswers = {
  /** Opportunities/Service/Providers/OpportunitiesServiceConfigurationProvider.php, the default list fields. */
  listed: {
    id: 21,
    status: 'active',
    lastTriggered: '2026-10-16T12:00:00+00:00',
    createdDate: '2026-10-01T09:00:00+00:00',
    modifiedDate: '2026-10-16T12:00:00+00:00',
  },
  /** Opportunities/Core/Models/Adapters/OpportunityAdapter.php, the record a PUT answers. Status 200. */
  updated: {
    id: 21,
    status: 'inactive',
    lastTriggered: '2026-10-16 12:00:00',
    dateCreated: '2026-10-01 09:00:00',
    dateModified: '2026-10-17 08:00:00',
  },
  /** A connected site's list with no filter that names its own records. Status 403. */
  siteFilterRequired: siteFilterRequired(['id', 'collaboratorId']),
} as const;

export const EngagementAnswers = {
  /** Engagements/Rest/Service/GetEngagements.php, the default fields with the two names. */
  listed: {
    id: 31,
    opportunityId: 21,
    programId: 2,
    collaboratorId: 4,
    collaboratorName: 'Flo',
    programName: 'Partners',
    score: 1,
    status: 'active',
    dateCreated: '2026-10-16T12:00:00+00:00',
    dateModified: '2026-10-16T12:00:00+00:00',
  },
  /** Engagements/Rest/Service/GetEngagementTypes.php line 81, through the registry interceptor. */
  types: registry([
    { id: 'referredSiteVisit', name: 'Referred site visit', description: 'A visitor arrived through a referral link.' },
    { id: 'manual', name: 'Manual', description: 'Credited by hand.' },
  ]),
  /** Engagements/Rest/Service/GetEngagementCalculations.php line 74, through the registry interceptor. */
  calculations: registry([{ id: 'fixed', name: 'Fixed', description: 'A fixed score.', requiredArgs: ['value'] }]),
} as const;

export const DistributorAnswers = {
  /** Distributions/Rest/Service/GetDistributors.php, the default list fields. */
  listed: {
    id: 7,
    name: 'Monthly pool',
    description: 'Shares five percent of revenue',
    status: 'active',
    units: 'USD',
    distributionResolver: 'equalShare',
    distributionPoolResolver: 'revenuePercentage',
    collaboratorCount: 3,
    dateCreated: '2026-09-01T00:00:00+00:00',
    dateModified: '2026-10-01T00:00:00+00:00',
  },
  /** Distributions/Core/Models/Adapters/DistributorAdapter.php through CreateNewDistributor.php lines 157 to 159. Status 201. */
  created: {
    id: 8,
    name: 'Quarterly pool',
    description: 'Shares two percent of revenue',
    distributionResolver: 'equalShare',
    distributionPoolResolver: 'revenuePercentage',
    status: 'active',
    units: 'USD',
    dateCreated: '2026-10-16 12:00:00',
    dateModified: '2026-10-16 12:00:00',
  },
  /** UpdateDistributor.php lines 184 to 186, the same adapter. Status 200. */
  updated: {
    id: 7,
    name: 'Monthly pool',
    description: 'Shares five percent of revenue',
    distributionResolver: 'equalShare',
    distributionPoolResolver: 'revenuePercentage',
    status: 'inactive',
    units: 'USD',
    dateCreated: '2026-09-01 00:00:00',
    dateModified: '2026-10-16 12:00:00',
  },
  /** DeleteDistributor.php line 114, the first call. The second answers 204 (line 109). */
  softDeleted: {
    id: 7,
    name: 'Monthly pool',
    description: 'Shares five percent of revenue',
    distributionResolver: 'equalShare',
    distributionPoolResolver: 'revenuePercentage',
    status: 'deleted',
    units: 'USD',
    dateCreated: '2026-09-01 00:00:00',
    dateModified: '2026-10-16 12:00:00',
  },
  /** DistributorBulkAction.php line 155. */
  bulk: { success: true, affected: 2 },
  /** DistributorBulkAction.php line 151, a permanent delete of a distributor not yet in the trash. Status 409. */
  permanentDeleteBlocked: {
    error: 'Nothing was deleted. Move this distributor to the trash before deleting permanently: Monthly pool.',
  },
  /** CreditMetric.php lines 200 to 204, describe() at line 215. Status 200. */
  credited: { success: true, credited: [{ id: 7, name: 'Monthly pool' }], notCredited: [{ id: 9, name: 'Leaders' }] },
  /** CreditMetric.php lines 185 to 197, a distributor qualified and added nothing. Status 422. */
  nothingCredited: {
    error:
      'Nothing was credited. No points were added in Leaders. Enter points if a distributor has no point value set. If it has one, a metric filter, its schedule or a cascade with nobody to reach stopped the credit.',
  },
  /** CreditMetric.php line 148. Status 404. */
  collaboratorNotFound: { error: 'Collaborator not found.' },
  /** The Essentials gate on every distributor write. Status 403. */
  planRequired: planRequired('distributors'),
} as const;

export const CustomCurrencyAnswers = {
  /** Essentials/Rest/Service/CustomCurrencies/GetCustomCurrencies.php line 131, one row with its store fields. */
  listed: {
    code: 'STORE_CREDIT',
    name: 'Store credit',
    symbol: 'SC',
    symbolPosition: 'before',
    type: 'internal',
    exchangeRate: 1,
    scale: 0,
    propertyIds: [5],
    stores: [{ id: 5, name: 'Main store' }],
  },
  /**
   * CreateCustomCurrency.php line 127: Configs/Core/Models/Adapters/CustomCurrencyAdapter.php
   * plus storeFields (lines 143 to 150) where store bindings are enforced. Status 201.
   */
  created: {
    code: 'STORE_CREDIT',
    name: 'Store credit',
    symbol: 'SC',
    symbolPosition: 'before',
    type: 'internal',
    exchangeRate: 1,
    scale: 0,
    createdDate: '2026-10-16 12:00:00',
    modifiedDate: '2026-10-16 12:00:00',
    propertyIds: [5],
    stores: [{ id: 5, name: 'Main store' }],
  },
  /** UpdateCustomCurrency.php line 120. Status 200. */
  updated: {
    code: 'STORE_CREDIT',
    name: 'Shop credit',
    symbol: 'SC',
    symbolPosition: 'before',
    type: 'internal',
    exchangeRate: 1,
    scale: 0,
    createdDate: '2026-10-16 12:00:00',
    modifiedDate: '2026-10-17 08:00:00',
    propertyIds: [5],
    stores: [{ id: 5, name: 'Main store' }],
  },
  /** DeleteCustomCurrency.php lines 104 to 107. Status 200. */
  deleted: { success: true, deactivatedPrograms: [{ id: 2, name: 'Partners' }] },
  /** DeleteCustomCurrency.php line 82, the deletion guard's description. The wording stands in for the guard's, which names the blockers. Status 409. */
  deleteBlocked: {
    error: 'This currency cannot be deleted because it still has 1 payout that has not been paid. Settle or cancel them first.',
  },
  /** DeleteCustomCurrency.php line 109 and UpdateCustomCurrency.php line 122. Status 404. */
  notFound: { error: 'Custom currency not found.' },
  /** UpdateCustomCurrency.php line 85. Status 400. */
  scaleLocked: { error: 'Currency scale cannot be changed after creation. Delete and recreate the currency instead.' },
  /** The Essentials gate on every custom currency write. Status 403. */
  planRequired: planRequired('custom-currencies'),
} as const;

export const CreditAnswers = {
  /** Credits/Rest/Service/AdjustCreditBalance.php lines 93 to 101. Status 200. */
  adjusted: { success: true, entry: { id: 41, amount: -250, currency: 'STORE_CREDIT', collaboratorId: 4 } },
  /** GET /collaborators/{id}?fields=id,creditBalances, the creditBalances field resolver's entry. */
  balancesRecord: {
    id: 4,
    creditBalances: [
      {
        currency: 'STORE_CREDIT',
        balance: 1000,
        onHold: 250,
        available: 750,
        name: 'Store credit',
        symbol: 'SC',
        symbolPosition: 'before',
        exchangeRate: 1,
        stores: [{ id: 5, name: 'Main store' }],
        redeemAt: [{ id: 5, name: 'Main store' }],
      },
    ],
  },
  /** Credits/Rest/Service/GetCreditBalances.php lines 74 to 85, `{ items }` with no paging. */
  checkoutBalances: {
    items: [
      { collaboratorId: 4, currency: 'STORE_CREDIT', balance: 1000, reserved: 250, available: 750 },
      { collaboratorId: 4, currency: 'POINTS', balance: 40, reserved: 0, available: 40 },
    ],
  },
  /** Credits/Core/Models/Adapters/CreditEntryAdapter.php, through the list wrapper. */
  entry: {
    id: 41,
    collaboratorId: 4,
    currency: 'STORE_CREDIT',
    amount: -250,
    sourceType: 'adjustment',
    sourceId: null,
    description: 'Goodwill',
    idempotencyKey: null,
    createdDate: '2026-10-16 12:00:00',
  },
  /**
   * Credits/Core/Models/Adapters/CreditHoldAdapter.php, a site's hold as Siren
   * stores it. HoldService.php line 550 builds the placement key.
   */
  hold: {
    id: 51,
    collaboratorId: 4,
    currency: 'STORE_CREDIT',
    amount: 250,
    status: 'active',
    reference: 'hold:woocommerce@property:5:cart-9f2',
    idempotencyKey: 'place:4:STORE_CREDIT:cart-9f2',
    expiresAt: '2026-10-16 12:30:00',
    createdDate: '2026-10-16 12:00:00',
  },
  /** ReleaseCreditHold.php line 91, the hold as Siren now stores it. Status 200. */
  released: {
    id: 51,
    collaboratorId: 4,
    currency: 'STORE_CREDIT',
    amount: 250,
    status: 'released',
    reference: 'hold:woocommerce@property:5:cart-9f2',
    idempotencyKey: 'place:4:STORE_CREDIT:cart-9f2',
    expiresAt: '2026-10-16 12:30:00',
    createdDate: '2026-10-16 12:00:00',
  },
  /** PlaceCreditHold.php line 124. Status 409. */
  holdNoCredit: { error: { message: 'This collaborator has no credit available in that currency.', code: 'hold_no_credit' } },
  /** PlaceCreditHold.php line 112. Status 409. */
  holdTokenInUse: { error: { message: 'Another checkout already holds credit under that token.', code: 'hold_token_in_use' } },
  /** PlaceCreditHold.php line 104. Status 409. */
  holdCurrencyNotAtStore: {
    error: { message: 'This currency is not available at this store.', code: 'hold_currency_not_at_store' },
  },
  /** ReleaseCreditHold.php line 121. Status 404. */
  holdNotFound: { error: 'No credit hold has that id.' },
  /** GetCreditEntries.php line 77, RequireAnyParamMiddleware. Status 400. */
  entriesNeedFilter: requireAnyParam(['collaboratorId', 'idempotencyKey']),
  /** saas/Auth/ConnectorRequestRules.php, a site asking a collaborator for creditBalances. The wording stands in for the rule's. Status 403. */
  fieldNotAllowed: {
    error: {
      message: 'A connected site may not read creditBalances here.',
      code: 'field_not_allowed',
      context: { param: 'fields' },
    },
  },
} as const;

export const MappingAnswers = {
  /** Mappings/Core/Models/Adapters/MappingAdapter.php, a site's link as Cloud stores it. */
  siteRow: { localId: 4, externalId: '17', localType: 'collaborator', externalType: 'wordpress_user@property:5' },
  /** The same adapter, a link in no site's namespace. */
  orgRow: { localId: 4, externalId: 'flo-at-crm', localType: 'collaborator', externalType: 'crm_contact' },
  /** CreateMapping.php line 104. Status 201. */
  created: { localId: 4, externalId: '17', localType: 'collaborator', externalType: 'wordpress_user@property:5' },
  /** CreateMapping.php line 89. Status 409. */
  exists: { error: { message: 'That link already exists.', code: 'mapping_exists' } },
  /** DeleteMappings.php line 125, also when nothing matched. Status 200. */
  deleted: { deleted: true },
  /** saas/Auth/ConnectorRequestRules.php line 1081, a site sending the `user` type. Status 403. */
  userTypeNotAllowed: {
    error: {
      message: 'A connected site may not use the user type, which names a Cloud account. Use wordpress_user.',
      code: 'user_type_not_allowed',
      context: { param: 'externalType' },
    },
  },
} as const;

export const SettingAnswers = {
  /** Configs/Service/Rest/GetSharedConfigs.php lines 40 to 41, the one setting Cloud shares. */
  urlReference: { type: 'collaborator', subtype: 'urlReference', configKey: 'key', value: 'via' },
  /** GetSharedConfigs.php lines 114 to 115, any type but `collaborator`. The validation message stands in for IsOneOf's. Status 400. */
  typeRefused: {
    error: {
      message: 'Validations failed.',
      context: {
        type: 'VALIDATION_FAILED',
        failedValidations: [{ field: 'type', message: 'type must be one of: collaborator.', type: 'INVALID_VALUE', context: [] }],
      },
    },
  },
} as const;

export const ConversionAnswers = {
  /** Conversions/Core/Models/Adapters/ConversionAdapter.php through CreateNewConversion. Status 201. */
  created: {
    id: 61,
    engagementId: 31,
    transactionId: 71,
    obligationId: null,
    status: 'pending',
    type: 'sale',
    dateCreated: '2026-10-16 12:00:00',
    dateModified: '2026-10-16 12:00:00',
    wonZeroReward: 0,
  },
  /** DeleteConversion.php line 120, the first call. The second answers 204 (line 115). */
  softDeleted: {
    id: 61,
    engagementId: 31,
    transactionId: 71,
    obligationId: null,
    status: 'deleted',
    type: 'sale',
    dateCreated: '2026-10-16 12:00:00',
    dateModified: '2026-10-17 08:00:00',
    wonZeroReward: 0,
  },
  /** DeleteConversion.php line 125, the thrown blocker's own message, which this wording stands in for. Status 409. */
  deleteBlocked: { error: 'This conversion cannot be deleted because an obligation it issued has not been cancelled.' },
  /** ConversionBulkAction.php line 141. */
  bulk: { success: true, affected: 2 },
  /** GetConversionTypes.php line 82, Conversions/Core/Models/ConversionType.php, through the registry interceptor. */
  types: registry([
    { id: 'sale', name: 'Sale', supportedIncentives: ['saleTransactionPercentage', 'saleFixedPerTransaction'] },
    { id: 'lead', name: 'Lead', supportedIncentives: [] },
  ]),
} as const;

export const TransactionAnswers = {
  /** Transactions/Core/Models/Adapters/TransactionAdapter.php through CreateTransaction.php line 149. Status 201. */
  created: { id: 71, status: 'complete', dateCreated: '2026-10-16 12:00:00', isTest: 0, opportunityId: null },
  /** CreateTransaction.php line 134. Status 409. */
  bindingExists: { error: 'A transaction is already recorded for this binding.' },
  /** GET /transactions/{id}?fields=id,details, the details field resolver's rows. */
  detailsRecord: {
    id: 71,
    details: [
      { id: 81, transactionId: 71, description: null, type: 'product', name: 'Mug', value: 1200, quantity: 2, units: 'USD' },
      { id: 82, transactionId: 71, description: 'Gift wrap', type: 'fee', name: 'Wrap', value: 300, quantity: 1, units: 'USD' },
    ],
  },
  /** TransactionBulkAction.php line 124. */
  bulk: { success: true, affected: 2 },
  /** CreditCollaborator.php line 151. */
  credited: { success: true, affected: 2 },
  /** CreditCollaborator.php line 133. Status 404. */
  collaboratorNotFound: { error: 'Collaborator not found.' },
  /** GetTransactionSources.php line 81, through the registry interceptor. */
  sources: registry([
    { id: 'wc_order', name: 'WooCommerce order' },
    { id: 'medusa_order', name: 'Medusa order' },
  ]),
} as const;
