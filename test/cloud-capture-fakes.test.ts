import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { ConflictError, appErrorCode } from '../src/errors';
import type { HttpResponse } from '../src/http';
import { AppAnswers, ConfirmationAnswers, appRecord } from './apps-siren-answers';
import { capture, captureNames, capturedReply } from './cloud-captures';
import { AuthAnswers } from './cli-fakes';
import { ConnectAnswers } from './connect-fakes';
import { CloudAnswers, FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';
import { WebhookAnswers } from './sdk-gaps-fakes';

/*
 * The hand-written fakes for the apps-cli routes, held against what a real
 * Siren Cloud answered (test/fixtures/cloud-captures, from Novatorius/siren
 * feat/apps at 1557b0030, and at 57999d085 for the second run's captures,
 * whose `cloud` field says so). A fake must carry the same fields, at every
 * depth, as the capture of the same route and case. Values may differ, since
 * ids and names are made up.
 *
 * Every capture is either held against a fake here, replayed as it is by a
 * test, or listed with the reason it has no fake.
 */

/** The field names at every depth, with the first element standing for an array. */
function fields(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return [`${at}[]`, ...(value.length === 0 ? [] : fields(value[0], `${at}[]`))];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => [`${at}.${key}`, ...fields(inner, `${at}.${key}`)]).sort();
}

function body(response: HttpResponse | unknown): unknown {
  if (response !== null && typeof response === 'object' && 'status' in response && 'body' in response && typeof (response as HttpResponse).status === 'number') {
    const text = (response as HttpResponse).body;
    return typeof text === 'string' && text !== '' ? JSON.parse(text) : text;
  }
  return response;
}

/**
 * The app fake in the shape Siren answered before an app owned its parts:
 * `apiKeyId` and `webhookSubscriptionId` in place of `source`, `apiKey`,
 * `address` and `eventsAccess`, no plan fields on a feature, and the
 * features under `items`, the name Siren used before the feature rename.
 * Every capture here predates Siren's int/preview-apps (a22547327), so each
 * is held against this shape. No Cloud run has captured the new shape yet, and
 * test/apps-siren-answers.ts names the Siren tests the new fake copies.
 */
function beforeOwnParts(overrides: Record<string, unknown> = {}) {
  const { source: _s, apiKey: _k, address: _a, eventsAccess: _e, features, ...rest } = appRecord(overrides);
  const oldItems = (features as Array<Record<string, unknown>>).map(
    ({ entitled: _en, requiredCapability: _rc, requiredPlan: _rp, ...feature }) => feature,
  );
  return { ...rest, webhookSubscriptionId: 31, apiKeyId: 52, items: oldItems };
}

/**
 * The app fake as Siren sent it at 1557b0030, before AppSerializer added
 * `needsAttention`, for the captures taken then.
 */
function before27169452a(overrides: Record<string, unknown> = {}) {
  const { needsAttention: _, ...app } = beforeOwnParts(overrides);
  return app;
}

/** Each fake, by the capture of the same route and case. */
const HELD: Record<string, () => unknown> = {
  'auth-signup-options-sandbox': AuthAnswers.sandbox,
  'auth-signup-options-production': AuthAnswers.production,
  'auth-register-org-201': AuthAnswers.registered,
  'auth-register-org-signup-off': ConfirmationAnswers.signupOff,
  'auth-login-200': AuthAnswers.oneOrg,
  'auth-login-401-wrong-password': AuthAnswers.wrongPassword,
  'auth-refresh-200': () => AuthAnswers.tokens(),
  'auth-refresh-401': AuthAnswers.refreshRefused,
  'auth-memberships-200': AuthAnswers.memberships,
  'auth-logout-200': AuthAnswers.loggedOut,
  'apps-retrieve-200': () => before27169452a(),
  'apps-list-200': () => [before27169452a()],
  'apps-status-200-active': () => before27169452a(),
  'apps-status-200-inactive': () => before27169452a({ status: 'inactive' }),
  'apps-declare-200-update': () => before27169452a(),
  'apps-declare-200-changed-items': () => before27169452a(),
  'apps-declare-201-first': () => before27169452a({ rawKey: 'k', signingSecret: 's' }),
  'apps-rotate-200': () => before27169452a({ rawKey: 'k', signingSecret: 's' }),
  'apps-rotate-200-production-edition': () => before27169452a({ rawKey: 'k', signingSecret: 's' }),
  'apps-retrieve-200-with-count': () => beforeOwnParts(),
  'apps-list-200-with-counts': () => [beforeOwnParts()],
  'apps-list-200-count-1': () => [beforeOwnParts({ needsAttention: 1 })],
  'apps-list-after-logout-with-old-access-token': () => CloudAnswers.authenticationRequired,
  'webhooks-retrieve-200-app-owned': () => WebhookAnswers.subscription,
  'webhooks-list-200': () => [WebhookAnswers.paused],
  'webhooks-deliveries-200-app-owned': () => WebhookAnswers.deliveries,
  'webhooks-test-200-delivered': () => WebhookAnswers.testDelivered,
  'webhooks-test-200-app-refused': () => WebhookAnswers.testFailed,
  'webhooks-test-409-paused': () => WebhookAnswers.testPaused,
  'ping-200-app-key': () => ConnectAnswers.ping,
};

/** Captures a test replays as they are, so no fake can drift from them. */
const REPLAYED: Record<string, string> = {
  'apps-answer-401-no-bearer': 'test/apps-resource.test.ts, the uncoded 401',
  'apps-answer-401-unknown-key': 'test/apps-resource.test.ts, the uncoded 401',
  'apps-list-401-app-key': 'test/apps-resource.test.ts, the uncoded 401',
  'events-site-visited-200': 'test/apps-example.test.ts, the sale',
  'events-sale-200-no-program': 'test/apps-example.test.ts, the sale',
  'auth-signup-options-sandbox': 'test/cli-loopback.ts, the fake Cloud',
  'auth-signup-options-production': 'test/cli-loopback.ts, the fake Cloud',
  'auth-login-200': 'test/cli-loopback.ts, the fake Cloud',
  'apps-list-200': 'test/cli-loopback.ts, the fake Cloud',
  'auth-logout-200': 'test/cli-loopback.ts, the fake Cloud',
  'webhooks-delete-409-app-owned': 'this file, the app-owned subscription',
  'webhooks-update-409-app-owned': 'this file, the app-owned subscription',
  'apps-declare-200-dropped-selected-item': 'test/cli-apps-followups.test.ts, the archived item',
  'apps-request-one-200-needs-attention': 'test/apps-request-retrieve.test.ts and test/cli-apps-followups.test.ts, one request',
  'apps-delete-409-in-use': 'test/cli-apps-followups.test.ts, a delete records still hold',
  'apps-resend-409-app-off': 'test/cli-apps-followups.test.ts, a resend while the app is off',
  'apps-request-one-404': 'test/apps-request-retrieve.test.ts and test/cli-apps-followups.test.ts, a request the organization does not have',
};

/**
 * Captures with no fake of their own, and why. Each refusal here comes in
 * Siren's error envelope, which the transport reads the same way for every
 * route, so the error tests' generic bodies stand for them.
 */
const UNFAKED: Record<string, string> = {
  'api-keys-create-201': 'Made an org key for the checkpoint. The apps tests never make one.',
  'apps-answer-404-admin': 'app_request_not_found as Siren worded it for everyone at 1557b0030. At 27169452a an admin gets "This organization has no request with this key." (AppAnswers.notFound, held in test/apps-siren-quotes.test.ts).',
  'apps-answer-404-app-key': 'The same body as apps-answer-404-admin.',
  'apps-answer-404-over-16kb-unknown-id': 'The same body: Siren looks the id up before it reads the size.',
  'apps-answer-404-plain-org-key': 'The same body: an org key that is no app\'s.',
  'apps-answer-422-not-object-admin': 'app_answer_invalid, which the answer refusal table fakes with a generic message.',
  'apps-answer-422-not-object-app-key': 'The same body as apps-answer-422-not-object-admin.',
  'apps-declare-400-http-url': 'A RestException 400 with context.field. The CLI prints Siren\'s message, as for any 400.',
  'apps-declare-400-unresolvable-url': 'The same envelope as apps-declare-400-http-url.',
  'apps-delete-200': '{"success":true}, which the delete tests already send.',
  'apps-request-one-404-no-route': 'Siren had no GET /apps/requests/{id} at 1557b0030. It has GET /apps/requests/{requestKey} since, which apps-request-one-200-needs-attention and apps-request-one-404 record.',
  'apps-requests-list-400-bad-status': 'VALIDATION_FAILED, which the SDK refuses before sending for any status it does not know.',
  'apps-requests-list-401-app-key': 'api_key_not_accepted, the same body as apps-list-401-app-key.',
  'apps-requests-list-attention-empty': '{"requests":[]}. No capture holds a request row, since no ask ran.',
  'apps-requests-list-empty': 'The same body as apps-requests-list-attention-empty.',
  'apps-resend-401-app-key': 'api_key_not_accepted, the same body as apps-list-401-app-key.',
  'apps-resend-404': 'app_request_not_found with context.reason, which appErrorCode reads either way.',
  'apps-retrieve-404': 'A RestException 404 with no code, which the transport raises as NotFoundError.',
  'apps-retrieve-404-after-delete': 'The same body as apps-retrieve-404.',
  'auth-login-200-production': 'The same body as auth-login-200.',
  'auth-register-org-409-existing-email': 'A bare string error, which the sign-up tests print as Siren sent it.',
  'ping-401-revoked-app-key': 'A RestException 401 with no code.',
  'webhook-test-delivery-received-by-a-plain-subscription': 'A delivery Siren sent to a receiver, not an answer to the SDK. Its secret was not kept, so no test can check its signature.',
  'webhooks-create-201': 'A plain subscription the checkpoint made. Its fields are those of webhooks-retrieve-200-app-owned plus signingSecret.',
};

describe('apps-cli: the fakes carry the fields a real Siren Cloud sends', () => {
  for (const [name, fake] of Object.entries(HELD)) {
    it(`${name}`, () => {
      const captured = capture(name).response.body;
      const faked = body(fake());
      expect(fields(faked), name).toEqual(fields(captured));
    });
  }

  it('accounts for every capture', () => {
    const accounted = new Set([...Object.keys(HELD), ...Object.keys(REPLAYED), ...Object.keys(UNFAKED)]);
    expect(captureNames().filter((name) => !accounted.has(name))).toEqual([]);
    expect([...accounted].filter((name) => !captureNames().includes(name))).toEqual([]);
  });

  it('raises the refusal to change an app-owned subscription as ConflictError with its code and Siren\'s message', async () => {
    for (const [name, call] of [
      ['webhooks-delete-409-app-owned', (siren: Siren) => siren.webhooks.subscriptions.delete(1)],
      ['webhooks-update-409-app-owned', (siren: Siren) => siren.webhooks.subscriptions.update(1, { description: 'x' })],
    ] as const) {
      const siren = new Siren({ apiKey: 'made-up-key', baseUrl: BASE, httpClient: new FakeHttpClient([capturedReply(name)]) });
      const error = await call(siren).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error, name).toBeInstanceOf(ConflictError);
      expect(appErrorCode(error), name).toBe('app_owned_subscription');
      expect((error as Error).message).toBe('App 1 owns this webhook, so it changes only when the app is declared again.');
    }
  });

  it('keeps the answer refusals in the envelope Siren sends', () => {
    for (const refusal of [AppAnswers.alreadyAnswered(), AppAnswers.notNeedingAttention()]) {
      expect(fields(body(refusal))).toEqual(fields(capture('apps-answer-404-admin').response.body));
    }
  });
});
