// The Acme example app's request handling, kept apart from server.mjs so a
// test can drive it with no network. It takes a `Siren` client built with
// the app's own API key, and the app's signing secret.
//
// What it does with each request Siren sends:
//
// - It checks the request with `siren.apps.verifyRequest()`. A request that
//   fails the check gets 400 and nothing else happens.
// - It answers 200 to every request that passes, so Siren counts it
//   received. A repeat of a request already handled gets 200 too, and is
//   not acted on again. A repeat is found by the body's `id`.
// - A tell needs nothing more.
// - An ask is answered with `siren.apps.requests.answer()` after the 200:
//   a fulfillment method's payout is marked paid with the reference
//   `acme-<payoutId>`, and a distribution resolver's pool is divided among
//   its metrics in proportion to each metric's value, in whole minor units.
//   An ask is counted as handled only once its answer is accepted, so a
//   repeat after a failed answer is answered again.
//
// Stub: answers 501 to everything. Packet example-app builds it. The rules
// above are the contract, proved by test/apps-example.test.ts.

/**
 * @param {{ siren: import('@novatorius/siren').Siren, signingSecret: string, log?: (line: string) => void, now?: () => number }} options
 */
export function createAcmeApp(options) {
  void options;
  return {
    /**
     * @param {string | Uint8Array} rawBody
     * @param {Record<string, string | string[] | undefined>} headers
     * @returns {Promise<{ status: number, body: string, answered?: Promise<void> }>}
     */
    async handle(rawBody, headers) {
      void rawBody;
      void headers;
      return { status: 501, body: '{"error":"not built"}' };
    },
  };
}

/**
 * The answer the example gives an ask, or null for a kind it does not answer.
 *
 * @param {{ item: { kind: string }, data: Record<string, unknown> }} request
 * @returns {{ outcome: string, [field: string]: unknown } | null}
 */
export function answerFor(request) {
  void request;
  return null;
}
