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
| 6 | `SiteDisconnectedError`, `PolicyError`, `CodeConflictError`, `HoldConflictError`, `HoldConflictReason`, `POLICY_ERROR_CODES`, `isKnownErrorCode`, and `ErrorCode` with every code Siren sends | `src/errors.ts` |
| 7 | `src/taxonomy.ts` with `EventSlug`, `RefundKind`, `EventStatus`, `EventReason` and the twelve record vocabularies | `src/taxonomy.ts` |
| CI | The test matrix adds Node 24 and 26, the newest stable line. Node 18 stays, as `engines` says `>=18` | `.github/workflows/ci.yml` |

`package.json` keeps version 0.3.0. Nothing publishes.

## How errors are chosen

`errorFromResponse` keeps its status switch. The 401 and 403 branches now ask
each specialized class's static `matches()` in the PHP SDK's order:

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

## What the architecture commit already holds, and why

The vocabulary is written in full here: the `WebhookEventType`, `ErrorCode`,
`POLICY_ERROR_CODES`, `HoldConflictReason` and taxonomy values, and the request
types for gaps 1 to 3. A TypeScript `as const` object's type is its values, so
the public surface cannot be stubbed without them. This is the tolerated case
in the architecture contract. Their tests pass on this commit, and the proof
below shows each one fails when a value or field is broken.

Gaps 1 to 3 need no runtime change, because `events.sale`, `events.refund` and
`events.siteVisited` already send the fields they are given. Their fixture
tests pin the JSON body at the network, so a later change to those methods
that drops a field fails them.

The three existing 401 and 403 classes keep today's code-only `matches()` in
this commit, so the current suite stays green. Packet P1 adds the known-code
rule and the wording fallback to them.

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
- `test/error-classes.test.ts`: P1 to P5, marked `it.skip`.
- `test/catalog-reads.test.ts`: P6 and P7, marked `it.skip`, against fixtures
  built from Siren's controllers in `test/fixtures/`.
- `test/webhooks.test.ts`: the existing event count test now expects 64.

Every acceptance test was run with its marker removed against a scratch
implementation in a separate clone, then run against one mutation per guard.
`scripts/mutation-proof.mjs` does the mutation runs and scores each one on the
exit code of `npm test && npm run typecheck`. The pull request carries the
output.

## Where this differs from the design

- The design counts 22 missing webhook events. Siren's catalog at `bb49b7d`
  holds 64, so 30 were missing. The five `collaborator_group.*` and three
  `program_group.*` events were left out of the count.
- `ErrorCode` follows Siren's own list (`lib/Core/Service/Rest/ApiErrorCode.php`),
  26 codes. That is the PHP SDK's 21 live codes plus five the PHP SDK lacks.
- Values the PHP SDK keeps only for old PHP callers stay out: `HoldLimitError`,
  the `hold_limit` code, and the `fulfilled` obligation status.
- `EventStatus` follows Siren's lists, which add `checked`, and the reasons
  move to their own `EventReason`, since a status union that holds reasons
  would accept a reason as a status.

## Left for later slices

Typed `status` fields on records and `EventResult`, the record scopes missing
from `ApiKeyScope` (slices 3 and 4, with the record resources), and the
resources that raise `CodeConflictError` and `HoldConflictError`.
