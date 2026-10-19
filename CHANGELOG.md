# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `webhooks.constructEvent` takes the request headers as a fourth argument and reads the event
  type from `X-Siren-Event` and the delivery id from `X-Siren-Delivery`.
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

- `CreateApiKeyParams.scopes` is required. Siren refuses a key with no scopes, and a key may hold
  event scopes only (`event:*`, `event:{slug}`, `*`).
- `SaleParams.currency` documents what Siren does: the code must be one the organization uses,
  and an omitted currency reads as the organization's default, not USD.
- `ApiKey.createdAt` and `WebhookSubscription.createdAt` are deprecated. Siren sends `dateCreated`.

### Fixed

- Reconciliation readers returned an empty array for every real response. Siren wraps lists as
  `{ items, total, page, perPage, totalPages }`, and the readers now read `items` and take
  `estimatedCount` from `total`. A bare array still works.
- Reconciliation readers sent `page` and `perPage`, which Siren ignores, so every call returned the
  first ten rows. They now send `number` and `offset`, lower a page size above 200 to 200 before
  working out the offset, and pass an explicit `number` or `offset` through.
- `webhooks.constructEvent` read `type`, `data` and `deliveryId` from the body, which Siren never
  sends. A real delivery parsed to an empty type and empty data. `data` is now the body, and the
  body of a Property-bound subscription's envelope is unwrapped.
- Errors read `error.context`, which Siren sends, instead of only `error.data`, which it does not.
  When the body has no `code`, `context.type` fills it.
- `openapi.yaml` described every response as wrapped in `data`, list responses as bare arrays,
  paging as `page`/`perPage` with a maximum of 100, validation failures as 422, and API key scopes
  as optional. It now describes the routes as Siren serves them, adds `GET /webhooks/events`, the
  event outcome bodies and the 202 queued answer, and states that on Siren Cloud an API key
  authenticates event ingestion only.

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

[Unreleased]: https://github.com/Novatorius/siren-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Novatorius/siren-node/releases/tag/v0.1.0
