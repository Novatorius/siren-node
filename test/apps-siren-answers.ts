import { reply } from './http-fakes';

/*
 * The answers Siren gives on the app routes, shared by
 * test/apps-resource.test.ts and test/cli-commands.test.ts. Each names the
 * Siren file it copies, read on Novatorius/siren `feat/apps` at 1619218d0
 * unless it says otherwise.
 */

export const APP_KEY = 'acme-payouts';
export const APP_REQUEST_ID = 'apr_b79943ff8ca353ce5cf5312bb3fa66c7';

/**
 * An app as the app routes answer it: lib/Apps/Service/Services/AppSerializer.php
 * lines 15 to 30, with `rawKey` and `signingSecret` only on a first declare.
 */
export function appRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 4,
    key: APP_KEY,
    name: 'Acme',
    description: "Siren's example app.",
    status: 'active',
    webhookSubscriptionId: 31,
    apiKeyId: 52,
    dateCreated: '2026-11-16 21:00:00',
    dateModified: '2026-11-16 21:00:00',
    url: 'https://acme.example/siren',
    events: [],
    scopes: [],
    apiKeyPrefix: 'sk_test_0a0a0a0a',
    items: [
      { id: 11, ref: 'app:11', appId: 4, kind: 'postConversionAction', key: 'notify-crm', name: 'Tell the CRM', description: '', settings: {}, status: 'active' },
      {
        id: 12,
        ref: 'app:12',
        appId: 4,
        kind: 'fulfillmentMethod',
        key: 'acme-ledger',
        name: 'Acme ledger',
        description: '',
        settings: { currencies: ['USD'], answerWindowMinutes: 1 },
        status: 'active',
      },
    ],
    ...overrides,
  };
}

/**
 * One row of `GET /apps/requests`, from the exchange contract
 * (docs/architecture/apps-exchange.md on Novatorius/siren `pkt/apps-exchange`
 * at 086615e2a, "The requests list").
 */
export function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_REQUEST_ID,
    appId: 4,
    item: 'app:12',
    kind: 'fulfillmentMethod',
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
   * lib/Apps/Service/Exceptions/AppInUseException.php lines 19 to 35. The
   * code sits in `error.code` and in `context.reason`.
   */
  inUse: (uses: Record<string, number> = { 'app:12': 2 }) =>
    reply(409, {
      error: {
        message: 'Records still select items of "Acme", so it can\'t be deleted. Turn it off instead. Siren then stops calling it and keeps what it already did.',
        code: 'app_in_use',
        context: { reason: 'app_in_use', uses },
      },
    }),
  /**
   * The same 409 while asks are open and nothing selects the items:
   * lib/Apps/Service/Services/AppOpenRequests.php line 15 on `pkt/apps-exchange`
   * at 086615e2a, and its architecture note line 184.
   */
  inUseWithOpenAsks: (openRequests = 2) =>
    reply(409, {
      error: {
        message: 'Records still select items of "Acme", so it can\'t be deleted. Turn it off instead. Siren then stops calling it and keeps what it already did.',
        code: 'app_in_use',
        context: { reason: 'app_in_use', uses: {}, openRequests },
      },
    }),
  /** An app route's older shape, with the code only in `context.reason`. */
  reasonOnly: (reason: string) => reply(409, { error: { message: 'Refused.', context: { reason } } }),
  /** A 409 with no code at all, as RestException gives one. */
  uncoded: () => reply(409, { error: { message: 'Conflict.', context: [] } }),
  /** The answer route's refusals, in `error.code` (exchange contract, "Answering"). */
  alreadyAnswered: () => reply(409, { error: { message: 'This request already has a different answer.', code: 'app_request_already_answered', context: {} } }),
  notResendable: () => reply(409, { error: { message: 'Already answered.', code: 'app_request_not_resendable', context: {} } }),
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
