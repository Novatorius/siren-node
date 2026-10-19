# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Novatorius/siren-node/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Novatorius/siren-node/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Novatorius/siren-node/releases/tag/v0.1.0
