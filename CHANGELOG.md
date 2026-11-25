# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- `openapi.yaml` is gone. `openapi.json` replaces it, a byte copy of the spec Siren writes from its
  REST controllers, so it lists the routes Siren serves on Cloud and WordPress and marks each with
  `x-siren-platforms`. Its named schemas drop from 50 to 2, `Error` and `ListEnvelope`. Request
  bodies and record answers are written inline on each operation, and answers Siren does not declare
  are open and listed under `x-siren-open-routes`. Code generators should read `openapi.json` for
  paths, parameters and request bodies, and take response models from this package's exported
  TypeScript types, which cover what the spec leaves open.
- `siren.apiKeys` (`create`, `list`, `scopes` and `revoke`) and
  `siren.webhooks.subscriptions.create()` are removed, with `ApiKeysResource`, `ApiKey`,
  `CreatedApiKey`, `CreateApiKeyParams`, `CreatedWebhookSubscription` and
  `CreateWebhookSubscriptionParams`. Siren removed the routes they called: `/api-keys` answers 404
  and `POST /webhooks` answers 405. Declare an app with `apps.declare()` or `siren apps apply`, make,
  replace or revoke its key with `apps.createKey()`, `apps.rotateKey()` and `apps.revokeKey()` or
  `siren apps rotate-key`, list the scopes a key may hold with `apps.scopes()`, and give an app its
  address with `apps.create()` or `apps.update()`. The retired `webhook-subscriptions:read` and
  `webhook-subscriptions:manage` scopes leave `ApiKeyScope` (`WebhookSubscriptionsRead`,
  `WebhookSubscriptionsManage`) and `ApiKeyRecordScope` (`WebhooksRead`, `WebhooksManage`).
- The handler's default `onError` writes one string per failure through the new `logger` option,
  in place of `console.error(prefix, error)`. The line holds the error's class, message and code,
  with a nested cause folded in as "(cause: ...)". A stack trace follows only when your own
  function threw, so a single 401 on the answer post prints one line instead of about twenty.
- A refused signature now reaches `onError` as a `SignatureVerificationError` with a code
  (`signature_mismatch`, `signature_missing`, `signature_malformed`, `timestamp_mismatch` or
  `timestamp_out_of_tolerance`). The reply is still the 401 with the same words.

- Each kind's types are named from the kind, the same in the PHP and Python SDKs: `<Kind>Question`
  and `<Kind>Answer` for an ask, `<Kind>Tell` for a tell, with a variant between the kind and the
  suffix. `AppConversionApprovedData` is `PostConversionActionTell`, `AppAllocationCompletedData` is
  `PostAllocationActionTell`, `AppRewardQuestion`, `AppRewardAnswer` and `AppRewardConversion` are
  `IncentiveResolverQuestion`, `IncentiveResolverAnswer` and `IncentiveResolverConversion`,
  `AppGroupOrderQuestion`, `AppGroupOrderAnswer`, `AppGroupOrderProgram` and
  `AppGroupOrderEngagement` are `ProgramGroupSorterQuestion`, `ProgramGroupSorterAnswer`,
  `ProgramGroupSorterProgram` and `ProgramGroupSorterEngagement`, `AppPayoutQuestion`,
  `AppPayoutAnswer`, `AppPayoutPaid` and `AppPayoutFailed` are `PayoutMethodQuestion`,
  `PayoutMethodAnswer`, `PayoutMethodPaidAnswer` and `PayoutMethodFailedAnswer`,
  `AppCollaboratorGroupChain` and `AppCollaboratorGroupTree` are
  `CollaboratorGroupStructureChainAnswer` and `CollaboratorGroupStructureTreeAnswer`, and every other
  `App<Kind>Question` and `App<Kind>Answer` drops its `App`. `FeatureQuestion<K>`,
  `FeatureAnswer<K>` and `FeatureTell<K>` name them by kind. Each kind's hover reads the same in the
  three SDKs, and a tell's ends "A tell: Siren lets the app know."
- `answers.simulate()` answers the same four fields as the PHP and Python SDKs: `status`, `body`,
  `answer` and `error`. `answer` is null for a tell, after `answers.later()`, beside a refused
  answer and on any error, and `error` is null when nothing failed. A request from `appRequest()`
  carries its `kind`, so `simulate()` types `answer` by it, and the README's first test compiles
  under strict TypeScript.
- The handler throws `AppHandlerError`, a new `SirenError` subclass the PHP and Python SDKs share,
  for a mistake in the code that uses it: a kind Siren never sends, a feature registered twice, an
  ask's function that returns nothing, and a bad argument to `on()`, `onEvent()`, `handle()`,
  `simulate()`, `appRequest()` or `sampleData()`.
- `apps.requestHandler()` answers `AppRequestHandler`, which no longer takes a type argument, and
  `AppRequestHandlerWith<X>` when `extraKinds` names kinds. `on()` takes `FeatureKind` (and the
  extra kinds), so a typo's compile error names `FeatureKind`. `AppHandledKind` is gone.
- `IncentiveResolverQuestion.reason` is `'sale' | 'refund'`, and its `conversionType` and
  `ProgramGroupSorterQuestion.conversionType` are `AppConversionType`, as Siren's builders send
  them. `TransactionFilterQuestion.transaction.currency` may be null, for a sale with no lines.
- Every request has `isAsk`, true for an ask and false for a tell, as PHP's `isAsk()` and Python's
  `is_ask` say.
- The default line for a failed ask names only `siren apps resend <id>` to resend it sooner, since
  Siren Cloud lists an ask under Needs attention only once it needs attention.

- Siren calls a feature a feature everywhere now (Alex's ruling M104), and the SDK follows with no
  old name kept. A request carries `request.feature` (`kind`, `key`, `id`) in place of `item`, and
  a body that holds `item` and no `feature` is refused as not a version 1 request. The feature
  calls are `siren.apps.features` (`AppFeaturesResource`) on `/apps/{app}/features` and
  `/apps/{app}/features/{id}`. An app reads and declares its features under `features`, `DELETE`
  answers `{ archived, feature }`, and a request row names its feature in `feature`. The kinds are
  `FeatureKind`, which replaces `AppItemKind`, and every `AppItem*` type is now `AppFeature*`
  (`AppFeature`, `AppFeatureDeclaration`, `AppFeaturePage`, `AppFeatureUse`, `RemovedAppFeature`,
  `CreateAppFeatureParams`, `UpdateAppFeatureParams`, `AppFeatureKindEntry`,
  `AppFeatureKindSetting`). The error code is `app_features_need_key_and_address`
  (`AppErrorCode.FeaturesNeedKeyAndAddress`), with field paths `features`, `features.{i}.{field}`
  and `feature`.
- Kind names come from Siren's registry. The SDK ships Siren's docs/api/app-kinds.json byte for byte
  as src/app-kinds.json, and `FeatureKind` is generated from it, so each kind's name, and Siren's
  term for it where that differs, shows on hover. `answers.on()` takes the kinds the snapshot marks
  as a tell or an ask, and a screen name gets "The kind for Attribution model is
  incentiveResolver."
- `answers.on()` refuses a kind Siren never sends when the function is registered, with a
  `SirenError` that says what to write instead: the nearest kind for a typo, the kind for a screen
  name such as `attributionModel`, the camelCase kind for `distribution_resolver`, `events.ingest()`
  for `customEvent`, `onEvent()` for an event name, and `payoutMethod` for `fulfillmentMethod`. Its
  types take only those kinds, so the editor flags a typo. The new `extraKinds` option names kinds a
  newer Siren sends, which `on()` then takes.
- An ask's function that returns nothing (`undefined` or `null`) is an error, which `onError` and
  `simulate()` get: "The function for distributionResolver split-by-score returned nothing. Return
  the answer, or return answers.later() when you will answer with apps.requests.answer()." Return
  `answers.later()` to answer later. The ask function types no longer take `undefined`.
- `AppItemKind.FulfillmentMethod` is gone. Use `FeatureKind.PayoutMethod`, the same value.

- `apps.requestHandler()` replies 500 to an ask whose signed `answerUrl` is on another Siren than
  the client's `baseUrl`, and `onError` gets a `SirenError` naming both addresses and the `baseUrl`
  to set. Before, it replied 200 and the answer post failed into a log line. Siren Cloud's
  `api.sirenaffiliates.com` and `app.sirenaffiliates.com` count as one Siren. The answer still
  goes only to the client's own address.
- `prepare` runs `node scripts/prepare.mjs` in place of `tsup`, so an install from a local folder
  without dev dependencies keeps the built `dist`, or says to run `npm ci` first.

- `events.refund` requires `refundId`, the store's own id for the refund, such as WooCommerce
  refund 2201. Siren now refuses a refund without one with 400. Siren records each refund id once
  per order, so sending the same refund again is safe.
- `SaleParams` is a union of `LiveSaleParams` and `TestSaleParams`, so code that extends it as an
  interface no longer compiles. Extend `LiveSaleParams` or `SaleFields` instead. A real sale still
  requires `trackingId`.
- `new Siren()` throws `SirenError` when `timeout` is not a number from 1 to 2147483647 for each
  send, when `maxRetries` is not a whole number of 0 or more (it has no ceiling), or when `baseUrl`
  is not an http or https URL with no user name or password in it. A `baseUrl` must also be
  visible ASCII, U+0021 to U+007E, with no query, fragment, backslash or `@`, so a space or a
  control character is refused and an international host goes in its punycode form. It starts with
  `http://` or `https://` and a host that holds no `%`. NaN, Infinity and strings are refused for
  `timeout` and `maxRetries`, and `null` for all three. Before, a NaN `maxRetries` turned retries off, Infinity retried without end,
  a `timeout` above 2147483647 aborted every request after 1 ms, a `null` took the default, and a
  `baseUrl` that fetch could not use was resent and raised as a lost connection.
- `new Siren()` reads only the options object's own properties, each once. A `baseUrl`,
  `httpClient`, credential, `timeout` or `maxRetries` inherited from a prototype is ignored, and a
  `send` or token method that only `Object.prototype` supplies does not count. Fetch reads its own
  options, so a host that cannot rule out prototype pollution passes its own `httpClient`.
- A bearer token with a control character (C0, DEL or C1) or a character above U+00FF is refused
  before it is sent, because neither can go in an HTTP header. An `apiKey` or string `accessToken`
  throws `SirenError` when the client is built, and a `getAccessToken` answer raises `SirenError`. A
  refresh answer that breaks the rule raises the 401 with a `SirenError` cause naming
  `refreshAccessToken`, and `CallbackAccessTokenSource` hands an empty, `undefined` or non-string
  refresh answer to that rule instead of reading it as `null`. Before, fetch refused such a token and
  the SDK resent the request as a lost connection.

### Added

- `siren notes --on <type:id>` lists a record's notes, newest first. `siren <resource> note <id>
  <text>` adds one, and `siren notes edit` and `siren notes delete` change and remove one. A live
  organization takes a note without `--live`, since a note changes no program, reward or payout.
  The generated `siren notes list`, `create`, `update` and `delete` are gone.
- A generated `get`, such as `siren collaborators get 1`, prints a record view: the record's name
  in the headline, aligned rows, a nested object as dotted rows, and each list of objects as its
  own section, one line an item, never cut mid-value. `collaborators get` and `programs get` end
  with the record's latest notes. Through a pipe, Next goes to standard error.
- A validation failure prints one row a field on every command, with each field's needs, in
  place of one paragraph. `--json` on a generated command now carries Siren's `context`, which held
  `failedValidations` and was dropped before.
- `siren recipes`, with `preview`, `apply`, `status`, `imports`, `export`, `catalog`, `show` and
  `fetch`. `apply` previews, asks, applies under an import key made from the recipe, and follows
  the import to its end. `siren.recipes` makes the same calls from code. The package ships
  `siren.recipe.schema.json`, a copy of Siren's recipe schema, for editor completion.
- `apps.requests.list()` takes `limit` (1 to 100) and `before` (a request id) to page through every
  request, as `GET /apps/requests` now reads them.
- `apps.requests.list({ idPrefix })` finds requests by the start of their id, `apr_` and 4 to 32
  hex characters in either case, as Siren reads it from feat/apps 76d5bbdf83. It answers the
  matching requests, at most two, newest first, so two mean the start fits more than one. It
  refuses status, limit or before beside it, since Siren ignores them.
- `apps.requests.list({ appId })` keeps the list to one app, by its numeric id, as Siren reads it
  on the plain list and `needs_attention` from feat/apps 76d5bbdf83.
- `apps.requests.list({ status: 'needs_attention' })` takes `limit` and `before` too, since Siren
  pages the attention list from pkt/apps-attention-paging. An older Siren ignores them and answers
  at most 50.

- `new Siren()` reads `SIREN_BASE_URL` as its default base URL, the way it reads `SIREN_API_KEY`,
  and a `baseUrl` passed in code wins. `siren apps apply` writes the variable beside the key, so a
  sandbox ask's `answerUrl` and the client agree. `appRequest()` signs for that host too.
- `AppRequestStatus.Applying` (`applying`), the status of an ask whose answer Siren is applying now.
  `apps.requests.list({ status: 'applying' })` reads those. The SDK now holds all eight statuses
  Siren's `AppRequest` model names.
- `appRequestFromRecord()` reads a request saved with `siren apps requests <id> --json` and takes
  the feature's key from its `featureKey`, so `{ key }` is needed only when the app is gone.
- A `logger` option on `apps.requestHandler()`, taking anything with `debug`, `info`, `warn` and
  `error`, such as `console`, pino or winston. The handler writes one `debug` line per request it
  handled, with its name, status and time. Refused signatures and slow tells go to `warn`, and every
  other failure to `error`. Left out, warnings and errors go to the console and the debug lines are
  dropped.
- The default line for a refused signature says what to check: `SIREN_SIGNING_SECRET` for a wrong
  signature, a proxy for a missing or unreadable header, the clock for a stale time. After five in
  one minute the rest are counted into one line, with no timer.
- `AppSlowTellError` and `TELL_TIME_LIMIT_SECONDS` (8, Siren's delivery timeout). A tell or
  `onEvent` function that runs longer still replies 200, and `onError` and `simulate()` get the
  error, since Siren stopped waiting and sends the tell or event again. The default writes it as a
  warning naming the kind and key, or the event type and delivery id.
- `webhookEvent(type, data?)` and `sampleEventData(type)` in `@novatorius/siren/testing` sign a
  webhook event as Siren sends one to an app's address, for `onEvent()` tests. The samples come from
  the payload tables in Siren's docs/api/webhooks-events.md (feat/apps at 6d2abd936a), built by
  scripts/siren-event-samples.mjs, which a test runs against `SIREN_CHECKOUT` to hold them equal.
- `appRequestFromRecord(record, { key })` in `@novatorius/siren/testing` turns a stored request,
  as `apps.requests.retrieve(id)` answers it, into a signed test input.
- After a 422 `app_answer_invalid`, the default line says to reproduce the answer with `simulate()`
  and resend, in place of when Siren sends it again.
- The README's "Develop on your machine" teaches `siren listen --forward-to` and
  `siren trigger ask`, which arrive with the command-line tool's next release.

- A request's empty engagement `args`, which Siren sends as `[]` until it writes `{}`, reads as
  `{}`, so `args.weight` is safe for an engagement type with no settings.
- `answers.later()`, which an ask's function returns when the app will answer later with
  `apps.requests.answer()`, and the types `AppAnswerLater` and `AppAskResult`.
- `answers.simulate()` checks an ask's answer with Siren's own rules for its kind, ported from
  Siren's answer route, and returns a refused answer as a `ValidationError` with code
  `app_answer_invalid` and Siren's words. The live handler still posts the answer and lets Siren
  decide.
- The default `onError` line for an ask that failed after its 200 says when Siren sends it again,
  from `answerBy`, and how to resend it sooner: from Needs attention in Siren Cloud, or with
  `siren apps resend <id>`. It comes before the error, so a stack trace can't push it out of sight.
- The README opens with "How Siren talks to your app", the same block as the PHP and Python SDKs,
  has a reply row for a failed function, and says an ask's function can run more than once.
- `@novatorius/siren/testing`, with `appRequest(kind, key, { data, secret, id, app, baseUrl,
  timestamp })`, which signs an app request as Siren sends it, and `sampleData(kind)`, Siren's
  sample question for each kind.
- `answers.simulate(request)` runs the whole handler on one request, posts nothing, and answers
  `{ status, body, answer, error }`. Its type is `AppSimulation`.
- `new Siren()` reads `SIREN_API_KEY` when no `apiKey` or `accessToken` is passed, and
  `apps.requestHandler()` reads `SIREN_SIGNING_SECRET` when no `signingSecret` is passed. An
  explicit value wins, and with neither the refusal names the option and the variable.
- openapi.yaml lists the `client_credentials` grant on `POST /oauth/token`, with its 400
  `unauthorized_client` for a key that is no app's, and 409 `app_request_dropped` on the answer
  route.

- `apps.requestHandler({ signingSecret, toleranceSeconds, runLater, onError })` answers Siren for an
  app in a few lines. `on(kind, key, fn)` and `on(kind, fn)` register a function per feature, and
  `onEvent(type, fn)` one per webhook event at the same address. It checks each request as
  `apps.verifyRequest()` does and replies 405 to a method other than POST, 500 to a body a parser
  already read, 401 to a failed signature or time check, 400 to a body that is not JSON or not an
  envelope of version 1, and 404 `No function handles <kind> <key>.` to a feature with no function.
  A tell gets 200 once its function returns and 500 when it throws. An ask gets 200 at once, and
  the answer its function returns is posted to `POST /apps/requests/{id}/answer`, resent on a lost
  connection, 429 or 5xx within `maxRetries`. Siren's refusals (422, 409, 403, 404) go to `onError`
  and are not resent. It mounts on `node:http`, Express, Fastify (`answers.fastify`), a Web
  `Request` (Next.js app routes, Workers with `ctx.waitUntil`, Bun, Deno) and `answers.handle()`.
  No web framework is a dependency.
  The default `onError` writes one `console.error` line with the kind, key and request id and
  the error, never the request's data or headers. The handler's Web `Request` call signature is its
  last, so `export const POST = answers` passes the route check of `next build` on Next.js 13 to 15.
- `apps.splitPool(pool, weights)` splits a resolver's pool by weight in whole steps of the
  currency, rounded down so the shares never pass `pool.value`, and evenly when every weight is 0.
  It refuses a negative or non-finite weight and an id given twice with `SirenError`.
- Types `DistributionResolverQuestion`, `AppDistributionMetric`, `DistributionResolverAnswer`,
  `AppFeatureFunctions`, `AppRequestFunction`, `AppEventFunction`, `AppSplitPool`,
  `AppSplitWeights`, `AppRequestHandler`, `AppRequestHandlerOptions`, `AppRequestInput`,
  `AppRequestReply` and the mount types. `AppTell` and `AppAsk` take the kind's data as a type
  argument, `Record<string, unknown>` by default. `on()` types each kind's request and answer, the metric
  calculation and metric filter kinds' included.

- `FeatureKind.IncentiveType` (`incentiveType`), the feature kind a program selects as its
  incentive type, to let the app decide which engagements each sale, lead or renewal converts and
  the pool the program's resolver divides. The types `IncentiveTypeQuestion`,
  `AppIncentiveTypeEngagement`, `AppIncentiveTypeLine` and `IncentiveTypeAnswer` describe the
  ask's `data` and its answer, `{ outcome: 'award', units, pool, engagementIds }` or
  `{ outcome: 'none' }`, which `apps.requests.answer()` sends to `POST /apps/requests/{id}/answer` as
  before, and `requestHandler().on('incentiveType', ...)` types both. A feature takes
  `conversionTypes` (`AppConversionType`: `sale`, `lead`, `renewal`) in `apps.declare()`,
  `apps.features.create()` and `apps.features.update()`. The app file requires it for an incentive type,
  each once and known, refuses it on any other kind, and `siren apps apply` shows a change to it as
  "conversions it pays". `siren apps` names the kind Incentive structure, and `openapi.yaml`'s
  `AppFeatureDeclaration` gains the kind and `conversionTypes`.
- `FeatureKind.EngagementCalculation` (`engagementCalculation`) and `FeatureKind.EngagementFilter`
  (`engagementFilter`), the feature kinds a program's engagement type and a program select to let the
  app decide who earns each engagement and whether it is made. The types
  `EngagementCalculationQuestion`, `EngagementCalculationAnswer`, `EngagementFilterQuestion`,
  `EngagementFilterAnswer`, `AppEngagementCause` and `AppEngagementOpportunity` describe the asks'
  `data` and their answers, which `apps.requests.answer()` sends to `POST /apps/requests/{id}/answer`
  as before, and `requestHandler().on(...)` types both. `siren apps` names them Engagement
  calculation and Customer filter for programs, and `openapi.yaml`'s `AppFeatureDeclaration` gains them.
- `FeatureKind.ProgramGroupSorter` (`programGroupSorter`), the feature kind a program group selects
  as its structure, to let the app order the group's programs for each sale or lead. The types
  `ProgramGroupSorterQuestion`, `ProgramGroupSorterProgram`, `ProgramGroupSorterEngagement` and
  `ProgramGroupSorterAnswer` describe the ask's `data` and its answer, `{ outcome: 'sorted', programIds }`,
  which `apps.requests.answer()` sends to `POST /apps/requests/{id}/answer` as before, and
  `requestHandler().on('programGroupSorter', ...)` types both. `siren apps` names the kind Program
  group structure, and `openapi.yaml`'s `AppFeatureDeclaration` gains it.
- `FeatureKind.TransactionFilter` (`transactionFilter`), the feature kind a program or a
  distributor selects to let the app say which of a sale's own lines count. Siren's catalog calls it
  a transaction compiler. Siren asks it once per sale for each program or distributor that picks
  it, and a refund reuses the stored answer. The types `TransactionFilterQuestion`,
  `AppTransactionLine` and `TransactionFilterAnswer` describe the ask's `data` and its answer,
  the ids of the lines to include, which `apps.requests.answer()` sends to
  `POST /apps/requests/{id}/answer` as before. Siren refuses a line id the question lacks with 422
  `app_answer_invalid`. `apps.requestHandler().on('transactionFilter', ...)` is typed by them,
  `siren apps` names the kind Transaction filter, and `openapi.yaml`'s `AppFeatureDeclaration` gains
  it.
- `FeatureKind.CollaboratorGroupStructure` (`collaboratorGroupStructure`), the feature kind a
  collaborator group selects to let the app give the group's shape. Siren asks it once per cascade
  trigger on the group, for a program or a distributor. The types
  `CollaboratorGroupStructureQuestion`, `CollaboratorGroupStructureDistributorQuestion`,
  `CollaboratorGroupStructureProgramQuestion`,
  `AppCollaboratorGroupMember`, `CollaboratorGroupStructureChainAnswer`, `CollaboratorGroupStructureTreeAnswer` and
  `CollaboratorGroupStructureAnswer` describe the ask's `data` and its answer, a chain or a tree.
  Each `AppCollaboratorGroupMember` carries its `status` at the trigger, which Siren credits it by.
  `apps.requests.answer()` sends the answer to `POST /apps/requests/{id}/answer` as before. Siren refuses
  an answer that leaves out or repeats a member, names one outside the group, or makes a cycle with
  422 `app_answer_invalid`. `apps.requestHandler().on('collaboratorGroupStructure', ...)` is typed
  by them, `siren apps` names the kind Collaborator group structure, and `openapi.yaml`'s
  `AppFeatureDeclaration` gains it.
- `FeatureKind.IncentiveResolver` (`incentiveResolver`), the feature kind a program selects to let
  the app split each sale's reward. The types `IncentiveResolverQuestion`, `IncentiveResolverConversion` and
  `IncentiveResolverAnswer` describe the ask's `data` and its answer, which `apps.requests.answer()` sends to
  `POST /apps/requests/{id}/answer` as before. `AppErrorCode.Dropped` is
  `app_request_dropped`, the 409 Siren answers once it stopped waiting for an ask, 24 hours after the
  sale's reward began to wait. `siren apps` names the kind Attribution model, and `openapi.yaml`'s
  `AppFeatureDeclaration` gains it.
- `AppRequestStatus.Dropped` (`dropped`), the status of an ask Siren stopped waiting for, which
  `apps.requests.list()` can filter by. `openapi.yaml` lists it in both request status enums.
- `FeatureKind.MetricCalculation` (`metricCalculation`) and `FeatureKind.MetricFilter`
  (`metricFilter`), the feature kinds a distributor's metric type and a distributor select. The
  types `MetricCalculationQuestion`, `MetricCalculationAnswer`, `MetricFilterQuestion` and
  `MetricFilterAnswer` describe each ask's `data` and its answer, which `apps.requests.answer()`
  sends to `POST /apps/requests/{id}/answer` as before. A feature takes `scoresMoney`, a boolean, on
  `apps.declare()`, `apps.features.create()` and `apps.features.update()`. The app file refuses
  `scoresMoney` that is not true or false, and refuses it on any kind but `metricCalculation`, and
  `siren apps apply` shows a changed `scoresMoney` as "scores money". `openapi.yaml`'s
  `AppFeatureDeclaration` gains `scoresMoney` and the kinds `customEvent`, `metricCalculation` and
  `metricFilter`.
- `PayoutMethodQuestion`, `PayoutMethodPaidAnswer`, `PayoutMethodFailedAnswer` and `PayoutMethodAnswer` describe the
  `payoutMethod` ask's `data` and its answer, which `apps.requests.answer()` sends as before. The
  request handler's `payoutMethod` function now takes `AppAsk<PayoutMethodQuestion>` and returns an
  `PayoutMethodAnswer`. The app pays each payout id at most once.
- `events.ingest` takes an optional third argument, `IngestOptions`, with `headers` for the call
  and a `timeout` in milliseconds that replaces the client's for this call. A connected site uses it
  to send a referral visit with the tracking value the shopper already holds, as `X-Siren-Token` or
  `X-Siren-Oid`, and a short wait of its own. The call is still sent once. The headers go out
  beneath the SDK's own and ride along on the resend after a 401. A header name that is not an HTTP
  token, a value with a control character or a character above U+00FF, or a timeout out of range
  throws `SirenError` before anything is sent.
- `getApplicationForm`, `submitApplication` and `verifyApplication` in `@novatorius/siren/storefront`,
  for running a Siren Cloud application form on your own site from the visitor's browser. They read
  the form's field definitions, send an application with the referral the visitor arrived with,
  return a message per field on a refusal, and confirm the application from your own confirmation
  page.
- `events.refund` takes a partial refund: `amount`, `currency`, `lines` (each a `RefundLine` that
  names the sale's line by `lineId` or `sku`, with `quantity` and `amount`), `whole`, and `kind`
  (`RefundKind`: `refund`, `cancelled` or `voided`). A refund with neither `amount` nor `lines`
  still refunds the whole order.
- `LineItem.lineId`, your own id for an order line, which a later refund names the line by.
- A test sale: `events.sale({ test: true })` checks an integration. Siren needs no other field,
  marks it as a test, counts it toward nothing and ignores `trackingId`.
- `SiteVisitedParams.collaboratorId` takes a tracking code as `tracking:{code}`, typed as
  `TrackingCodeReference`, as well as a numeric id.
- `webhooks.subscriptions.events()` reads `GET /webhooks/events`, the event types Siren delivers.
  It throws `UnexpectedResponseError` when Siren answers with a body of the wrong shape.
  `apps.scopes()` lists the scopes an app's key may hold.
- `WebhookEventType` holds all 64 events in Siren's webhook catalog, 30 more than before, such as
  `collaborator.applied`, `payout.failed`, `program.updated` and `store.disconnected`.
- `ErrorCode` holds every code Siren sends, 26 in all, and `isKnownErrorCode` says whether a code is
  one of them. `POLICY_ERROR_CODES` lists the 403 codes that mean Siren's policy refused the request.
- New error classes. `SiteDisconnectedError` (401 `site_disconnected`) means the organization
  revoked or deleted the connected site's connection. `PolicyError` (403, a policy code) means
  sending the request again fails again, and `param` names the refused field. `CodeConflictError`
  and `HoldConflictError` wrap a 409 for a held code and a refused credit hold, with
  `HoldConflictReason`, and the resources that raise them come in a later release.
  `UnexpectedResponseError`, an `ApiError`, reports a success reply whose body has the wrong shape.
- Siren's vocabulary as constants with union types of the same name: `EventSlug`, `RefundKind`,
  `EventStatus`, `EventReason`, `ConversionStatus`, `TransactionStatus`, `ObligationStatus`,
  `PayoutStatus`, `OpportunityStatus`, `ProgramStatus`, `CollaboratorStatus`, `DistributorStatus`,
  `FulfillmentStatus`, `ApiKeyStatus`, `WebhookSubscriptionStatus` and `CustomCurrencyType`.
- `openapi.yaml` documents the new refund, sale, line and visit fields, `RefundLine`,
  `GET /api-keys/scopes`, every webhook event and an `ErrorCode` schema.
- `accessToken`, a `new Siren()` option beside `apiKey`, for a connected store's OAuth access token.
  It takes a string, or an `AccessTokenSource` that supplies the token and a fresh one after a 401.
  `StaticAccessToken` holds a fixed token and never refreshes. `CallbackAccessTokenSource` builds a
  source from two functions, for a host that keeps its grant in its own storage. Pass `apiKey` or
  `accessToken`, never both.
- `httpClient`, a `new Siren()` option that sends every request through the host's own HTTP stack.
  `HttpClient` has one method, `send(request)`, with `HttpRequest` and `HttpResponse` as its types.
  It never follows a redirect and keeps the request headers out of its errors. `FetchHttpClient`
  is the default, over the global `fetch`, and sends with `redirect: 'manual'`. A client rejects
  with `HttpClientError` when no complete response arrived.
- `ConnectorScope` names the OAuth scopes a connected site asks for: `ConnectAll`, `Webhooks`,
  `RecordsRead`, `RecordsWrite`, the joined `CONNECTED_SITE` value and `forConnectedSite()`.
- `conversions.retrieve` and `transactions.retrieve` read one record with
  `GET /conversions/{id}` and `GET /transactions/{id}`, taking `fields`, `include` and
  `propertyId`. They throw `SirenError` before sending when the id is not a positive whole number,
  and `UnexpectedResponseError` when a 2xx body is not a JSON object.
- `openapi.yaml` documents `GET /conversions/{id}` and `GET /transactions/{id}`.
- `@novatorius/siren/connect`, a new entry for a store that connects to Siren Cloud as a site. It
  holds the OAuth flow, the connected-site client and the forwarded event vocabulary, and shares
  its classes with the main entry, so `instanceof SirenError` holds across both.
- `OAuthClient` registers the site's client (`register`), builds the consent screen URL
  (`authorizeUrl`), exchanges the callback's code (`exchangeCode`) and refreshes the token pair
  (`refresh`). Each call is sent once and never retried. A refusal with the RFC error envelope
  raises `OAuthError`, whose code is one of `OAuthErrorCode`. `ConnectorSoftware` names the
  connector a site registers as. `new OAuthClient()` reads and checks `baseUrl`, `timeout` and
  `httpClient` as `new Siren()` does, with the same messages, and `consentScreenUrl` by the
  `baseUrl` rule, so a URL with an `@`, a backslash, a query or a character outside visible ASCII
  is refused when the client is built.
- `createCodeVerifier`, `createState` and `codeChallengeS256` make the PKCE verifier, the state and
  the S256 challenge `authorizeUrl` takes.
- `SirenConnect`, the client a connected site holds once it has tokens. It takes `accessToken` and
  never `apiKey`, and exposes `connect` and `events`.
- `ConnectResource` sends the `/connect/*` routes and `/ping`: `plan`, `updateGrant`,
  `reportSiteState`, `reportIntegrations`, `syncProducts`, `disconnect`, `migrationWindow`,
  `customerEmailKey` and `ping`. `ConnectWebhookResource`, at `connect.webhook`, manages the site's
  own subscription: `replace`, `get`, `delete`, `test` and `deliveries`. `ConnectScope` names the
  six scopes those routes need.
- `events.forward` sends a connected site's event in Siren's versioned envelope, once and never
  retried. It takes the slug, the envelope and `{ finalAttempt }`. `ForwardedEventSlug` names the
  28 slugs it takes, `ForwardedEventEnvelope` types the envelope for each, and
  `FORWARDED_EVENT_VERSION` is 1. `finalAttempt: true` adds `X-Siren-Final-Attempt: 1`.
- `openapi.yaml` documents `/oauth/register`, `/oauth/token`, every `/connect/*` route with the
  scope it needs, the `ForwardedEventEnvelope` schema and the `X-Siren-Final-Attempt` header.
- Record resources on the client: `siren.collaborators` (`CollaboratorsResource`), with their
  tracking and coupon codes at `siren.collaborators.aliases` (`CollaboratorAliasesResource`) and
  their program enrollments at `siren.collaborators.enrollments` (`ProgramEnrollmentsResource`),
  `siren.collaboratorGroups` (`CollaboratorGroupsResource`) with their members at
  `siren.collaboratorGroups.members` (`CollaboratorGroupMembersResource`), `siren.programs`
  (`ProgramsResource`) and `siren.programGroups` (`ProgramGroupsResource`). Record writes are sent
  once, and reads retry. A list throws `SirenError` for a key its route does not read, an empty
  filter list, a comma outside `fields` and `s`, and an id that is not a positive whole number.
- `collaborators.createPending` and `collaborators.updateDetails`, the create and update a connected
  site may send.
- `PropertyQualifier`, which reads the Property a connected site's code type is filed under, such as
  `coupon@property:5`, and checks the names and code types a caller sends.
- `CollaboratorBulkAction`, `CollaboratorAliasType`, `ProgramBulkAction`, `ProgramGroupSorter` and
  `ProgramGroupBulkAction`, Siren's names for the record actions, code types and group sorters.
- More record resources on the client: `siren.opportunities` (`OpportunitiesResource`),
  `siren.engagements` (`EngagementsResource`), `siren.distributors` (`DistributorsResource`),
  `siren.customCurrencies` (`CustomCurrenciesResource`), `siren.credits` (`CreditsResource`) for
  store credit balances, the ledger and checkout holds, `siren.mappings` (`MappingsResource`) for
  links to records outside Siren, and `siren.settings` (`SettingsResource`) for the settings Siren
  shares with a connected site. The SDK sends every write once and retries reads.
- Writes on `siren.conversions` (`create`, `recoverCreate`, `update`, `delete`, `bulk`, `types`)
  and on `siren.transactions` (`details`, `create`, `bulk`, `creditCollaborator`,
  `recoverCreditCollaborator`, `sources`). `recoverCreate` and `recoverCreditCollaborator` send a
  write that lost its answer again only for what Siren does not hold, and send nothing on an answer
  they cannot read, or on an empty page whose total says Siren holds matching rows. The
  conversion, transaction, custom currency and distributor creates send only the fields Siren reads
  and refuse any other key. `transactions.create` refuses half a binding, and a binding field of
  `""`, `"0"`, `0`, `NaN`, `Infinity` or `-Infinity`, which Siren reads as none.
- `engagements.list` refuses a `from` or `to` that is not a real day written `YYYY-MM-DD`, and
  `distributors.list` refuses a `metricType` of `""`, before sending. Siren drops either value
  without a word and answers every record.
- `CreditsResource.holdReference`, which builds the reference a checkout's credit holds carry.
- `ConversionBulkAction`, `TransactionBulkAction`, `DistributorBulkAction` and `CreditHoldStatus`,
  Siren's names for those bulk actions and hold statuses.
- `payouts.retrieve` reads one payout with `GET /payouts/{id}`, taking `fields`, `include` and
  `propertyId`. `siren.payouts` is now a `PayoutsResource`, whose `list` is unchanged. An API key
  needs `ledger:payouts:read` and must be organization-wide. `Payout` types the answer.
- `siren.fulfillments` (`FulfillmentsResource`) reads the batches Siren pays payouts in: `list`
  with `GET /fulfillments` and `retrieve` with `GET /fulfillments/{id}`. `list` filters by
  `status`, `payoutStatus`, `currency`, `from` and `to`, and throws `SirenError` before sending for
  any other key, `propertyId` included, for a `from` or `to` that is not a real day written
  `YYYY-MM-DD`, and for a `payoutStatus` or `currency` that is `""` or not a string, which Siren
  reads as no filter or as one value. An API key needs `ledger:fulfillments:read` and must be
  organization-wide. `Fulfillment`, `FulfillmentPayout` and `FulfillmentListParams` type them.
- `webhooks.subscriptions.retrieve` (`GET /webhooks/{id}`) reads one subscription, and
  `webhooks.subscriptions.deliveries` (`GET /webhooks/{id}/deliveries`) reads its latest 50
  deliveries, newest first. Both retry as reads. `webhooks.subscriptions.update`
  (`PUT /webhooks/{id}`) sends only `targetUrl`, `events`, `status` and `description`, and throws
  `SirenError` before sending for any other key, and for an update with no field that is not `null`
  or `undefined`, since Siren skips a `null` field and answers 500 when nothing is left to change.
  `webhooks.subscriptions.test`
  (`POST /webhooks/{id}/test`) makes Siren send one signed `webhook.test` delivery now. Both are sent
  once. Each of the four throws `UnexpectedResponseError` for a 2xx body of the wrong shape.
  `UpdateWebhookSubscriptionParams`, `WebhookTestResult` and `WebhookDelivery` type them.
- `ApiKeyRecordScope` names all thirty record scopes Siren issues, from Siren's
  `ApiKeyRecordScopes`, and `API_KEY_RECORD_SCOPES` lists them in Siren's order.
  `CreateApiKeyParams.scopes` and `ApiKeyScopeEntry.scope` take them.
- `openapi.yaml` documents `GET /payouts/{id}`, `GET /fulfillments`, `GET /fulfillments/{id}`,
  `PUT /webhooks/{id}`, `GET /webhooks/{id}/deliveries` and the `WebhookDelivery` schema.
- `siren.apps` (`AppsResource`) for Siren apps, each call taking a signed-in admin's session
  token: `declare` (`PUT /apps/{key}`, sent once, answering `created: true` with `rawKey` the
  first time, and `signingSecret` whenever it made an address), `list` (`GET /apps`), `retrieve`
  (`GET /apps/{key}`), `setStatus` (`POST /apps/{key}/status`) and `delete`
  (`DELETE /apps/{key}`). Each throws `SirenError` before sending for an app key that is not
  lowercase letters and digits joined by single dashes, at most 64 characters, or that is
  `requests`, `events`, `scopes` or `kinds`, and `declare` for a field or feature field Siren does not take, whatever its value. The
  reads retry, the writes are sent once, and a 2xx body that is not an app raises
  `UnexpectedResponseError`.
- `siren.apps.verifyRequest(rawBody, headers, secret, options)` checks a request Siren sends an app:
  the `X-Siren-Signature-V2` signature in constant time, a signed time within `toleranceSeconds`
  (300 by default) either way, `X-Siren-Event` `app.request`, and a body of version 1. It throws
  `SignatureVerificationError` otherwise and never falls back to `X-Siren-Signature`.
- `siren.apps.requests`: `list` (`GET /apps/requests`, the latest 50, filtered by `status`),
  `resend` (`POST /apps/requests/{id}/resend`, sent once) and `answer`
  (`POST /apps/requests/{id}/answer`, with the app's own key or an admin's session).
  `requests.answer` throws
  `SirenError` before sending for an id that is not `apr_` and 32 hex characters, or an answer that
  is not a plain object with a text `outcome` of at most 16384 bytes as JSON. The 401 Siren sends
  with no code for a missing or unknown bearer is raised as `AuthenticationError` with `code`
  `app_answer_unauthorized`. A person may answer only a request that needs attention, and Siren
  refuses any other hand answer with 409 `app_request_not_needing_attention`, which `AppErrorCode`
  names as `NotNeedingAttention`. `siren apps answer` then prints Siren's line and points to
  `siren apps requests --attention`, and prints the code of any refusal it does not know.
  `WebhookSubscription` gains `appId`, the app that owns the subscription or `null`. The example's
  `send-sale` prints how many conversions a sale made, or Siren's reason and message when it made
  none, since a real Siren answers `recorded` for a visit or sale no program pays for.
  `siren apps apply` says once, before sending, that a Siren in a container cannot reach an app url
  on `localhost` or `127.0.0.1`, and names `host.docker.internal`. The README's new "Running against
  your own Siren Cloud" lists the settings a self-run Siren needs. It is sent once, and
  sending the same answer again after a lost one answers `duplicate: true`. `requests.resend`
  sends nothing to the app for a request that holds an answer Siren has not applied, and Siren
  applies that answer instead. It raises `ConflictError` with `app_request_not_resendable` for an
  applied request, or one Siren would send while its app is off.
- `AppRequestsResource`, the class behind `siren.apps.requests`, for typing it.
- `MAX_APP_ANSWER_BYTES`, 16384, the most an answer may hold as JSON.
- `DEFAULT_APP_REQUEST_TOLERANCE_SECONDS`, 300, how far a signed time may be from the receiver's
  clock when `verifyRequest` gets no `toleranceSeconds`.
- `DEFAULT_BASE_URL`, the live address `https://api.sirenaffiliates.com/siren/v1`.
- `AppErrorCode` names the codes the app routes send, and `appErrorCode(error)` reads one from an
  error's `code`, else `data.reason`. `FeatureKind`, `AppStatus`, `AppRequestStatus` and
  `AppRequestMode` are Siren's app vocabularies, and `App`, `AppFeature`, `DeclareAppParams`,
  `DeclaredApp`, `RotatedApp`, `AppRequest`, `AppRequestRecord`, `AppAnswer` and
  `AppAnswerReceipt` type the calls.
- The sandbox's address, `https://sandbox.sirenaffiliates.com/siren/v1`, as an exported constant. A
  client built with an `sk_test_` key and no `baseUrl` goes to `SANDBOX_BASE_URL`.
- The `siren` command-line tool, this package's bin: `signup`, `login`, `logout`, `orgs`, `use`,
  and `apps init`, `apply`, `list`, `show`, `requests`, `answer`, `resend`, `rotate`, `on`, `off`
  and `delete`. It keeps the session in credentials.json, mode 0600, and saves an app's key and
  signing secret in `.env.sandbox` or `.env.live` beside siren.app.json, written as a new 0600
  file renamed over the old one. It refuses an env file that is a symbolic link, and a later
  `apps apply` and `apps rotate` stop before sending when the env file holds another Siren's key. `signup` and
  `login` refuse a credentials file others can read before the password is sent. It talks to the
  sandbox unless told otherwise, and needs `--live` for a live organization. Its hidden password
  prompt turns the terminal's echo off before it shows `Password: `, so a password typed the moment
  the prompt appears is never shown, and gives the echo back however the prompt ends. Every command
  that sends anything first reads the edition the Siren reports with `GET /auth/signup-options`,
  and `apps requests --follow` reads it again before each poll. That read gives up after 6.5
  seconds and says the Siren did not answer. The tool refuses a stored session made for another edition or address before it sends
  anything with it, with one line that names the `siren login` to run. Every hint that names a
  command carries the flags that reach the same Siren, such as `--live`. A request id, app key or
  answer the command line gets wrong is refused in the tool's own words with exit code 2, before
  anything is sent.
- examples/apps/acme, an example app that checks each request, answers every ask and sends a sale
  with the app's own key.
- `openapi.yaml` documents the app routes, the `AppDeclaration`, `App`, `AppFeature`,
  `AppRequestRecord`, `AppAnswer` and `AppAnswerReceipt` schemas, and the sandbox server.
- `siren.apps.shownAmount(value, currency)` reads a stored amount and its currency as a person
  reads them, and answers `{ amount, decimal, text }`, such as `{ amount: 100, decimal: '100',
  text: '¥100' }` for 10000 in yen. It sends nothing, and throws `SirenError` for a `value` that is
  not a safe integer or a currency whose `scale` or `decimalPlaces` it cannot read.
- `PostConversionActionTell` and `PostAllocationActionTell` type the data of the two tells, and
  `AppCurrency` the `currency` Siren sends beside each `value`. `value` is the stored integer, not
  the amount a person reads. `ShownAmount` types what `shownAmount` answers. The example app logs
  each tell's amount through `shownAmount`.
- `siren.apps.requests.retrieve(id)` reads one request, however old, with
  `GET /apps/requests/{requestKey}`, and answers `AppRequestDetail`: the list's fields, the `data`
  Siren sent, the `answer` it took or `null`, and `answeredByUser`. It refuses a bad id before
  sending, retries as a read, and raises 404 `app_request_not_found` as `NotFoundError`. openapi
  gains the route and the `AppRequestDetail` schema. `siren apps requests <id>` reads it, so it
  shows a request older than the latest 50, with its data, its answer and who gave it.
- `App.needsAttention`, how many of the app's requests need a person, which Siren now sends on
  every app, and in openapi's `App` schema. `siren apps list` and `siren apps show` print the count
  under an app when it is above 0, with `siren apps requests --app <key> --attention`.
- An app holds its own key, address and features, as Siren's int/preview-apps answers it. The
  apps resource gains a call for each part, every one Node-only for now:
  - `apps.create` (`POST /apps`, sent once) makes an app from the dashboard's door, with a key when
    `scopes` is a list and an address when `url` is given, answering each new secret once.
  - `apps.update` (`PATCH /apps/{key}`, sent once) changes only the fields sent. `url: null`
    removes the address.
  - `apps.createKey`, `apps.rotateKey` and `apps.revokeKey` (`POST /apps/{key}/key`,
    `POST /apps/{key}/key/rotate` and `DELETE /apps/{key}/key`) make, rotate and revoke the key.
  - `apps.rotateSecret` (`POST /apps/{key}/secret/rotate`) gives the address a new signing secret.
  - `apps.test` (`POST /apps/{key}/test`) sends the address one signed `webhook.test`, and
    `apps.deliveries` (`GET /apps/{key}/deliveries`) reads its latest 50 deliveries.
  - `apps.features.create`, `retrieve`, `update` and `delete` (`/apps/{app}/features` and
    `/apps/{app}/features/{id}`) add, read, change and remove one feature. `update` refuses a change to
    `kind` or `key` before sending, since a feature's kind and key never change.
  - `apps.events`, `apps.scopes` and `apps.kinds` (`GET /apps/events`, `/apps/scopes` and
    `/apps/kinds`) read the three catalogs.

  Each write is sent once and each read retries. A key or secret route that answers without its
  secret raises `UnexpectedResponseError`. `AppFeaturesResource` is exported for typing
  `siren.apps.features`.
- Types `AppApiKey`, `AppAddress`, `AppPlanAccess`, `AppFeaturePage`, `AppFeatureUse`,
  `RemovedAppFeature`, `CreateAppParams`, `CreatedApp`, `UpdateAppParams`, `UpdatedApp`,
  `CreateAppFeatureParams`, `UpdateAppFeatureParams`, `AppWithRawKey`, `AppWithSigningSecret`,
  `AppFeatureKindEntry`, `AppFeatureKindSetting` and the `AppSource` taxonomy. `App` gains `source`,
  `apiKey`, `address` and `eventsAccess`, and each `AppFeature` gains `entitled`,
  `requiredCapability` and `requiredPlan`.
- `FeatureKind.PayoutMethod`, `payoutMethod`, the payout kind's word in Siren and its documentation.
  `AppErrorCode` gains `AppNeedsAPart`, `FeaturesNeedKeyAndAddress`, `KeyExists`, `KeyMissing`,
  `AddressMissing` and `AppCapReached`.
- Custom events go out with short-lived app tokens. A client built with an app's key trades it at
  `POST /oauth/token` for a 20-minute token the first time `events.ingest()` sends a custom event,
  keeps it, renews it when fewer than two minutes are left, and after a 401 gets a new one and sends
  once more. A key of no app sends with the key as before, and sales, refunds and site visits keep
  the key. `events.browserToken(eventKey)` gets a 10-minute browser token for one event, and
  `events.browserTokenHandler({ events })` answers a page's request for one in Node's `(req, res)`
  or as a Web `Request`. `track(eventKey, data, { tokenUrl })` and `createTracker()` in
  `@novatorius/siren/storefront` send the event from a page with that token. The app file takes a
  custom event's `fields` and `domains`. examples/apps/signups holds a whole app.
- An app's problem contacts: `contacts`, at most ten email addresses, in the app file and in
  `apps.declare()`, `apps.create()` and `apps.update()`, which Siren tells when something is wrong
  with the app. `siren apps apply` shows a contacts line when the file names them.
- The README leads with what the SDK can do, the request handler and a mount sample for each
  server (node:http, Express, Fastify, a Next.js route, a Worker and `handle()`), then one section
  per feature kind under the dashboard's name with its question, answer and sample. Errors and
  retries, checking and answering by hand, custom events and the payout method each get a section. Every sample runs
  in test/apps-answer-samples.test.ts or test/apps-mount-samples.test.ts, and the kinds' samples are
  the dashboard feature page's own. test/fixtures/apps-feature-contracts/requests.json now holds
  Siren's question and answer for every kind.

### Changed

- The prepare script sends tsup's output to standard error, so `npm pack --json` prints JSON alone
  under every npm version. On a dry run with dist already built, it keeps that dist rather than
  rebuild it, since a dry run writes nothing.
- The 400 for a signed body that is not an app request of version 1 names the first field that
  breaks its rule, such as "The request's `id` must be `apr_` followed by 32 hex characters."
- The README leads with answering Siren: What you can do, Install with the branch install lines,
  Answer Siren in a few lines with no `baseUrl`, then Try it without Siren.

- The `siren` tool names each feature kind as Siren's dashboard does, beside its kind: Post-conversion
  action (`postConversionAction`), Post-allocation action (`postAllocationAction`) and Attribution
  model (`incentiveResolver`) replace Action after a conversion, Action after an allocation and
  Incentive resolver in `apps show`, `apps list`, `apps apply`, `apps requests` and the app file's
  messages. The other eleven names were already the dashboard's.
- `apps.rotate()` is gone with Siren's `POST /apps/{key}/rotate`. Call `apps.rotateKey()` and
  `apps.rotateSecret()`. The `RotatedApp` type stays, deprecated.
- `AppItemKind.FulfillmentMethod` is a deprecated alias whose value is now `payoutMethod`, as
  Siren's `AppItemKinds::FulfillmentMethod` is. `apps.declare()` and `apps.features.create()` refuse
  the old string `fulfillmentMethod` before sending, since Siren refuses it.
- `apps.declare()` takes an app with no `url`, a key-only app, and refuses features with no `url`
  before sending. `DeclaredApp` carries `rawKey` on the first declaration and `signingSecret`
  whenever the call made an address, so a later declaration that adds a `url` answers the new
  secret.
- An `UnexpectedResponseError` for a malformed app answer keeps the body as `data` without
  `rawKey` and `signingSecret`, so a caller that logs the error never logs a secret.
- `App.webhookSubscriptionId` and `App.apiKeyId` are optional and deprecated, since Siren no longer
  sends them. Read `address.id` and `apiKey.id`.
- The README no longer teaches `siren.apiKeys` or `webhooks.subscriptions.create()`. Siren answers
  every `/api-keys` route with 404 and `POST /webhooks` with 405, so the README gives a key and an
  address through `apps.create()`, `apps.update()`, `apps.createKey()`, `apps.rotateKey()` and
  `apps.revokeKey()`, with a signed-in session, and says the other `/webhooks` calls take a session
  too. It calls the `webhook-subscriptions:read` and `webhook-subscriptions:manage` scopes retired,
  since no API key may use a `/webhooks` route. `siren.apiKeys` and
  `webhooks.subscriptions.create()` are gone, as the Breaking entry above says.
- The rest of `siren.webhooks.subscriptions` is deprecated, each method naming the app call that
  replaces it, since an app holds its address now. Those methods stay until Siren removes
  `/webhooks`. openapi.yaml marks each old `/webhooks` operation `deprecated: true` and names the
  app route that replaces it. `AppErrorCode.AppOwnedSubscription` names Siren's 409
  `app_owned_subscription` for a webhook call on an address an app owns. The README's apps section
  describes an app's three parts and says "feature", as the code does.
- The app file's `url` is optional, so it can declare a key-only app. A file with features and no
  `url` is refused before anything is sent. The file takes `payoutMethod` and refuses
  `fulfillmentMethod` with a message that names the new word, refuses the app keys `events`,
  `scopes` and `kinds` beside `requests`, and its messages say feature where they said item.
  `siren apps apply` writes only the secrets Siren sent, so a key-only app gets no empty
  `SIREN_SIGNING_SECRET` line, and a later apply that adds a `url` saves the new signing secret.
- `siren apps apply` reads the app with `GET /apps/{key}` first and prints each change the file
  would make, with how many records select a feature it
  removes. It asks before it writes, says the last write wins, and takes `--yes` to skip the
  question. With no terminal and no `--yes` it sends nothing, and with nothing to change it says so
  and writes nothing. It compares the key's scopes in the form Siren stores them, so a file that
  names `*` beside event scopes matches on the next run.
- `siren apps rotate` splits in two, since an app's key and its signing secret change apart.
  `siren apps rotate-key` and `siren apps rotate-secret` each ask first, take `--yes`, and write
  only their own line to the env file, mode 0600, through a temporary file and a rename.
  `siren apps rotate` sends nothing, names the two, and exits 1, with or without a key. Every
  command that takes an app key refuses `requests`, `events`, `scopes` and `kinds` in its own
  words. Every hint that named
  `siren apps rotate`, `requests.answer()`'s 401 message included, names `rotate-key` when the app
  holds a key and `add-key` when it holds none. Apply on an app with no key names `add-key`, and
  `rotate-key`, `rotate-secret` and `add-key` turn Siren's 409 for a missing or existing part into
  the one command that fits the app. Apply and the three key commands refuse, before they send, an
  env file that holds `SIREN_BASE_URL`, `SIREN_API_KEY` or `SIREN_SIGNING_SECRET` on more than one
  line, and name the lines, so a rotation never leaves the revoked key on a line a loader reads.
- `siren apps show`, `list` and `apply` print `requires Pro`, or the plan Siren names in
  `requiredPlan`, beside a feature or the events the plan cannot use, and print the app's events.
  `apply` warns when the file names scopes and the app holds no key, and names
  `siren apps add-key <key>`, a new command that makes the key with `POST /apps/{key}/key` and
  writes it to the env file.
- The tool's output and the README say feature, as Siren's screens do. A record still selects a
  feature by `app:{id}`.
- The tool prints each feature kind's readable name beside its term, as Payout method
  (payoutMethod), in `show`, `list`, apply's changes, the request lines and the app file's
  messages. The README's feature table and prose do the same. The names are Siren's kinds catalog
  names.
- `apps.shownAmount()` gives `decimal` the sign `text` has, as Siren's `format()` prints it, so a
  negative that rounds to zero reads `-0.00` beside `-$0.00`, where `decimal` read `0.00`.
- The example app in examples/apps/acme declares its payout feature as `payoutMethod`, and its env
  reader names `rotate-key`, `add-key` or `rotate-secret` for each missing line. Its README walks
  through the question apply asks, the split rotation and the `requires Pro` mark. The signed
  request fixture is Siren's int/preview-apps copy, which carries `payoutMethod`.
- `siren apps requests <id>` reads an app's sends from `GET /apps/{key}/deliveries`, since Siren
  refuses the webhook routes for a subscription an app owns.
- `openapi.yaml` documents the new apps routes, the `AppFeaturePage`, `AppPlanAccess`,
  `AppFeatureKindEntry`, `AppCreate`, `AppChange` and `AppWithSecrets` schemas, `payoutMethod`, and an
  optional `url`, and drops `/apps/{key}/rotate` and `DeclaredApp`.

- `siren apps delete` says to turn an app off only while it is on, and otherwise that the records
  selecting its items must change. `siren apps resend` names `siren apps on <key>` when Siren refuses
  because the request's app is off. `requests.answer()` gives Siren's uncoded 401 a message that
  names `siren apps rotate <app key>` in place of "make a new one under API keys", with Siren's
  error as `cause`.
- `siren apps apply`, `list` and `show` mark an archived item beside it, and `apply` says once that
  Siren keeps such an item while a record selects it, never calls it, and brings it back when the
  app file names it again.
- README and the architecture note give both of Siren's wordings of the answer route's 404
  `app_request_not_found`: "This organization has no request with this key." for an admin and
  "No request with this key was sent to this app." for an app's key, as Siren's feat/apps says at
  27169452a. The status and the code did not change.
- `engines` asks for Node 18.3 or later, since the `siren` command uses `util.parseArgs`.
- `new Siren()` sends an `sk_test_` key to the sandbox when no `baseUrl` is given, and throws for a
  test key with the live address or a live key with the sandbox.
- A 401 is resent once with a refreshed token when the credential is an `AccessTokenSource` that
  can refresh, whether or not the request may be retried, because Siren answers a 401 before it
  records anything. The resend does not count against `maxRetries`. An `apiKey` is never
  refreshed, and a 403 or 409 is still sent once.
- A 3xx reply raises `SirenError` with its status. The SDK never follows a redirect, because a
  followed redirect would send the bearer token to another host.
- A 401 or 403 class is chosen by `error.code` when the SDK knows the code. A reply with no code,
  or one the SDK does not know, comes from an older or newer Siren deployment, so the SDK reads
  Siren's wording instead, as the Siren PHP SDK does.
- `events.siteVisited` is sent once and never retried, because Siren records every visit it
  receives. A retry after a lost reply would record the visit twice.
- `events.ingest` is sent once for every slug, built-in slugs such as `sale` included, because
  Siren has no key to match a resent custom event. Custom events are no longer retried.
- A sale with no `externalId`, or a `null` one, is sent once, whatever `test` holds. Siren gives a
  test sale with no id a random one, so a resent copy would record a second test, and it refuses a
  real sale with no id. A sale that carries an `externalId`, an empty one included, and a refund
  are still retried.

## [0.3.0] - 2026-10-19

### Added

- `@novatorius/siren/storefront`, a browser-safe subpath export. `SirenStorefront` records a
  referred visit (`recordVisit`) and claims an order for a visit token (`claimOrder`) through
  Siren's public storefront routes. It uses `fetch` and takes no API key. The subpath also exports
  the request and answer types, the storage key, the token pattern, the attribution window
  helpers, and `storefrontUrls`, which builds the visit and claim URLs from a source and its
  storefront key. The build has a separate entry (`dist/storefront.js`) with no Node built-ins.
- `npm install` from a Git reference builds `dist/` through a `prepare` script.

## [0.2.0] - 2026-10-19

This is a minor bump, because the changes below break existing callers. Each one follows a rule
Siren already enforces.

### Breaking

- `CreateApiKeyParams.scopes` is required, so TypeScript code that creates a key without scopes no
  longer compiles. Siren answers 400 to a key without scopes.
- `webhooks.constructEvent` returns the request body as `data`, and throws
  `SignatureVerificationError` when a bare payload arrives without the `X-Siren-Event` header. The
  three-argument call from 0.1.0 used to return an event with an empty type for every real
  delivery, which no handler matched. Pass the request headers as the fourth argument.
- `webhooks.constructEvent` throws `SignatureVerificationError` for a body that is not a JSON
  object. It used to throw the parser's `SyntaxError` for bad JSON and return empty data for any
  other value.

### Added

- An API key reads Siren's ledger and manages webhook subscriptions, as Siren Cloud 3.6.259
  allows. `conversions`, `transactions`, `obligations` and `payouts` take a key that holds the
  matching ledger scope. `webhooks.subscriptions.list` takes a key with
  `webhook-subscriptions:read` or `webhook-subscriptions:manage`, and `create` and `delete` take
  one with `webhook-subscriptions:manage`. Since Siren Cloud 3.6.260 that scope also sends a test
  delivery, and `openapi.yaml` lists the route, `POST /webhooks/{id}/test`.
- `ApiKeyScope` names the scopes a key may hold: `AllEvents`, `FullAccess`, `Sale`, `Refund`,
  `SiteVisited`, `LedgerConversionsRead`, `LedgerTransactionsRead`, `LedgerObligationsRead`,
  `LedgerPayoutsRead`, `WebhookSubscriptionsRead` and `WebhookSubscriptionsManage`.
  `LEDGER_READ_SCOPES` holds the four ledger scopes, and `eventScope(slug)` builds one event
  scope. Siren grants the ledger and webhook scopes only by their exact names, so `*`, `event:*`
  and older names such as `conversions:read` grant none of them.
- `ApiKeyNotAcceptedError` (401, `api_key_not_accepted`), raised when a route takes a session and
  not an API key, as every `apiKeys` route does. It extends `AuthenticationError`.
- `MissingScopeError` (403, `missing_scope`), with `scope` and `anyOf` from `error.context`, and
  `StoreKeyNotAllowedError` (403, `store_key_not_allowed`), raised when a key bound to one store
  asks for payouts or webhook subscriptions, with the key's `propertyId`. Both extend
  `PermissionError`. `ErrorCode` holds the three codes.
- `ListParams.propertyId` narrows an organization-wide ledger read to one store. A key bound to
  one store reads only its own store's rows.
- `webhooks.constructEvent` takes the request headers as a fourth argument and reads the event
  type from `X-Siren-Event` and the delivery id from `X-Siren-Delivery`.
- `WebhookEvent.body` holds the whole parsed body, so a connected site can read the envelope's
  `records`, `propertyId` and `kind`.
- `EventResult` carries what Siren did with the event: `status`, `body`, and `queued` when Siren
  queued the event (HTTP 202) because the organization's engine is paused. A queued visit's
  `opportunityId` is read from the body, where Siren reports it.
- `BadRequestError.fieldErrors`, read from `error.context.failedValidations`. Siren answers a failed
  validation with 400, and `code` is then `VALIDATION_FAILED`.
- `WebhookEventType` gains `ProgramCreated`, `CollaboratorUpdated`, `CollaboratorDeactivated`,
  `CreditIssued`, `CreditRedeemed`, `CurrencyCreated` and `CurrencyDeleted`, matching the 34 events
  Siren lists at `GET /webhooks/events`.
- `ListParams` accepts Siren's own `number` and `offset`.
- `ApiKey` and `WebhookSubscription` types list the fields Siren returns, such as `dateCreated`,
  `revokedAt`, `propertyId` and `urlValid`. `CreateApiKeyParams` accepts `expiresAt` and
  `propertyId`.

### Changed

- `CreateApiKeyParams.scopes` is required, and takes `ApiKeyScope` values or any other string.
  Siren refuses a key with no scopes, and an older resource scope such as `programs:read`.
- `SaleParams.currency` documents what Siren does: the code must be one the organization uses,
  and an omitted currency reads as the organization's default, not USD.
- `ApiKey.createdAt` and `WebhookSubscription.createdAt` are deprecated. Siren sends `dateCreated`.
- `CreateApiKeyParams.label` is optional, as it is in Siren, and is left out of the request when
  not given.
- `LineItem.name` is optional, because Siren needs only `amount`. `externalId` on a sale, a refund
  and a line item, and a line item's `name`, take a number too, which Siren stores as text.

### Fixed

- Reconciliation readers returned an empty array for every real response. Siren wraps lists as
  `{ items, total, page, perPage, totalPages }`, and the readers now read `items` and take
  `estimatedCount` from `total`. A bare array still works.
- Reconciliation readers sent `page` and `perPage`, which Siren ignores, so every call returned the
  first ten rows. They now send `number` and `offset`, lower a page size above 200 to 200 before
  working out the offset, and pass an explicit `number` or `offset` through.
- `webhooks.constructEvent` read `type`, `data` and `deliveryId` from the body, which Siren never
  sends. A real delivery parsed to an empty type and empty data. `data` is now the body, and the
  body of a Property-bound subscription's envelope is unwrapped. A body is read as an envelope only
  when its `id` and `type` match the `X-Siren-Delivery` and `X-Siren-Event` headers, or when
  neither header is passed, so a custom event's payload that holds `version`, `type` and `data`
  keys stays whole.
- Errors read `error.context`, which Siren sends, instead of only `error.data`, which it does not.
  When the body has no `code`, `context.type` fills it.
- `openapi.yaml` described every response as wrapped in `data`, list responses as bare arrays,
  paging as `page`/`perPage` with a maximum of 100, validation failures as 422, and API key scopes
  as optional. It now describes the routes as Siren serves them, adds `GET /webhooks/events`, the
  event outcome bodies and the 202 queued answer. Each operation lists the credentials it takes.
  The ledger and webhook operations take the `apiKey` scheme with the scopes each one needs, the
  API key routes take a dashboard session only, and the new error codes are listed.
  `GET /ping` is listed, and the page size schema no longer sets a maximum, because Siren lowers a
  larger size to 200.

## [0.1.0] - 2026-07-11

Initial public release of the Siren SDK for Node.js and TypeScript.

### Added

- `Siren` client with configurable `apiKey`, `baseUrl`, `timeout`, and `maxRetries`.
- Event ingestion via `events.sale`, `events.refund`, `events.siteVisited`, and `events.ingest`
  for custom event types. Ingestion auto-retries on network errors and 429/5xx responses.
- Line-item support on sales, with per-unit `amount` and a `quantity` that defaults to `1`.
- Signed-webhook verification: `webhooks.constructEvent` (verify and parse in one call) and
  `webhooks.verifySignature` (constant-time boolean check), both operating on raw request bytes.
- Webhook subscription management: `webhooks.subscriptions.create` / `list` / `delete`, and the
  `WebhookEventType` enum.
- API key management: `apiKeys.create` / `list` / `revoke`.
- Reconciliation readers for `conversions`, `transactions`, `obligations`, and `payouts`, with an
  `estimatedCount` derived from the `x-siren-estimated-count` response header when present.
- Typed error hierarchy rooted at `SirenError`: `BadRequestError`, `AuthenticationError`,
  `PermissionError`, `NotFoundError`, `ConflictError`, `ValidationError`, `RateLimitError`,
  `ApiError`, `ConnectionError`, and `SignatureVerificationError`.
- Dual ESM and CJS builds with full TypeScript declarations. Zero runtime dependencies.

[Unreleased]: https://github.com/Novatorius/siren-node/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Novatorius/siren-node/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Novatorius/siren-node/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Novatorius/siren-node/releases/tag/v0.1.0
