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
//   not acted on again. A repeat is found by the body's `id`, which the
//   signature covers, never by the unsigned `Idempotency-Key` header.
// - A tell needs nothing more.
// - An ask gets its 200 at once, and its answer goes to
//   `siren.apps.requests.answer()` without holding up the 200:
//   a fulfillment method's payout is marked paid with the reference
//   `acme-<payoutId>`, and a distribution resolver's pool is divided among
//   its metrics in proportion to each metric's value, in whole minor units.
//   An ask is counted as handled only once its answer is accepted, so a
//   repeat after a failed answer is answered again.
// - An ask it cannot answer, such as a pool with no metrics, gets 500 and a
//   logged line that says why, and no guessed answer. Siren sends it again
//   on its deadline, and then shows it as needing attention.
//
// It keeps the ids it handled in memory, so a restart forgets them. A real
// app keeps them in its own store, beside whatever it did for each request.

/**
 * @param {{ siren: import('@novatorius/siren').Siren, signingSecret: string, log?: (line: string) => void, now?: () => number }} options
 */
export function createAcmeApp({ siren, signingSecret, log = () => {}, now }) {
  /** Ids of the requests acted on, and of the asks whose answer Siren accepted. */
  const handled = new Set();
  /** The answer in flight for each ask, so a repeat that arrives meanwhile waits for it. */
  const answering = new Map();
  const received = JSON.stringify({ received: true });

  return {
    /**
     * @param {string | Uint8Array} rawBody
     * @param {Record<string, string | string[] | undefined>} headers
     * @returns {Promise<{ status: number, body: string, answered?: Promise<void> }>}
     */
    async handle(rawBody, headers) {
      let request;
      try {
        request = siren.apps.verifyRequest(rawBody, headers, signingSecret, now === undefined ? {} : { now: now() });
      } catch (error) {
        log(`Refused a request: ${error.message}`);
        return { status: 400, body: JSON.stringify({ error: 'unverified' }) };
      }

      if (handled.has(request.id)) return { status: 200, body: received };
      if (answering.has(request.id)) return { status: 200, body: received, answered: answering.get(request.id) };

      if (request.mode === 'tell') {
        handled.add(request.id);
        log(`${request.id}: told about ${request.item.key} (${request.item.kind}): ${JSON.stringify(request.data)}`);
        return { status: 200, body: received };
      }

      let answer;
      try {
        answer = answerFor(request);
      } catch (error) {
        log(`${request.id}: cannot answer this ask, so it gets 500 and no answer: ${error.message}`);
        return { status: 500, body: JSON.stringify({ error: 'unanswerable' }) };
      }
      if (answer === null) {
        log(`${request.id}: no answer for an ask on ${request.item.kind}.`);
        return { status: 200, body: received };
      }

      const answered = siren.apps.requests.answer(request.id, answer).then(
        (receipt) => {
          handled.add(request.id);
          log(`${request.id}: answered ${JSON.stringify(answer)}${receipt.duplicate ? ', which Siren already had' : ''}.`);
        },
        (error) => log(`${request.id}: could not answer, and will answer again when Siren sends it again: ${error.message}`),
      ).finally(() => answering.delete(request.id));
      answering.set(request.id, answered);
      return { status: 200, body: received, answered };
    },
  };
}

/**
 * A node:http request listener that hands each request's body and headers
 * to `app.handle()`. Anything the handler throws gets 500 and a logged
 * line, and the server keeps serving the next request.
 *
 * @param {{ handle(rawBody: Uint8Array, headers: Record<string, string | string[] | undefined>): Promise<{ status: number, body: string }> }} app
 * @param {(line: string) => void} log
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestListener(app, log) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      app.handle(Buffer.concat(chunks), req.headers).then(
        (reply) => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(reply.body);
        },
        (error) => {
          log(`Could not handle a request, and answered 500: ${error.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed' }));
        },
      );
    });
  };
}

/**
 * The answer the example gives an ask, or null for a kind it does not
 * answer. Throws, naming the field, for an ask whose data lacks what the
 * answer needs, so the example never answers with a guess.
 *
 * @param {{ item: { kind: string }, data: Record<string, unknown> }} request
 * @returns {{ outcome: string, [field: string]: unknown } | null}
 */
export function answerFor(request) {
  const { data } = request;
  if (request.item.kind === 'fulfillmentMethod') {
    if (typeof data.payoutId !== 'number' && typeof data.payoutId !== 'string') throw new Error('a payout ask needs data.payoutId.');
    return { outcome: 'paid', reference: `acme-${data.payoutId}` };
  }
  if (request.item.kind === 'distributionResolver') {
    if (!Number.isSafeInteger(Number(data.amount)) || !Array.isArray(data.metrics) || data.metrics.length === 0) {
      throw new Error('a pool ask needs data.amount in whole minor units and a list of data.metrics.');
    }
    return { outcome: 'resolved', shares: split(Number(data.amount), data.metrics) };
  }
  return null;
}

/**
 * Divides `amount` minor units among the metrics in proportion to each
 * metric's value, rounding each share down, then giving the units left over
 * one each to the shares with the largest fractions, the first metric first
 * on a tie. When every value is 0, each metric weighs the same.
 *
 * @param {number} amount
 * @param {Array<{ id: string, value: number }>} metrics
 * @returns {Array<{ id: string, amount: number }>}
 */
function split(amount, metrics) {
  const total = metrics.reduce((sum, metric) => sum + metric.value, 0);
  const weights = metrics.map((metric) => (total > 0 ? metric.value : 1));
  const weightTotal = total > 0 ? total : metrics.length;
  const exact = weights.map((weight) => (amount * weight) / weightTotal);
  const shares = exact.map(Math.floor);
  let left = amount - shares.reduce((sum, share) => sum + share, 0);
  const byFraction = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }));
  byFraction.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of byFraction) {
    if (left <= 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return metrics.map((metric, index) => ({ id: metric.id, amount: shares[index] }));
}
