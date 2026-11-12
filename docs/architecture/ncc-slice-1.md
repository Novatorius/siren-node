# Slice 1: SDK wire fixes

Slice 1 of the Siren Node commerce connectors build. It brings the Node SDK's
wire types, webhook event list, error classes and status vocabulary level with
Siren and the Siren PHP SDK, so the connector core in later slices can depend
on the SDK for every Cloud term. Design: section 3, gaps 1 to 7, of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

Read from: Siren `bb49b7d` and the Siren PHP SDK `59383e6b`.

## What changes

| Gap | Change | Where |
|---|---|---|
| 1 | `RefundParams` requires `refundId` and takes optional `amount`, `currency`, `lines` (`RefundLine`), `whole` and `kind` (`RefundKind`), the fields `RefundEventFactory` reads | `src/types.ts`, `src/taxonomy.ts` |
| 2 | `SaleParams` becomes `LiveSaleParams \| TestSaleParams`. A test sale takes `test: true` and needs no other field. `LineItem` gains `lineId` | `src/types.ts` |
| 3 | `SiteVisitedParams.collaboratorId` takes `number \| tracking:${string}` | `src/types.ts` |
| 4 | `WebhookEventType` holds all 64 events in Siren's `WebhookCatalog`. `webhooks.subscriptions.events()` reads `GET /webhooks/events` | `src/event-types.ts`, `src/resources/webhooks.ts` |
| 5 | `apiKeys.scopes()` reads `GET /api-keys/scopes` | `src/resources/api-keys.ts` |
| 6 | `SiteDisconnectedError`, `PolicyError`, `CodeConflictError`, `HoldConflictError`, `HoldConflictReason`, `UnexpectedResponseError`, `POLICY_ERROR_CODES`, `isKnownErrorCode`, and `ErrorCode` with every code Siren sends | `src/errors.ts` |
| 7 | `src/taxonomy.ts` with `EventSlug`, `RefundKind`, `EventStatus`, `EventReason` and the twelve record vocabularies | `src/taxonomy.ts` |
| CI | The test matrix adds Node 24 and 26, the newest stable line. Node 18 stays, as `engines` says `>=18` | `.github/workflows/ci.yml` |

`package.json` keeps version 0.3.0. Nothing publishes.

## Where each list comes from

- `WebhookEventType`: the 64 events of `WebhookCatalog::EVENTS` in Siren
  (`lib/Webhooks/Service/Services/WebhookCatalog.php`), plus `*`.
- `ErrorCode`: the 26 codes of Siren's `ApiErrorCode`
  (`lib/Core/Service/Rest/ApiErrorCode.php`).
- `EventStatus`: the statuses Siren's event factories answer with.
  `EventReason`: the reasons they give when an event earns nothing.
- The twelve record vocabularies: the Siren PHP SDK's `src/*Status.php` and
  `src/CustomCurrencyType.php`, holding the values Siren accepts today.
- `test/fixtures/webhook-events.json` and `test/fixtures/api-key-scopes.json`:
  generated from Siren's source by the fixture script
  (`scripts/siren-fixtures.mjs`), which writes the body each controller
  serves. The slice reviewer runs it with `--check` against the pinned Siren
  checkout before the slice merges. The scopes fixture holds no custom event
  types, which an organization adds at run time.
- `HoldConflictReason` and `ErrorCode` live with the error classes in
  `src/errors.ts`, since only errors use them. Every other vocabulary lives
  in `src/taxonomy.ts`.

## How errors are chosen

`errorFromResponse` keeps its status switch. Its 401 and 403 branches call
each specialized class's static `matches(message, code, data?)` in the PHP
SDK's order. Static `matches()` and `fromConflict()` mirror the PHP SDK's
exception classes, and new error classes in this SDK follow them:

- 401: `SiteDisconnectedError`, then `ApiKeyNotAcceptedError`, else `AuthenticationError`.
- 403: `MissingScopeError`, then `StoreKeyNotAllowedError`, then `PolicyError`, else `PermissionError`.

Each `matches()` follows one rule, taken from `ExceptionFactory.php` and the
PHP exception classes. When the reply's code is one `isKnownErrorCode` knows,
the code alone decides. When the code is missing or unknown, the reply comes
from an older or newer Siren deployment, and Siren's wording decides. The
wording each class looks for is in its doc comment and in the acceptance tests.

A 409 stays a plain `ConflictError` at the transport, as in PHP. The resource
that knows the conflict wraps it with `CodeConflictError.fromConflict` (aliases,
slice 3) or `HoldConflictError.fromConflict` (credit holds, slice 4).
`CodeConflictError` takes the held code and its type as constructor arguments,
unlike its siblings, which read their extra fields from `details.data`.
Siren's `code_held` reply carries only a message, so the code and type can
come only from the resource that asked for them. Slices 3 and 4 add those
resources, and their tests drive a real 409 through them to the class a
caller catches.

## Failure paths

The SDK is a client library with no logger and no `LoggerStrategy`. Every
failure reaches the caller as a thrown `SirenError` carrying the reply's
`statusCode`, message, `code` and `data`, and the caller's own logger
records it.

- **A reply the SDK cannot classify.** When a 401 or 403 carries no code Siren
  defines and no wording a class looks for, the caller gets the parent class,
  `AuthenticationError` or `PermissionError`, with everything Siren sent.
- **A catalog read with the wrong body.** `events()` and `scopes()` throw
  `UnexpectedResponseError`, an `ApiError`, when a 2xx body has the wrong
  shape: not a list, not an object, a group that is not a list, or an entry
  that is not an object. Its `statusCode` is the reply's status and its `data`
  holds the body. These two reads check their bodies because an empty catalog
  looks like a real answer. Siren builds both from constants, so a caller
  that sees one has a broken deployment, and the error is final.
- **Retries.** The transport retries a request marked `retriable` on 429, 5xx
  and a failed connection, up to `maxRetries`, which defaults to 2. It waits
  500 ms, doubling each time up to 8 s, and a `Retry-After` header sets the
  wait instead, also capped at 8 s. The two catalog reads, `events.sale` and
  `events.refund` are marked `retriable`, and tests pin each one.
  `events.siteVisited` is not, because Siren records every visit it
  receives. `events.ingest` is not, whatever its slug, and neither is a sale
  with no `externalId`. A sale
  that carries an `externalId`, test or real, keeps its retry, and a test
  pins that. A caller with a durable queue sets
  `maxRetries: 0`, because the queue owns redelivery, and an SDK retry inside
  a queued attempt would multiply the attempts.
- **What each error means for a retry.**

  | Error | Retry? |
  |---|---|
  | `RateLimitError`, 5xx `ApiError`, `ConnectionError` | Yes, by re-enqueueing the job. The transport has already tried `maxRetries` times, so never loop at the call site |
  | `UnexpectedResponseError` | No. The deployment is broken |
  | `SiteDisconnectedError` | No. Reconnect the site |
  | `PolicyError` | No. Change the request |
  | `CodeConflictError` | No. Free the code or pick another |
  | `HoldConflictError` with `no_credit` | No. Apply no credit |
  | `HoldConflictError` with `token_in_use` | Mint a new token and place a new hold. Never resend the same one |
  | `HoldConflictError` with a `null` reason | No. Apply no credit |
  | Any other 4xx (`BadRequestError`, `NotFoundError`, `ValidationError`, `AuthenticationError`, `PermissionError`) | No. Fix the request or the credentials |

  A 401, 403 or 409 is sent once, and a test pins that with retries on.
- **Sending an event twice.** Siren matches a sale by `source` and
  `externalId` and answers a replay with the first result, so a resent sale
  records nothing new. It records each `refundId` once per order. A caller
  keeps both keys from the store's own order and refund, never one per
  attempt. A `duplicate` status in the result is a success. Siren records
  every visit it receives (`SiteVisitedFactory`), so a visit is sent once.
  Siren matches no key on a custom event either, so `events.ingest` is sent
  once. That rule holds for every slug, so
  `ingest('site-visited', ...)` is sent once, the same as `siteVisited`. A test sale
  with no `externalId`, or a `null` one, gets a random id from
  `SaleEventFactory` (`first-call-` and 8 hex digits). A resent one records a
  second test transaction, so the organization's test history shows two
  tests where the store sent one. The SDK sends any sale whose `externalId`
  is missing or `null` once, and reads nothing else from the params. Siren
  reads `test` as true for `true`, `1`, `'1'` and `'true'`
  (`IsBoolean::parse`), so a check on `test === true` would miss a test
  sale from a JavaScript caller. A real sale with no `externalId` fails
  Siren's validation with a 400 and is never retried anyway, so the wider
  rule costs nothing. An empty string counts as an id. A sale that carries
  an `externalId` is matched by `source` and `externalId`, and a test sale
  with no `source` gets Siren's fixed test source, so both keep their retry.

## Why the vocabulary is written in full

The `WebhookEventType`, `ErrorCode`, `POLICY_ERROR_CODES`, `HoldConflictReason`
and taxonomy values, the request types for gaps 1 to 3, and
`UnexpectedResponseError`, which only passes its arguments on, are written in
full. A TypeScript `as const` object's type is its values, so the public
surface cannot be stubbed without them. The
[Architecture Phase Contract (KB 643)](https://navigator.novatori.us/r/kb/643)
allows this for surface whose type is its content, and a mutation run shows
each value's test fails when the value is broken.

Gaps 1 to 3 need no runtime change, because `events.sale`, `events.refund` and
`events.siteVisited` send the fields they are given. Their fixture tests pin
the JSON body at the network, so a change to those methods that drops a field
fails them.

## Classes and packets

| Packet | Class or method | Owns |
|---|---|---|
| P1 | `isKnownErrorCode`, `ApiKeyNotAcceptedError.matches`, `MissingScopeError.matches` and its scope fallback, `StoreKeyNotAllowedError.matches` | The known-code rule |
| P2 | `SiteDisconnectedError.matches` | after P1 |
| P3 | `PolicyError.matches`, `PolicyError.param` | after P1 |
| P4 | `CodeConflictError.fromConflict` | mechanical |
| P5 | `HoldConflictError.fromConflict`, `HoldConflictError.reason` | after P1 |
| P6 | `WebhookSubscriptionsResource.events()` | mechanical |
| P7 | `ApiKeysResource.scopes()` | mechanical |
| P8 | README, CHANGELOG and `openapi.yaml` for every change above | mechanical, docs |
| P9 | `events.siteVisited` sent once, and the event sends name their routes by `EventSlug` | mechanical |
| P10 | `events.ingest` sent once, a sale with no `externalId` sent once, and the README, CHANGELOG and note lines that say so | mechanical |

## Acceptance tests

- `test/wire-taxonomy.test.ts`: every vocabulary, pinned whole against Siren
  or the PHP SDK, and each built-in event scope against its `EventSlug`.
- `test/wire-events.test.ts`: the JSON body of a sale with `lineId`, a test
  sale, a partial and a whole refund, and a visit by tracking code. A sale
  and a refund are retried on a 503, and so is a test sale with an
  `externalId`, an empty one included. P9's tests send a visit once. P10's
  tests send a custom event, `ingest('site-visited', ...)`,
  `ingest('sale', ...)` and a sale with no `externalId` once, on a 503 and
  on a dropped connection, whatever `test` holds.
- `test/types/wire-types.ts`: compile-time contract, run by `npm run
  typecheck`. A refund without `refundId`, a real sale without `trackingId`,
  a bad `kind` and a bare text `collaboratorId` each fail to typecheck.
- `test/error-classes.test.ts`: P1 to P5, and two tests that every 409 stays a
  plain `ConflictError` and that each refusal is sent once with retries on.
  It sits apart from `test/errors.test.ts` so each packet's tests share one
  describe block.
- `test/catalog-reads.test.ts`: P6 and P7, against the generated fixtures in
  `test/fixtures/`.
- `test/docs-wire.test.ts`: P8. It reads `openapi.yaml`, the CHANGELOG and the
  README for each new field, route, event, code, method and class. The API
  reference documents the wire. The record vocabularies are SDK exports with
  no wire field of their own yet, so the CHANGELOG names them and the
  reference does not. P10's test reads the README and the CHANGELOG's
  Unreleased section for the two send-once rules, and refuses any sentence
  that says, without a "never", "not" or "no longer", that custom events,
  event ingestion or `events.ingest` retry.
- `test/webhooks.test.ts`: the event count test expects 64.

Each packet's tests carry the `it.skip` marker until its implementer removes
it.

These tests are the SDK's end-to-end proof for this slice. Each one sends a
real request through the client's transport to a stubbed `fetch` and checks
the body on the wire or the error a caller catches, with fixtures generated
from Siren's controllers. A run against a live Siren belongs to the connector
slices. Slice 20 runs a local Cloud in Docker for the golden path. Capturing
the two catalog bodies there and comparing them with `--check` is the live
check on this slice's fixtures, and the slice 1 packets leave it to slice 20.

The architect ran every acceptance test with its marker removed against a
scratch implementation in a separate clone, then against one mutation per
guard. The mutation harness (`scripts/mutation-proof.mjs`) scores each
mutation on the exit code of `npm test && npm run typecheck`.
`scripts/mutations/ncc-slice-1-surface.json` holds the mutations for the
surface this commit writes in full, and reproduces on this branch with
`node scripts/mutation-proof.mjs scripts/mutations/ncc-slice-1-surface.json`.
The packet mutations can't be reproduced from this branch. Each one edits a
line of the scratch implementation, which stays out of the repository so it
can't stand in for the packets. The pull request carries their output
unedited. The slice review re-proves each packet's tests against the real
implementation.

## Left for later slices

Typed `status` fields on records and `EventResult`, the record and forwarded
event scopes missing from `ApiKeyScope` (slices 3 and 4, with the record
resources), and the resources that raise `CodeConflictError` and
`HoldConflictError`.
