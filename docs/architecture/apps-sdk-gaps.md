# Siren apps: SDK gaps

This note covers the apps-sdk-gaps slice of the Siren apps work, slice 6 of
its design. The slice gives the Node SDK the calls a service a customer
hosts needs before the apps resource lands: read one payout, read
fulfillments, manage one webhook subscription and read its deliveries, and
name every record scope an API key may hold. It follows the rules the
[slice 3](ncc-slice-3.md) and [slice 4](ncc-slice-4.md) notes set for record
resources and does not restate them.

Read from: Siren at `20c47873d` (`saas/Auth/ApiKeyRoutes.php`,
`lib/Fulfillments/Rest/Service`, `PayoutStatusFilterMiddleware.php`,
`lib/Webhooks/Service/Rest`, `lib/ApiKeys/Core/Enums/ApiKeyRecordScopes.php`)
and the Siren PHP SDK at `59383e6`, which is still its `origin/main`.

## What changes

| Call or name | Siren route | API key scope | Where |
|---|---|---|---|
| `payouts.retrieve(id, params)` | `GET /payouts/{id}` | `ledger:payouts:read`, organization keys only | `src/resources/payouts.ts` |
| `fulfillments.list(params)` | `GET /fulfillments` | `ledger:fulfillments:read`, organization keys only | `src/resources/fulfillments.ts` |
| `fulfillments.retrieve(id, params)` | `GET /fulfillments/{id}` | `ledger:fulfillments:read`, organization keys only | `src/resources/fulfillments.ts` |
| `webhooks.subscriptions.retrieve(id)` | `GET /webhooks/{id}` | `webhook-subscriptions:read` or `:manage`, organization keys only | `src/resources/webhooks.ts` |
| `webhooks.subscriptions.update(id, params)` | `PUT /webhooks/{id}` | `webhook-subscriptions:manage`, organization keys only | `src/resources/webhooks.ts` |
| `webhooks.subscriptions.test(id)` | `POST /webhooks/{id}/test` | `webhook-subscriptions:manage`, organization keys only | `src/resources/webhooks.ts` |
| `webhooks.subscriptions.deliveries(id)` | `GET /webhooks/{id}/deliveries` | `webhook-subscriptions:read` or `:manage`, organization keys only | `src/resources/webhooks.ts` |
| `ApiKeyRecordScope`, `API_KEY_RECORD_SCOPES` | none | none | `src/api-key-scopes.ts` |
| `Payout`, `FulfillmentPayout`, `Fulfillment`, `FulfillmentListParams` | none | none | `src/record-types.ts` |
| `UpdateWebhookSubscriptionParams`, `WebhookTestResult`, `WebhookDelivery` | none | none | `src/types.ts` |

`ApiKeyRoutes.php` lines 80 to 94 list each route with its scopes.
`src/client.ts` builds `siren.payouts` as a `PayoutsResource` and adds
`siren.fulfillments`. `src/index.ts` gains export lines only, and the new
record types reach the package through its `export type *` line. The README
carries a section for each call, the CHANGELOG names them under Unreleased,
and `openapi.yaml` describes the five routes it lacked. The version stays
0.3.0, and nothing publishes.

## Class roles

`PayoutsResource` and `FulfillmentsResource` extend `RecordsResource`, so
`list` keeps its `SirenList` shape. Both only read, since every payout and
fulfillment write moves money and Siren keeps those for a signed-in admin.
`PayoutsResource` keeps the reconciliation `list` that passes any key, as
conversions and transactions do, because payouts had that `list` before this
slice and changing it would change shipped behavior. `FulfillmentsResource`
replaces `list` with the strict one, since its `list` is new.

The subscription calls sit on the existing `WebhookSubscriptionsResource`
beside `create`, `list`, `events` and `delete`. They send through the
request helpers in `src/resources/record-requests.ts`, so no call sets its
own retry flag.

`ApiKeyRecordScope` sits beside `ApiKeyScope`, which stays at its eleven
names. Its thirty names follow `ApiKeyRecordScopes::DEFINITIONS` in order,
each the PHP constant's name in Pascal case. Six strings appear under both
objects, such as `ledger:payouts:read`.

## The rules each call follows

| Call | Helper | Retried | Refused before sending | Wrong 2xx shape |
|---|---|---|---|---|
| `payouts.retrieve` | `retrieveRecord` | yes | an id that is not a positive whole number | `UnexpectedResponseError` for a body that is not an object |
| `fulfillments.list` | `listRecords` with `LIST_FILTERS` | yes | a key outside `status`, `payoutStatus`, `currency`, `from`, `to` and the paging keys, `propertyId` included, an empty filter list, a comma in a filter, a `from` or `to` that is not a real `YYYY-MM-DD` day, and a `payoutStatus` or `currency` that is `""` or not a string | `UnexpectedResponseError` for a body that is not a record list, or a row that is not an object |
| `fulfillments.retrieve` | `retrieveRecord` | yes | an id that is not a positive whole number | as `payouts.retrieve` |
| `subscriptions.retrieve` | `readObject` | yes | an id that is not a positive whole number | `UnexpectedResponseError` for a body that is not an object |
| `subscriptions.update` | `writeRecord`, `PUT` | no | an id as above, and any key outside `UPDATE_FIELDS` (`targetUrl`, `events`, `status`, `description`), whatever its value | as above |
| `subscriptions.test` | `writeRecord`, `POST`, no body | no | an id as above | as above |
| `subscriptions.deliveries` | `readList` with a row check | yes | an id as above | `UnexpectedResponseError` for a body that is not an array, or a row that is not an object |

Every refusal is a `SirenError` and names the method. A read retries on a
lost connection, 429 and 5xx inside `maxRetries`. A write is sent once,
apart from the one resend after a 401 that every request gets.

- `update` sends a new object holding only the given `UPDATE_FIELDS`, built
  by `pickFields`, so a `toJSON` the caller's params inherit cannot change
  the body. Sending the same update after a lost answer sets the same
  values, so the caller may repeat it.
- `test` is sent once because each call makes Siren send a request. From
  one address, Siren allows 20 tests an hour for one subscription and 60 in
  all (`SendWebhookTest.php`), and answers more with a 429, raised as
  `RateLimitError`. It answers 409, raised as `ConflictError`, for a paused
  subscription, and 200 whether or not the delivery arrived, so the caller
  reads `delivered`.
- `subscriptions.retrieve` uses `readObject` rather than `retrieveRecord`,
  because `GetWebhookSubscription.php` reads no `fields`, `include` or
  `propertyId`. It takes no params.
- `fulfillments.list` refuses `""` for `payoutStatus` and `currency` because
  `PayoutStatusFilterMiddleware.php` reads `""` as no filter and answers every
  fulfillment, the rule `distributors.list` follows for a `metricType` of
  `""`. It refuses a list for either because the middleware matches one
  value, so a joined list would answer none.
- `propertyId` is refused on `fulfillments.list` and sent on both
  `retrieve` calls, as `retrieveRecord` sends it for every record.

## Errors

The transport maps every status, as the slice 1 note sets out. A key bound
to one store gets `StoreKeyNotAllowedError` on every call in this slice. A
key without the scope gets `MissingScopeError`. An unknown id gets
`NotFoundError`. `update` gets `BadRequestError` for a target URL that is not
a public https endpoint.

| Error | What the caller does |
|---|---|
| `SirenError` before sending | Fix the call |
| `NotFoundError`, `MissingScopeError`, `StoreKeyNotAllowedError`, `BadRequestError` | Set it aside. Siren answers the same until the data or the key changes |
| `ConflictError` from `test` | Start the subscription with `update(id, { status: 'active' })` first |
| `RateLimitError` from `test` | Wait for the hour to pass. Never loop at the call site |
| `RateLimitError`, `ConnectionError` or a 5xx `ApiError` from a read | The transport retried already. Try again later |
| `ConnectionError` or a 5xx `ApiError` from `update` | Send it again. The same update sets the same values |
| `UnexpectedResponseError` | Set it aside and report it. Siren answered in a shape the SDK does not know |

## Node leads PHP here

The Node connectors work kept Node to the PHP SDK's methods. This slice
adds seven calls the PHP SDK lacks, under the rule the Siren apps work
set: Node leads, each Node-only call is written into the README's parity
section, and a later slice gives the PHP SDK the same calls under the same
names. The README's second parity
table, "Node methods the PHP SDK does not have yet", lists them with three
older ones (`events.forward`, `conversions.recoverCreate` and
`transactions.recoverCreditCollaborator`). `test/docs-parity.test.ts` walks a
real client and fails when a public method is in neither table.

## Tests

The acceptance files take the integration shape the slice 3 note sets: the
real resource over the real `HttpTransport`, with `FakeHttpClient` at the
`HttpClient` seam and the reserved base URL `https://example.invalid`.

| File | Covers |
|---|---|
| `test/payouts-fulfillments.test.ts` | both resources, the client fields, and a read sent through the client's own `HttpClient` |
| `test/webhook-subscription-calls.test.ts` | the four subscription calls |
| `test/api-key-record-scopes.test.ts` | `ApiKeyRecordScope` against the fixture, and against `ApiKeyRecordScopes.php` when `SIREN_CHECKOUT` names a Siren checkout |
| `test/record-requests.test.ts` | `readList`'s `check` |
| `test/docs-apps-sdk-gaps.test.ts` | the README, CHANGELOG and `openapi.yaml` lines for this slice |
| `test/docs-parity.test.ts` | the second parity table and the walk over the client |

The answers in `test/sdk-gaps-fakes.ts` come from Siren's source at
`20c47873d`, each with the file it follows, and were not captured from a
running Siren. `scripts/mutations/apps-sdk-conventions.json` breaks each
guard once. Run it with only loopback up:

```sh
unshare -rn sh -c 'ip link set lo up && node scripts/mutation-proof.mjs scripts/mutations/apps-sdk-conventions.json'
```

## After the review

The slice merged into `feat/apps` at `cc652d8` with a README section and
tests but without this note, a CHANGELOG entry, the `openapi.yaml` routes,
the parity rows, a docs test or a mutation list. A conventions pass on
`pkt/apps-sdk-conventions` added each of them, and brought three calls in
line with the record rules:

- `deliveries` sent through the transport on its own. It now goes through
  `readList`, which gained an optional `check`, as `readObject` and
  `listRecords` have.
- `fulfillments.list` sent a `payoutStatus` or `currency` of `""`, which
  answers every fulfillment. It now refuses one, and refuses a list.
- No test proved `update` sends a new object. One does now.

## Left open

- The fixtures are read from Siren's source, not captured. Slice 8 runs a
  local Cloud and replaces them with captured answers.
- `GET /obligations/{id}` is served to `ledger:obligations:read`, and the SDK
  has no call for it.
- Siren refuses moving a store-bound subscription's URL off its site
  (`WebhookService::assertStaysOnSite`). Its status is not checked, and the
  `update` doc does not name it.
- `retrieve` on payouts and fulfillments sends `propertyId`, which neither
  route reads. It narrows nothing there.
- The test that reads `ApiKeyRecordScopes.php` runs only when
  `SIREN_CHECKOUT` is set, so `npm test` and CI compare against the fixture,
  which `scripts/siren-fixtures.mjs --check` keeps honest.
- The PHP SDK lacks every call in the second parity table and
  `ApiKeyRecordScope`. The apps-sdk-php slice adds them.
