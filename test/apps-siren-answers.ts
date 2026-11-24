import { reply } from './http-fakes';
import { capturedReply } from './cloud-captures';

/*
 * The answers Siren gives on the app routes, shared by
 * test/apps-resource.test.ts and test/cli-commands.test.ts. Each names the
 * Siren file it copies, read on Novatorius/siren `feat/apps` at 1619218d0
 * unless it says otherwise.
 */

export const APP_KEY = 'acme-payouts';
export const APP_REQUEST_ID = 'apr_b79943ff8ca353ce5cf5312bb3fa66c7';

/**
 * The plan fields Siren's AppPlanAccess gives a feature and an app's events
 * (lib/Apps/Service/Services/AppPlanAccess.php on Novatorius/siren
 * `int/preview-apps` at a22547327). `usable` is Pro, or no plan claim.
 * `needsPro` is what an outward kind and the events read on Plus, as
 * tests/Integration/Tests/AppsOutIsProFlowTest.php `everyPlan()` lines 397
 * to 413 pin it.
 */
export const PlanFields = {
  usable: () => ({ entitled: true, requiredCapability: null, requiredPlan: null }),
  needsPro: () => ({ entitled: false, requiredCapability: 'outbound-apps', requiredPlan: 'pro' }),
};

/**
 * An app as the app routes answer it on Siren's `int/preview-apps` at
 * a22547327: lib/Apps/Service/Services/AppSerializer.php `toArray()` lines
 * 54 to 69, with `source`, `apiKey` as `key()` gives it (lines 86 to 97) and
 * `address` as `address()` gives it (lines 103 to 112), `eventsAccess`, and
 * no `apiKeyId` or `webhookSubscriptionId`, which
 * tests/Integration/Tests/AppsOwnPartsFlowTest.php
 * `test_a_first_declaration_makes_parts_that_point_at_the_app` (lines 153 to
 * 163) and `test_the_last_write_wins_and_the_answer_holds_what_a_file_declares`
 * (lines 499 to 505) pin. Each item as AppItemAdapter.php `toArray()` (lines
 * 40 to 55) gives it, with the plan fields AppSerializer `item()` adds (line
 * 78). The payout kind is `payoutMethod`, as
 * `test_the_payout_kind_is_stored_as_the_docs_word` (lines 1302 to 1314)
 * pins. `rawKey` and `signingSecret` sit only on the answer of the route that
 * made them.
 */
export function appRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 4,
    key: APP_KEY,
    name: 'Acme',
    description: "Siren's example app.",
    status: 'active',
    source: 'code',
    dateCreated: '2026-11-16 21:00:00',
    dateModified: '2026-11-16 21:00:00',
    url: 'https://acme.example/siren',
    events: [],
    scopes: [],
    apiKeyPrefix: 'sk_test_0a0a0a0a',
    apiKey: {
      id: 52,
      prefix: 'sk_test_0a0a0a0a',
      lastFour: '0a0a',
      scopes: [],
      propertyId: null,
      lastUsedAt: null,
      dateCreated: '2026-11-16 21:00:00',
    },
    address: { id: 31, url: 'https://acme.example/siren', events: [], status: 'active', dateCreated: '2026-11-16 21:00:00' },
    features: [
      {
        id: 11,
        ref: 'app:11',
        appId: 4,
        kind: 'postConversionAction',
        key: 'notify-crm',
        name: 'Tell the CRM',
        description: '',
        settings: {},
        status: 'active',
        dateCreated: '2026-11-16 21:00:00',
        dateModified: '2026-11-16 21:00:00',
        ...PlanFields.usable(),
      },
      {
        id: 12,
        ref: 'app:12',
        appId: 4,
        kind: 'payoutMethod',
        key: 'acme-ledger',
        name: 'Acme ledger',
        description: '',
        settings: { currencies: ['USD'], answerWindowMinutes: 1 },
        status: 'active',
        dateCreated: '2026-11-16 21:00:00',
        dateModified: '2026-11-16 21:00:00',
        ...PlanFields.usable(),
      },
    ],
    eventsAccess: PlanFields.usable(),
    needsAttention: 0,
    ...overrides,
  };
}

/**
 * One feature as its own routes answer it: AppSerializer `item()` and
 * `uses` and `usedBy` (AddAppItem.php, GetAppItem.php, EditAppItem.php,
 * `page()`). `usedBy` holds `{record, id}`, an autofulfiller known by its
 * currency, as AppsOwnPartsFlowTest.php
 * `test_the_item_routes_add_read_change_and_remove_one_item` (lines 1102 to
 * 1117) pins.
 */
export function itemPage(overrides: Record<string, unknown> = {}) {
  return {
    ...(appRecord().features[1] as Record<string, unknown>),
    uses: 1,
    usedBy: [{ record: 'autofulfiller', id: 'USD' }],
    ...overrides,
  };
}

/**
 * One kind as `GET /apps/kinds` answers it on Plus: AppItemKindCatalog
 * `entries()` (lib/Apps/Core/Enums/AppItemKindCatalog.php lines 301 to 319
 * on `int/preview-apps` at a22547327), `direction` from `direction()`, and
 * the plan fields an outward kind reads on Plus (AppsOutIsProFlowTest.php
 * lines 400 to 412).
 */
export function payoutKind(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'payoutMethod',
    term: 'payout method',
    name: 'Payout method',
    description: 'Siren asks the app to pay a payout, in the currencies it names, when an autofulfiller picks this method.',
    mode: 'ask',
    direction: 'out',
    aliases: ['autofulfiller', 'fulfillment method'],
    docs: '/documentation/resource-reference/autofulfillers',
    settings: [
      {
        field: 'currencies',
        label: 'Currencies',
        type: 'currencies',
        required: true,
        help: 'The currencies the app can pay in. An autofulfiller sets the method for one of them.',
      },
      {
        field: 'answerWindowMinutes',
        label: 'Answer window',
        type: 'integer',
        required: false,
        min: 1,
        max: 43200,
        help: 'How many minutes Siren waits for the app to answer before the request needs a person.',
      },
    ],
    ...PlanFields.needsPro(),
    ...overrides,
  };
}

/**
 * Siren's refusals of a change to an app's parts, as
 * lib/Apps/Service/Exceptions/AppPartRefusedException.php on
 * `int/preview-apps` at a22547327 builds them: the code in `error.code` and
 * `context.reason`. The messages are AppsOwnPartsFlowTest.php line 1244 for
 * the key that exists and line 1208 for the missing address.
 */
export const PartAnswers = {
  keyExists: () =>
    reply(409, {
      error: { message: 'The app "acme-payouts" already has a key. Rotate it to get a new one.', code: 'app_key_exists', context: { reason: 'app_key_exists' } },
    }),
  /** AppPartRefusedException::keyMissing() on Siren's feat/apps at c8dbb1ab3, for a rotate or revoke on an app with no key. */
  keyMissing: () =>
    reply(409, {
      error: { message: 'The app "acme-payouts" has no key. Add one first.', code: 'app_key_missing', context: { reason: 'app_key_missing', app: 'acme-payouts' } },
    }),
  /** AppPartRefusedException::addressMissing() on Siren's feat/apps at c8dbb1ab3, for a secret rotation on an app with no address. */
  addressMissing: () =>
    reply(409, {
      error: {
        message: 'The app "acme-payouts" has no address. Give it one first.',
        code: 'app_address_missing',
        context: { reason: 'app_address_missing', app: 'acme-payouts' },
      },
    }),
  itemsNeedKeyAndAddress: () =>
    reply(409, {
      error: {
        message:
          'An app with features needs a key and an address, and "acme-payouts" would lack an address. Siren asks the app at its address, and the app answers with its key.',
        code: 'app_features_need_key_and_address',
        context: { reason: 'app_features_need_key_and_address', missing: ['address'] },
      },
    }),
};

/**
 * One row of `GET /apps/requests`, from the exchange contract
 * (docs/architecture/apps-exchange.md on Novatorius/siren `pkt/apps-exchange`
 * at 086615e2a, "The requests list").
 */
export function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_REQUEST_ID,
    appId: 4,
    feature: 'app:12',
    kind: 'payoutMethod',
    mode: 'ask',
    subject: { type: 'payout', id: '88' },
    status: 'sent',
    sendCount: 1,
    answerBy: '2026-11-18T09:14:03+00:00',
    answeredBy: null,
    answeredAt: null,
    lastError: null,
    createdAt: '2026-11-17T09:14:03+00:00',
    ...overrides,
  };
}

export const AppAnswers = {
  /**
   * 409 on a delete while records select the app's items:
   * lib/Apps/Service/Exceptions/AppInUseException.php lines 30 to 50 on
   * `feat/apps` at 27169452a, which always sends `openRequests`. The code
   * sits in `error.code` and in `context.reason`.
   */
  inUse: (uses: Record<string, number> = { 'app:12': 2 }) =>
    reply(409, {
      error: {
        message: 'Records still select items of "Acme", so it can\'t be deleted. Turn it off instead. Siren then stops calling it and keeps what it already did.',
        code: 'app_in_use',
        context: { reason: 'app_in_use', uses, openRequests: 0 },
      },
    }),
  /**
   * The same 409 while asks are open and nothing selects the items:
   * AppInUseException.php lines 41 to 47 on `feat/apps` at 27169452a word
   * it for the open asks, and `uses` is an empty PHP array, which JSON
   * writes as `[]`.
   */
  inUseWithOpenAsks: (openRequests = 2) =>
    reply(409, {
      error: {
        message: `"Acme" still has ${openRequests === 1 ? '1 request' : `${openRequests} requests`} waiting on its answer, so it can't be deleted. It can be deleted once each answer is applied.`,
        code: 'app_in_use',
        context: { reason: 'app_in_use', uses: [], openRequests },
      },
    }),
  /** An app route's older shape, with the code only in `context.reason`. */
  reasonOnly: (reason: string) => reply(409, { error: { message: 'Refused.', context: { reason } } }),
  /** A 409 with no code at all, as RestException gives one. */
  uncoded: () => reply(409, { error: { message: 'Conflict.', context: [] } }),
  /**
   * The answer route's refusal of a different answer, in `error.code`:
   * lib/Apps/Service/Services/AppRequestService.php line 642 on `feat/apps`
   * at 27169452a, through AppAnswerResult::refused()
   * (lib/Apps/Core/Models/AppAnswerResult.php line 53), which sends
   * `context` as an empty PHP array, `[]`.
   */
  alreadyAnswered: () =>
    reply(409, {
      error: { message: 'This request already has a different answer, and the first answer stands.', code: 'app_request_already_answered', context: [] },
    }),
  /**
   * The answer route's 404 for a request the caller cannot reach:
   * AppRequestService::notFound() (AppRequestService.php line 698 on
   * `feat/apps` at 27169452a) words it for an admin, whose organization has
   * no such request, and for an app's key, which also covers a request sent
   * to another app. The status and the code are the same for both.
   */
  notFound: (caller: 'admin' | 'app') =>
    reply(404, {
      error: {
        message: caller === 'admin' ? 'This organization has no request with this key.' : 'No request with this key was sent to this app.',
        code: 'app_request_not_found',
        context: [],
      },
    }),
  /**
   * The 404 of the resend route and of `GET /apps/requests/{requestKey}`:
   * AppRequestRefusedException::notFound()
   * (lib/Apps/Service/Exceptions/AppRequestRefusedException.php line 34 on
   * `feat/apps` at 27169452a), with the code in `error.code` and in
   * `context.reason` (capture apps-request-one-404).
   */
  requestNotFound: () =>
    reply(404, { error: { message: 'App request not found.', code: 'app_request_not_found', context: { reason: 'app_request_not_found' } } }),
  /**
   * The answer route's refusal of a person's answer to an ask that does not
   * need attention, such as one `pending` or `sent`, which the app may still
   * answer: AppRequestService::notNeedingAttention()
   * (lib/Apps/Service/Services/AppRequestService.php lines 678 to 686) through
   * AppAnswerResult::refused() (lib/Apps/Core/Models/AppAnswerResult.php
   * lines 51 to 54), on `feat/apps` at 27169452a. Siren checks the
   * status before the answer's fit, so a misfit answer to such an ask gets
   * this 409 too.
   */
  notNeedingAttention: () =>
    reply(409, {
      error: {
        message: 'A person may answer only a request that needs attention. The app may still answer this one.',
        code: 'app_request_not_needing_attention',
        context: [],
      },
    }),
  /** A refusal of the answer route with a code this SDK has never heard of, made up for the test. */
  unknownRefusal: () => reply(409, { error: { message: 'Siren refused this answer for a reason this SDK does not know.', code: 'made_up_refusal_code', context: [] } }),
  /**
   * The resend route's 409 for an `applied` request, or one it would send
   * while its app is off: lib/Apps/Service/Rest/ResendAppRequest.php lines
   * 82 to 87 on `feat/apps` at 27169452a, through AppRequestRefusedException,
   * which puts the code in `context.reason` beside the status. While the app
   * is off the status is the request's own, such as `needs_attention`
   * (capture apps-resend-409-app-off).
   */
  notResendable: (status = 'applied') =>
    reply(409, {
      error: {
        message: 'This request cannot be sent again: it is applied, or its app is off.',
        code: 'app_request_not_resendable',
        context: { reason: 'app_request_not_resendable', status },
      },
    }),
};

/**
 * Currencies as Siren's API describes one, `CurrencyAdapter::toArray()`
 * (lib/Commerce/Adapters/CurrencyAdapter.php lines 25 to 33), which both
 * tells send as `currency`, on Novatorius/siren `feat/apps` at 27169452a.
 */
export const AppCurrencies = {
  /** lib/Configs/Core/Listeners/RegisterCoreCurrencies.php line 26: scale 2, and decimal places default to the scale. */
  usd: () => ({ id: 'USD', symbol: '$', position: 'before', name: 'US Dollar', scale: 2, decimalPlaces: 2, type: 'monetary' }),
  /** RegisterCoreCurrencies.php line 29: yen is stored in hundredths, scale 2, and shown with 0 decimal places. */
  jpy: () => ({ id: 'JPY', symbol: '¥', position: 'before', name: 'Japanese Yen', scale: 2, decimalPlaces: 0, type: 'monetary' }),
  /**
   * A points currency an org defined: StoredCustomCurrencies::toCurrency()
   * (lib/Configs/Service/Datastores/CustomCurrency/StoredCustomCurrencies.php
   * lines 71 to 80) takes its symbol, position, name and scale from the
   * stored row, decimal places from the scale, and type `internal`.
   */
  points: () => ({ id: 'POINTS', symbol: 'pts', position: 'after', name: 'Points', scale: 0, decimalPlaces: 0, type: 'internal' }),
};

/** A currency as the fakes above give one. */
type FakeCurrency = ReturnType<typeof AppCurrencies.usd>;

/**
 * The data of the two tells, as AppActionSubjects builds it
 * (lib/Apps/Service/Services/AppActionSubjects.php, forConversion() lines
 * 128 to 152 and forAllocation() lines 179 to 190, on `feat/apps` at
 * 27169452a). `value` is the stored integer and `currency` is the reward's
 * currency (currencyOf(), lines 202 to 205).
 */
export const AppTells = {
  conversionApproved: (value = 1500, currency: FakeCurrency = AppCurrencies.usd()) => ({
    conversion: { id: 51, type: 'sale', status: 'complete', engagementId: 7, opportunityId: 9, collaboratorId: 4, transactionId: 12, obligationId: 33 },
    reward: { value, units: currency.id, currency },
    program: { id: 3, name: 'Partners' },
  }),
  /** A conversion with no reward: `reward` is null (AppActionSubjects.php lines 128 to 137). */
  conversionWithoutReward: () => ({
    conversion: { id: 52, type: 'lead', status: 'complete', engagementId: 8, opportunityId: 9, collaboratorId: 4, transactionId: null, obligationId: null },
    reward: null,
    program: { id: 3, name: 'Partners' },
  }),
  allocationCompleted: (value = 2500, currency: FakeCurrency = AppCurrencies.usd()) => ({
    allocation: { distributionId: 21, obligationId: 40, collaboratorId: 4, status: 'complete', value, units: currency.id, currency },
    distributor: { id: 2, name: 'Partner pool' },
  }),
};

/**
 * Siren's sign-up and sign-in answers about a confirmation or a plan.
 */
export const ConfirmationAnswers = {
  /**
   * register-org when the address must be confirmed first: no tokens, a
   * confirmation token. lib/Users/Core/Services/OrgRegistrationService.php
   * lines 189 to 193.
   */
  registeredUnconfirmed: (org: unknown, user: unknown) =>
    reply(201, { org, user, emailConfirmationRequired: true, confirmationToken: 'confirm-token' }),
  /**
   * register-org with a session whose address waits for confirmation:
   * lib/Users/Service/Services/AuthService.php line 1850, windowPayload().
   */
  registeredPending: (org: unknown, user: unknown, tokens: { accessToken: string; refreshToken: string }, nowS: number) =>
    reply(201, {
      org,
      user,
      ...tokens,
      emailConfirmation: { pending: true, deadline: nowS + 6 * 86400, closesAt: nowS + 14 * 86400, reminded: false, finalWeek: false, daysUntilClosed: 14 },
    }),
  /**
   * login with a session whose address waits for confirmation:
   * lib/Users/Service/Services/AuthService.php line 572, authenticate().
   */
  loginPending: (membership: unknown, user: unknown, tokens: { accessToken: string; refreshToken: string }, nowS: number) =>
    reply(200, {
      ...tokens,
      user,
      memberships: [membership],
      emailConfirmation: { pending: true, deadline: nowS + 6 * 86400, closesAt: nowS + 3 * 86400, reminded: true, finalWeek: true, daysUntilClosed: 3 },
    }),
  /**
   * register-org on a Siren whose SIREN_SAAS_SIGNUP_ENABLED is off: the
   * front controller answers 404 with the error as a bare string before any
   * route runs (saas/public/index.php lines 184 to 190 on pkt/apps-exchange
   * at 651704b75).
   */
  signupOff: () => reply(404, { error: 'Not found.' }),
  /** login for an unconfirmed address: lib/Users/Service/Rest/Login.php lines 171 to 178. */
  loginUnconfirmed: (email: string) =>
    reply(403, { error: { message: 'Confirm your email address first.', code: 'email_unconfirmed', email, confirmationToken: 'confirm-token' } }),
  /**
   * login for an organization with no usable plan: lib/Users/Service/Rest/Login.php
   * lines 159 to 164, with the codes of lib/Users/Service/Exceptions/EntitlementException.php.
   */
  loginNoPlan: (code: 'no_entitlement' | 'entitlement_lapsed' | 'trial_ended' | 'entitlements_unavailable') =>
    reply(401, { error: { message: 'Raw entitlement text.', code } }),
};

/**
 * Siren's answer to `GET /apps/{key}` for a key the organization lacks, as a
 * real Cloud sent it (capture apps-retrieve-404). `siren apps apply` reads
 * the app first, so a first apply meets this before it declares.
 */
export function appMissing() {
  return capturedReply('apps-retrieve-404');
}

/** An app that differs from the example file by its name, so an apply has one change to make. */
export function appBefore(overrides: Record<string, unknown> = {}) {
  return reply(200, appRecord({ name: 'Acme before', ...overrides }));
}
