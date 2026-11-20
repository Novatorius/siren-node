# apps-answer-handler in the Node SDK: `apps.requestHandler()` and `apps.splitPool()`

Alex's ruling AP-R80 (M88) asks that answering Siren from an app take a few
lines with the SDK, not a page of code. The design is
design/sdk-answer-handler.md in the apps run folder (siren-apps-20261116).
This note covers its sections 3, 4.1 and 6.1 as built here. Node leads, so
the PHP and Python SDKs copy these names and rows.

Read: Siren's feat/apps at 5f1904615 and pkt/apps-c16-2 at f97b42820
(WebhookSignature::headers(), AppRequestEnvelope::build(),
AppDistributionQuestion::unfitness(), AppRewardQuestion::validate(),
AnswerAppRequest.php and the feature contracts fixture
tests/Fixtures/apps-feature-contracts/requests.json). This branch starts from
siren-node's feat/apps at 3e7cbb4 with pkt/apps-c16-2 (e8cadc2) on top, for
the incentive resolver's types. The PHP SDK was not read for this slice,
since it gains the handler on its own branch.

## What changes

| Call or type | Siren route | File |
|---|---|---|
| `siren.apps.requestHandler(options)` | Serves `POST /` at the app's address, then sends `POST /apps/requests/{id}/answer` with the app's key, scope: the app's own key | src/resources/app-request-handler.ts, src/resources/apps.ts |
| `siren.apps.splitPool(pool, weights)` | None | src/resources/app-amounts.ts, src/resources/apps.ts |
| `AppDistributionQuestion`, `AppDistributionMetric`, `AppDistributionAnswer`, `AppFeatureFunctions`, `AppRequestFunction`, `AppEventFunction`, `AppSplitPool`, `AppSplitWeights` | None | src/record-types.ts |
| `AppRequestHandler`, `AppRequestHandlerOptions`, `AppRequestInput`, `AppRequestReply` and the mount types | None | src/resources/app-request-handler.ts, exported from src/index.ts |
| `AppTell<D>` and `AppAsk<D>` | None | src/record-types.ts. `D` defaults to `Record<string, unknown>`, so existing code compiles. |

openapi.yaml does not change, since the handler sends only the answer route,
which it already describes.

## Class roles

- `createAppRequestHandler()` builds a callable object with `on`, `onEvent`,
  `handle` and `fastify`. Its core is one function, `respond()`, which every
  mount calls with the method, the headers and a way to read the body.
- `checkSignedDelivery()` and `appRequestFrom()` in app-requests.ts are
  `verifyRequest`'s checks, split out so the handler runs the very same code.
  `verifyRequest` now calls them and behaves as before.
- `webhookEventFrom()` in webhooks.ts is `constructEvent`'s reading of an
  event, split out the same way.
- `answerAppRequest()` gains a `retriable` argument, true only from the
  handler. It sends through `writeRecordResent()` in record-requests.ts.
  `apps.requests.answer()` still sends once.

## What the handler does with one request

Every reply is JSON with `Cache-Control: no-store`. No reply holds the
secret or the request body.

| Case | Reply | What happens next |
|---|---|---|
| The method is not POST | 405, with `Allow: POST` | Nothing. |
| No body bytes it can check, because a parser already turned them into an object | 500 | `onError` gets a `SirenError` that says to mount the handler before the JSON body parser, or to give the route a raw body. The reply carries the same words, which Siren's delivery history shows. |
| A body past 1 MiB, read by the handler itself | 413 | Nothing. Siren sends far less, since an answer is 16 KB and a question holds at most 500 metrics. |
| `X-Siren-Signature-V2` missing or wrong, `X-Siren-Timestamp` other than the signed time, or the time more than `toleranceSeconds` from the clock | 401 with `verifyRequest`'s words | The checks are `checkSignedDelivery()`, in `verifyRequest`'s order. |
| The signed body is not JSON, or `X-Siren-Event` is `app.request` (or missing) and the body is not an envelope of version 1 | 400 | Nothing. |
| A tell with a function | 200 `{}` once the function returns, 500 when it throws | `onError` gets a thrown error and the request. |
| An ask with a function | 200 `{}` at once | The function runs after the reply. Its answer is posted as below. `undefined` posts nothing. |
| An app request with no function for its kind and key | 404 `No function handles <kind> <key>.` | Siren sends it again, then shows it under Needs attention. |
| Another event with an `onEvent` function | 200 once it returns, 500 when it throws | Events are checked as requests are, the time window included. |
| Another event with no function | 200 `{}` | Nothing. |

`on(kind, key, fn)` wins over `on(kind, fn)` for its own key. Naming the same
feature, kind or event twice throws `SirenError`, so a copy and paste slip
does not silently drop a function. The handler routes by the envelope's
`mode`, so a payout method's ask works with no change.

## How an ask's answer is posted

1. The function's return value goes through `answerAppRequest()`'s checks: a
   plain object, a text `outcome`, at most 16384 bytes of JSON. A bad value
   goes to `onError` as `SirenError`, and nothing is sent.
2. The answer goes to `POST /apps/requests/{id}/answer` with the client's own
   bearer, which must be the app's key.
3. It is sent marked retriable: a lost connection, 429 or 5xx sends the same
   bytes again with the transport's backoff, up to `maxRetries`, plus the one
   resend after a 401 that every call gets. Siren takes the same answer again
   as `duplicate: true`, so the resend is safe.
4. A refusal goes to `onError` as the SDK's typed error and is not resent:
   422 `app_answer_invalid` (`ValidationError`), 409
   `app_request_already_answered` and `app_request_dropped`
   (`ConflictError`), 403 (`PermissionError`) and 404 (`NotFoundError`).
5. When the function throws or nothing lands, Siren sends the ask again
   after `answerBy`, three sends in all. The handler keeps no state.

The work after the reply never rejects, and an `onError` that throws is
caught.

## Mounting it

| Host | Call | Body | The ask's work |
|---|---|---|---|
| node:http | `http.createServer(answers)` | The stream, up to 1 MiB | `setTimeout(work, 0)` after `res.end()` |
| Express, Connect | `app.post('/siren', express.raw({ type: 'application/json' }), answers)` | The Buffer in `req.body`, or the stream when no parser read it | The same |
| Fastify | `fastify.register(answers.fastify, { path: '/siren' })` | A raw Buffer parser for every content type, scoped to the plugin | The same |
| Next.js app route, Bun, Deno, Hono | `export const POST = answers` | `request.arrayBuffer()`, or 500 when `bodyUsed` | A promise nothing awaits |
| Cloudflare Workers | `export default { fetch: answers }` | The same | `ctx.waitUntil()` from the third argument |
| Anything else | `await answers.handle({ method, headers, rawBody })` | `rawBody` as given | The caller runs `after()` |

`runLater`, when given, takes the work on every host instead, so Vercel
passes Next.js's `after`. No web framework is a dependency. Express and
Fastify are dev dependencies for the mount tests only.

## Splitting a pool

`splitPool(pool, weights)` gives each id `floor(steps * weight / total)`
steps, where a step is `10^(scale - decimalPlaces)` stored units and `steps`
is the whole steps in `pool.value`. Whole-number weights split in exact
BigInt arithmetic. Fractional weights split in floats, scaled to at most 1
first, and a last pass takes back one step from the largest share while the
sum passes the pool. When every weight is 0, each id gets
`floor(steps / n)` steps. What rounding leaves stays unpaid, which
`AppDistributionQuestion::unfitness()` rule 9 and
`AppRewardQuestion::validate()` both allow. It refuses with `SirenError` a
pool `value` that is not a safe integer of 0 or more, a currency
`shownAmount` would refuse, weights that are neither an object nor pairs, an
id given twice, and a weight that is negative, not finite or not a number.

## Deliberate differences

- The section 5 samples are JavaScript. In TypeScript under `strict`,
  `new Siren({ apiKey: process.env.SIREN_API_KEY })` does not compile, since
  `SirenOptions` needs a string. `signingSecret` takes `string | undefined`
  and refuses `undefined` when the handler is made, so the handler's own line
  compiles as written.
- `AppSplitWeights` takes a list of any `(string | number)[]`, not only
  tuples, because `metrics.map((m) => [m.metricId, m.score])` infers
  `number[][]` in TypeScript. Each pair is checked at run time.
- The 413 row and the `Allow: POST` header are additions to the design's
  table.

## Tests

- test/apps-request-handler.test.ts: one test or more per row of the table
  and per step of the answer post, with Siren's fixture questions signed with
  the secret of test/fixtures/apps-exchange/signed-request.json at the
  current time. The answer route is `FakeHttpClient`.
- test/apps-request-handler-mounts.test.ts: node:http and Express on
  127.0.0.1, Express behind `express.json()` (the 500), Fastify through
  `inject()`, a Web `Request`, `ctx.waitUntil`, `runLater` and `handle()`.
- test/apps-answer-samples.test.ts: the four section 5 samples in
  test/answer-samples, as written, run against a fake Siren on the global
  fetch. A tell gets its 200, and an ask gets its 200 at once while the fake
  receives the fixture's answer.
- test/apps-split-pool.test.ts: both resolver answers of Siren's fixture,
  dollars, yen, all-zero weights, fractional weights and the refusals.
- test/docs-apps-request-handler.test.ts holds the README's samples equal to
  the sample files and checks the records name each call.
- scripts/mutations/apps-request-handler.json, run with
  `MUTATION_VITEST_ARGS` set to the five files above.

test/fixtures/apps-feature-contracts/requests.json is Siren's fixture copied
byte for byte from pkt/apps-c16-2 at f97b42820. Copy it again when that
branch's fixture changes.

## Left open

- The feature page samples change in Siren in their own lane, once the SDK
  releases that carry the handler are published.
- The handler does not cap a function's time. Siren gives a tell 8 seconds.
