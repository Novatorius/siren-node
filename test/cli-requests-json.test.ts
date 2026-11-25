import { describe, expect, it } from 'vitest';
import { harness } from './cli-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord, requestRow } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * Coordinator, 2026-11-25: `siren apps requests <id> --json` prints the
 * full request, with its feature key, so the SDKs' replay helpers can read
 * a saved request. Siren's detail names the app by id and the feature as
 * `app:{id}`. The tool adds the app's key and the feature's key from the
 * app list, and the sends it found for the request.
 */

const detail = (over: Record<string, unknown> = {}) =>
  requestRow({ sendCount: 1, data: { payoutId: 88, amount: 2500, currency: 'USD' }, answer: null, answeredByUser: null, ...over });
const send = {
  id: 9,
  eventId: `${APP_REQUEST_ID}.1`,
  eventType: 'app.request',
  status: 'delivered',
  attemptCount: 1,
  httpStatusCode: 200,
  responseBody: '{"received":true}',
  errorMessage: null,
  nextRetryAt: null,
  deliveredAt: '2026-11-17 09:14:04',
  dateCreated: '2026-11-17 09:14:03',
  dateModified: '2026-11-17 09:14:04',
};

describe('siren apps requests <id> --json', () => {
  it("prints Siren's whole request with the app's key, the feature's key and the sends, as one JSON object", async () => {
    const h = harness([reply(200, detail()), reply(200, [appRecord()]), reply(200, [send, { ...send, eventId: 'apr_0123456789abcdef0123456789abcdef.1' }])]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', APP_REQUEST_ID, '--json']), h.err()).toBe(0);
    const printed = JSON.parse(h.out()) as Record<string, unknown>;
    expect(printed).toEqual({
      ...detail(),
      appKey: APP_KEY,
      featureKey: 'acme-ledger',
      sends: [send],
    });
    expect(h.err()).toBe('');
  });

  it('gives null keys and no sends when the app is gone, and still prints the request', async () => {
    const h = harness([reply(200, detail()), reply(200, [])]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', APP_REQUEST_ID, '--json']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ ...detail(), appKey: null, featureKey: null, sends: [] });
  });
});
