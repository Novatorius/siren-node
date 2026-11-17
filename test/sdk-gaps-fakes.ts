/*
 * Siren Cloud answers for the apps-sdk-gaps slice, written from Siren's
 * source at 20c47873d (main, the reference copy the slice was built
 * against). Each answer names the Cloud file it follows. Paths are under
 * lib/ unless they start with saas/ or tests/.
 *
 * None of these is captured from a live answer, since nothing in this build
 * calls a running Siren. When Cloud moves past 20c47873d, whoever merges it
 * checks the cited files again.
 *
 * Reads that go through a field resolver write dates as ISO 8601 with an
 * offset (Core/Service/Interceptors/ResponseNormalizerInterceptor.php). A
 * model adapter's `toArray` writes `Y-m-d H:i:s` (DateFormatterService), and
 * the normalizer leaves those strings as they are.
 */

/**
 * `GET /payouts/{id}` with no `fields`: the thirteen DEFAULT_FIELDS of
 * Fulfillments/Rest/Service/GetPayoutById.php, resolved by
 * Fulfillments/Core/Listeners/RegisterCorePayoutResolvers.php and
 * Fulfillments/Service/Listeners/RegisterExtendedPayoutResolvers.php.
 * `value` is a whole number (Payout::getValue(): int). `waitingReason` is one
 * of Fulfillments/Core/Enums/PayoutWaitingReasons.php.
 */
export const PayoutAnswers = {
  retrieved: {
    id: 31,
    status: 'unpaid',
    value: 12050,
    currency: 'USD',
    collaboratorId: 42,
    fulfillmentId: 7,
    datePaid: null,
    dateCreated: '2026-11-02T14:00:00+00:00',
    dateModified: '2026-11-03T09:30:00+00:00',
    failureReason: null,
    dateFailed: null,
    waitingReason: 'stripe_account_missing',
    dateWaiting: '2026-11-03T09:30:00+00:00',
  },
  /** With `include: 'extended'`, which adds the collaborator's name and email. */
  extended: {
    id: 31,
    status: 'paid',
    value: 12050,
    currency: 'USD',
    collaboratorId: 42,
    fulfillmentId: 7,
    datePaid: '2026-11-04T10:00:00+00:00',
    dateCreated: '2026-11-02T14:00:00+00:00',
    dateModified: '2026-11-04T10:00:00+00:00',
    failureReason: null,
    dateFailed: null,
    waitingReason: null,
    dateWaiting: null,
    collaboratorName: 'Ada Lovelace',
    collaboratorEmail: 'ada@example.com',
  },
} as const;

/**
 * Fulfillments/Rest/Service/GetFulfillments.php and GetFulfillmentById.php.
 * The default fields are `id`, `status`, `dateCreated` and `dateModified`
 * (Fulfillments/Core/Listeners/RegisterCoreFulfillmentResolvers.php). The
 * extended fields come from
 * Fulfillments/Service/Listeners/RegisterExtendedFulfillmentResolvers.php,
 * where each of `payouts` is Fulfillments/Core/Models/Adapters/PayoutAdapter.php
 * `toArray` plus `collaboratorName`, so its dates are `Y-m-d H:i:s`.
 */
export const FulfillmentAnswers = {
  listed: {
    id: 7,
    status: 'pending',
    dateCreated: '2026-11-02T14:00:00+00:00',
    dateModified: '2026-11-02T14:00:00+00:00',
  },
  retrieved: {
    id: 7,
    status: 'pending',
    dateCreated: '2026-11-02T14:00:00+00:00',
    dateModified: '2026-11-02T14:00:00+00:00',
  },
  /** `include: 'extended'` on GetFulfillmentById, which adds the seven extended fields. */
  extended: {
    id: 7,
    status: 'pending',
    dateCreated: '2026-11-02T14:00:00+00:00',
    dateModified: '2026-11-02T14:00:00+00:00',
    payoutCount: 2,
    paidCount: 1,
    unpaidCount: 1,
    failedCount: 0,
    totalValue: 22050,
    currency: 'USD',
    payouts: [
      {
        id: 31,
        dateCreated: '2026-11-02 14:00:00',
        dateModified: '2026-11-04 10:00:00',
        value: 12050,
        status: 'paid',
        currency: 'USD',
        collaboratorId: 42,
        fulfillmentId: 7,
        datePaid: '2026-11-04 10:00:00',
        failureReason: null,
        dateFailed: null,
        waitingReason: null,
        dateWaiting: null,
        collaboratorName: 'Ada Lovelace',
      },
      {
        id: 32,
        dateCreated: '2026-11-02 14:00:00',
        dateModified: '2026-11-02 14:00:00',
        value: 10000,
        status: 'unpaid',
        currency: 'USD',
        collaboratorId: 43,
        fulfillmentId: 7,
        datePaid: null,
        failureReason: null,
        dateFailed: null,
        waitingReason: null,
        dateWaiting: null,
        collaboratorName: 'Grace Hopper',
      },
    ],
  },
} as const;

/**
 * Webhooks/Service/Rest. A subscription is
 * Webhooks/Core/Models/Adapters/WebhookSubscriptionAdapter.php `toArray`,
 * which leaves out the signing secret. A delivery is
 * Webhooks/Core/Models/Adapters/WebhookDeliveryAdapter.php `toArray`, with
 * `payload` decoded to an object and `responseBody` cut to 200 bytes. The
 * test answer is Webhooks/Service/Services/WebhookTestSender.php `send`
 * plus `eventType` from WebhookSubscriptionTester.php.
 */
export const WebhookAnswers = {
  /** GetWebhookSubscription.php, status 200. */
  subscription: {
    id: 12,
    targetUrl: 'https://hooks.example.com/siren',
    urlValid: true,
    urlProblem: null,
    events: ['payout.paid', 'payout.failed'],
    status: 'active',
    description: 'Payouts to the ledger',
    propertyId: null,
    oauthClientId: null,
    // Every subscription names its app, or null (captures webhooks-retrieve-200-app-owned and webhooks-create-201).
    appId: null,
    dateCreated: '2026-11-01 08:00:00',
    dateModified: '2026-11-01 08:00:00',
  },
  /** UpdateWebhookSubscription.php, status 200: the subscription as it now stands. */
  paused: {
    id: 12,
    targetUrl: 'https://hooks.example.com/siren',
    urlValid: true,
    urlProblem: null,
    events: ['payout.paid', 'payout.failed'],
    status: 'paused',
    description: 'Payouts to the ledger',
    propertyId: null,
    oauthClientId: null,
    appId: null,
    dateCreated: '2026-11-01 08:00:00',
    dateModified: '2026-11-16 21:00:00',
  },
  /** SendWebhookTest.php, status 200, when the endpoint answered 2xx. */
  testDelivered: { delivered: true, httpStatus: 200, error: null, eventType: 'webhook.test' },
  /** SendWebhookTest.php, status 200, when the endpoint answered 500. Siren still answers 200. */
  testFailed: { delivered: false, httpStatus: 500, error: null, eventType: 'webhook.test' },
  /** WebhookSubscriptionTester.php line 62, raised by SendWebhookTest.php as a RestException. Status 409. */
  testPaused: { error: { message: 'This webhook is paused. Resume it, then send a test.', context: [] } },
  /** ListWebhookDeliveries.php, status 200: a bare array, newest first, at most 50. */
  deliveries: [
    {
      id: 902,
      webhookSubscriptionId: 12,
      eventType: 'webhook.test',
      eventId: 'evt_8a3f1b2c4d5e6f7890abcdef12345678',
      payload: {
        test: true,
        webhookId: 12,
        message: 'A test delivery from Siren. Real events carry the same headers and signature.',
      },
      status: 'delivered',
      attemptCount: 1,
      httpStatusCode: 200,
      responseBody: 'ok',
      errorMessage: null,
      nextRetryAt: null,
      deliveredAt: '2026-11-16 21:05:00',
      dateCreated: '2026-11-16 21:05:00',
      dateModified: '2026-11-16 21:05:00',
    },
    {
      id: 901,
      webhookSubscriptionId: 12,
      eventType: 'payout.paid',
      eventId: 'evt_11112222333344445555666677778888',
      payload: { payoutId: 31, value: 12050, currency: 'USD' },
      status: 'failed',
      attemptCount: 2,
      httpStatusCode: 502,
      responseBody: 'Bad gateway',
      errorMessage: 'HTTP 502',
      nextRetryAt: '2026-11-16 21:07:00',
      deliveredAt: null,
      dateCreated: '2026-11-16 21:04:00',
      dateModified: '2026-11-16 21:05:00',
    },
  ],
  /** Every webhook read and write, for an id the organization does not have. RestException, status 404. */
  notFound: { error: { message: 'Webhook subscription not found.', context: [] } },
} as const;
