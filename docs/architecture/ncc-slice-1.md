# Slice 1: SDK wire fixes

Slice 1 of the Siren Node commerce connectors build. It brings the Node SDK's
wire types, webhook event list, error classes and status vocabulary level with
Siren and the Siren PHP SDK, so the connector core in later slices can depend
on the SDK for every Cloud term. Design: section 3, gaps 1 to 7, of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

Read from: Siren `bb49b7d`, the Siren PHP SDK `59383e6b`, and this branch,
which merges pull request 11 (`refundId` required) first.

## What changes

| Gap | Change | Where |
|---|---|---|
| 1 | `RefundParams` keeps the required `refundId` from pull request 11 and gains optional `amount`, `currency`, `lines` (`RefundLine`), `whole` and `kind` (`RefundKind`), the fields `RefundEventFactory` reads | `src/types.ts`, `src/taxonomy.ts` |
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
- `EventStatus` and `EventReason`: the statuses and reasons Siren's event
  factories answer with. Reasons have their own vocabulary, so a status union
  never accepts a reason.
- The twelve record vocabularies: the Siren PHP SDK's `src/*Status.php` and
  `src/CustomCurrencyType.php`, holding the values Siren accepts today.
- `test/fixtures/webhook-events.json` and `test/fixtures/api-key-scopes.json`:
  generated from Siren's source by `scripts/siren-fixtures.mjs`, which writes
  the body each controller serves. Run it with `--check` against a Siren
  checkout to find a fixture that no longer matches. The scopes fixture holds
  no custom event types, which an organization adds at run time.

## How errors are chosen

`errorFromResponse` keeps its status switch. Its 401 and 403 branches now call
each specialized class's static `matches()` in the PHP SDK's order, where they
used to compare `parsed.code` inline:

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
come only from the resource that asked for them.

## Failure paths

- **A reply the SDK cannot classify.** When a 401 or 403 carries no code Siren
  defines and no wording a class looks for, the caller gets the parent class,
  `AuthenticationError` or `PermissionError`. Every class keeps the reply's
  status, message, `code` and `data`, so nothing Siren sent is lost when the
  wording fallback misses.
- **A catalog read with the wrong body.** `events()` and `scopes()` throw
  `UnexpectedResponseError`, an `ApiError`, when a 2xx body has the wrong
  shape: not a list, not an object, an entry that is not an object, or a group
  that is not a list. Its `statusCode` is the reply's status and its `data`
  holds the body, so the caller sees what Siren sent. A wrong body never reads
  as an empty catalog.
- **Retries.** Slice 1 adds no retry logic. The two new reads use the shared
  transport's existing rule, set on each request by `retriable`: a read is
  retried on 429 and 5xx up to `maxRetries`, and nothing else is. A caller
  that owns its own retries, such as a durable queue in the connector slices,
  sets `maxRetries: 0`.
- **Which refusals are final.** A 401, 403 or 409 is sent once, and a test
  pins that with retries on. `SiteDisconnectedError` and `PolicyError` mean
  stop: reconnect the site or change the request. `CodeConflictError` means
  free the code or pick another. `HoldConflictError` with `no_credit` means
  apply no credit, and with `token_in_use` means mint a new token and place a
  new hold, never resend the same one.
- **Sending an event twice.** Siren records each `refundId` once per order,
  so a refund sent again is not counted twice. A caller derives `refundId`
  from the store's own refund, never per attempt. Slice 1 does not change how
  sales are matched.

## What the architecture commit already holds, and why

The vocabulary is written in full here: the `WebhookEventType`, `ErrorCode`,
`POLICY_ERROR_CODES`, `HoldConflictReason` and taxonomy values, the request
types for gaps 1 to 3, and `UnexpectedResponseError`, which only passes its
arguments on. A TypeScript `as const` object's type is its values, so the
public surface cannot be stubbed without them. The
[Architecture Phase Contract (KB 643)](https://navigator.novatori.us/r/kb/643)
allows this, for surface whose type is its content. Their tests pass on this
commit, and a mutation run shows each one fails when a value or field is
broken.

Gaps 1 to 3 need no runtime change, because `events.sale`, `events.refund` and
`events.siteVisited` already send the fields they are given. Their fixture
tests pin the JSON body at the network, so a later change to those methods
that drops a field fails them.

The three existing 401 and 403 classes keep today's code-only `matches()` in
this commit, and the new `matches()` stubs answer `false`, so `errorFromResponse`
classifies every reply as it does on the base branch until the packets land.
Packet P1 adds the known-code rule and the wording fallback to them.

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

## Acceptance tests

- `test/wire-taxonomy.test.ts`: every vocabulary, pinned whole against Siren
  or the PHP SDK. Passes now.
- `test/wire-events.test.ts`: the JSON body of a sale with `lineId`, a test
  sale, a partial and a whole refund, and a visit by tracking code. Passes now.
- `test/types/wire-types.ts`: compile-time contract, run by `npm run
  typecheck`. A refund without `refundId`, a real sale without `trackingId`,
  a bad `kind` and a bare text `collaboratorId` each fail to typecheck.
- `test/error-classes.test.ts`: P1 to P5, marked `it.skip`, plus two tests
  that pass now: every 409 stays a plain `ConflictError`, and each refusal is
  sent once with retries on.
- `test/catalog-reads.test.ts`: P6 and P7, marked `it.skip`, against the
  generated fixtures in `test/fixtures/`.
- `test/docs-wire.test.ts`: P8, marked `it.skip`. It reads `openapi.yaml`,
  the CHANGELOG and the README for each new field, route, event, code, method
  and class.
- `test/webhooks.test.ts`: the existing event count test now expects 64.

These tests are the SDK's end-to-end proof for this slice. Each one sends a
real request through the client's transport to a stubbed `fetch` and checks
the body on the wire or the error a caller catches, with fixtures generated
from Siren's controllers. A run against a live Siren belongs to the connector
slices, which prove the whole flow on UAT.

Every acceptance test was run with its marker removed against a scratch
implementation in a separate clone, then run against one mutation per guard.
`scripts/mutation-proof.mjs` does the mutation runs and scores each one on the
exit code of `npm test && npm run typecheck`.
`scripts/mutations/ncc-slice-1-surface.json` holds the mutations for the
surface this commit writes in full, and reproduces on this branch with
`node scripts/mutation-proof.mjs scripts/mutations/ncc-slice-1-surface.json`.
The packet mutations need an implementation to break, so they ran against the
scratch implementation, which stays out of the repository so that it does not
stand in for the packets. The pull request carries their output.

## Left for later slices

Typed `status` fields on records and `EventResult`, the record and forwarded
event scopes missing from `ApiKeyScope` (slices 3 and 4, with the record
resources), and the resources that raise `CodeConflictError` and
`HoldConflictError`.
