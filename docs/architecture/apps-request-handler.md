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
| `DistributionResolverQuestion`, `AppDistributionMetric`, `DistributionResolverAnswer`, `AppFeatureFunctions`, `AppRequestFunction`, `AppEventFunction`, `AppSplitPool`, `AppSplitWeights` | None | src/record-types.ts |
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
| The signed body is not JSON, or `X-Siren-Event` is `app.request` (or missing) and the body is not an envelope of version 1 | 400, naming the first field that breaks its rule | Nothing. |
| An ask whose `answerUrl` origin is another Siren than the client's base | 500 | `onError` gets a `SirenError` with both addresses and the `baseUrl` to set. The function does not run and nothing is posted. |
| A tell with a function | 200 `{}` once the function returns, 500 when it throws | `onError` gets a thrown error and the request. |
| An ask with a function | 200 `{}` at once | The function runs after the reply. Its answer is posted as below. `answers.later()` posts nothing. `undefined` or `null` is an error `onError` gets, and nothing is posted. |
| An app request with no function for its kind and key | 404 `No function handles <kind> <key>.` | Siren sends it again, then shows it under Needs attention. |
| Another event with an `onEvent` function | 200 once it returns, 500 when it throws | Events are checked as requests are, the time window included. |
| Another event with no function | 200 `{}` | Nothing. |

`on()` takes only the 13 kinds Siren sends, `FEATURE_KIND_NAMES` in
app-feature-kinds.ts, and any the `extraKinds` option names. It refuses
another kind when the function is registered, and `featureKindProblem()`
words what to write instead, as `AppHandlerError`. The types take
`FeatureKind` and the extra kinds, so a typo's compile error names
`FeatureKind`. `customEvent` passes the types, since it is a `FeatureKind`,
and the runtime check refuses it, pointing at `events.ingest()`.

`on(kind, key, fn)` wins over `on(kind, fn)` for its own key. Naming the same
feature, kind or event twice throws `AppHandlerError`, a `SirenError`, so a copy and paste slip
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

The default `onError` writes one string through `logger`, `Siren request
handler (<kind> <key> <id>):` or `(<type> <delivery id>):`, then the error's
class, message and code, with a nested cause folded in as "(cause: ...)". A
stack trace follows only when the app's own function threw, which the handler
tracks with a `WeakSet` of the errors its `run()` wrapper caught. For an ask's
work after its 200 it adds when Siren sends the ask again, from `answerBy` in
UTC, and how to resend it sooner (`nextSend()`), before the error, unless Siren
refused with 403, 404 or 409, after which it sends the ask no more. After a 422
`app_answer_invalid` it says instead to reproduce the answer with `simulate()`
and resend, since a resend alone repeats the refused answer. It never writes the
request's data or headers.

## Logging and the two warnings

`logger` takes `debug`, `info`, `warn` and `error`. `respond()` times each
request and writes one `debug` line with its name, status and milliseconds.
`simulate()` writes nothing. Left out, the logger drops `debug` and `info` and
sends `warn` and `error` to the console, so a production log stays quiet. A
custom `onError` replaces the default line, and the debug lines still go to the
logger.

A refused signature goes to `onError` as the `SignatureVerificationError`
that `checkSignedDelivery()` threw, with a code per check, and the reply stays
the 401. The default writes it at `warn` with a hint by code: the signing
secret for `signature_mismatch`, a proxy for a missing, unreadable or mismatched
header. Flood control keeps no timer: the first refusal opens a one-minute
window, five lines are written in it, and the rest are counted. The next
refusal after the window first writes the count. Tests drive it with Vitest's
fake `Date`.

A tell's function is timed. Past `TELL_TIME_LIMIT_SECONDS` (8, the timeout
Siren's delivery client puts on each post to an app's address), `onError` gets
an `AppSlowTellError` at `warn`, and `simulate()` returns it. The reply is still
200, because Siren has already stopped waiting and will send the tell again.
An ask needs no timer: its reply comes before its function runs.

## Testing helpers

`@novatorius/siren/testing` signs requests as `WebhookSignature::headers()`
signs them. `appRequest(kind, key)` builds one from Siren's sample question.
`appRequestFromRecord(record)` signs a stored request again with its id,
kind, mode, data and `answerBy`, from the file `siren apps requests <id> --json`
saves: Siren's request detail with `appKey` and `featureKey` beside it. Siren's
detail names its feature as `app:{id}` only, so the helper takes the key from
`featureKey`, and `{ key }` covers a request whose app is gone, where both
keys are null. A missing key throws `AppHandlerError`. `webhookEvent(type, data?)` signs an event with `X-Siren-Event`
set to the type and an `evt_` delivery id, and no `Idempotency-Key`, which
Siren sends only for keyed deliveries. Its default data is
`sampleEventData(type)`, from src/testing/event-samples.ts, which
scripts/siren-event-samples.mjs builds from the payload tables in Siren's
docs/api/webhooks-events.md. An event whose payload is "the same fields as"
another copies that one. Siren documents 60 of its 64 event types, and the
other four (`credit.issued`, `credit.redeemed`, `currency.created`,
`currency.deleted`) need their data passed.

## Mounting it

| Host | Call | Body | The ask's work |
|---|---|---|---|
| node:http | `http.createServer(answers)` | The stream, up to 1 MiB | `setTimeout(work, 0)` after `res.end()` |
| Express, Connect | `app.post('/siren', express.raw({ type: 'application/json' }), answers)` | The Buffer in `req.body`, or the stream when no parser read it | The same |
| Fastify | `fastify.register(answers.fastify, { path: '/siren' })` | A raw Buffer parser for every content type, scoped to the plugin | The same |
| Next.js app route, Bun, Deno, Hono | `export const POST = answers` | `request.arrayBuffer()`, or 500 when `bodyUsed` | A promise nothing awaits |
| Cloudflare Workers | `export default { fetch: answers }` | The same | `ctx.waitUntil()` from the third argument |
| Anything else | `await answers.handle({ method, headers, rawBody })` | `rawBody` as given | The caller runs `after()` |

Node's `(req, res)` call signature comes first and the Web `Request` one
last, because Next.js 13 to 15 check a route's `POST` against the last
signature. test/types/next-route.ts runs that check, copied from Next.js
15.1.0's types plugin, under `npm run typecheck`.

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

## First contact, DX pass 1

The SDK developer-experience review of 2026-11-24 (review/sdk-dx/pass-1-review.md
and pass-1-builder-spec.md in the apps run folder) changed these:

- The handler compares an ask's signed `answerUrl` origin with the client's
  base origin before it runs the function, in `otherSiren()` in
  app-request-handler.ts. Siren Cloud's `api.` and `app.` hosts over https
  count as one Siren, with the reason beside `CLOUD_ORIGINS`. The answer
  still goes only to the client's base, so a leaked signing secret cannot
  send the key elsewhere. A tell carries no `answerUrl` and gets no check.
- `appRequestFrom()` names the first envelope field that fails, through
  `envelopeProblem()` in app-requests.ts. The status stays 400.
- `answers.simulate(request)` runs `respond()` with a collector in place of
  `onError` and of the answer post. An ask's function runs at once, and its
  answer gets `checkedAnswer()`, the check `answerAppRequest()` runs, then
  `sirenAnswerProblem()` in app-answer-rules.ts, Siren's own answer checks
  for the kind ported with the Siren file and method beside each. A refusal
  is a `ValidationError` with code `app_answer_invalid` and Siren's words.
  The live handler does not run Siren's checks: it posts, and Siren decides.
- `@novatorius/siren/testing` (src/testing/) holds `appRequest()` and
  `sampleData()`. src/testing/sample-data.ts is the `data` of Siren's
  request fixture, and test/apps-dx-first-contact.test.ts holds the two
  equal. The README's samples are signed with `appRequest()`.
- `new Siren()` reads `SIREN_API_KEY` when no `apiKey` or `accessToken` is
  passed, and `requestHandler()` reads `SIREN_SIGNING_SECRET` when no
  `signingSecret` is passed, through `readEnvironment()` in
  src/environment.ts. An empty variable reads as unset.
- `prepare` runs scripts/prepare.mjs, which builds with tsup when it is
  installed, keeps a built `dist` when it is not, and otherwise says to run
  `npm ci` first, so an install from a local folder works.

## Types and one surface, DX pass 3

review/sdk-dx/pass-3-review.md and pass-3-builder-spec.md in the apps run
folder changed these, the same in the PHP and Python SDKs:

- Each kind's types are named from the kind: `<Kind>Question`, `<Kind>Answer`
  and `<Kind>Tell`. scripts/feature-kind.mjs writes `FeatureQuestions`,
  `FeatureAnswers` and `FeatureTells` into src/feature-kind.ts from the kinds
  snapshot, and `AppFeatureFunctions` in record-types.ts is mapped from them,
  so no list of kinds is written by hand.
- `appRequest()` returns `AppTestRequest<K>`, which carries `kind`, and
  `simulate()` has an overload that types `answer` as `FeatureAnswer<K>`.
  `simulate()` answers `status`, `body`, `answer` and `error` every time,
  with null for no answer and no error. The answer is the one the handler
  would post, so it is null after `later()` and beside any error.
- `apps.requestHandler()` answers `AppRequestHandler`, an interface with no
  type argument over `AppRequestHandlerWith<never>`, and `on()` returns
  `this`, so an editor prints `AppRequestHandler` and a typo's error names
  `FeatureKind`. `AppFunctionFor<'customEvent'>` is `never`, so
  `customEvent` still fails to type-check.
- `AppHandlerError`, a `SirenError`, is what the handler and the testing
  helpers throw for a mistake in the code that uses them.
- `appRequestFrom()` sets `isAsk` and reads an empty `args` list as `{}`
  (`readData()`), since Siren encodes an engagement type's empty settings as
  `[]` until it writes an object.
- test/apps-dx-pass-3.test.ts runs the TypeScript compiler, strict, on the
  README's samples and on Siren's request fixture with `satisfies`, so a
  sample that stops compiling or a field Siren adds fails a test.

## Left open

- The feature page samples change in Siren in their own lane, once the SDK
  releases that carry the handler are published.
- The handler does not cap a function's time. Siren gives a tell 8 seconds.
