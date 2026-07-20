# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Typed taxonomy exports so integrations use SDK types instead of magic strings:
  `EventSlug` (built-in ingestion slugs) and the status vocabularies
  `ConversionStatus`, `TransactionStatus`, `ObligationStatus`, `PayoutStatus`,
  `FulfillmentStatus`, `OpportunityStatus`, `ApiKeyStatus`, and
  `WebhookSubscriptionStatus`.
- `WebhookEventType`: added the missing `credit.issued`, `credit.redeemed`,
  `currency.created`, and `currency.deleted` events (also added to
  `openapi.yaml`), matching the full set Siren dispatches.

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
