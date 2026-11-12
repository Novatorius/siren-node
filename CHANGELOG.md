# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

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
- `webhooks.subscriptions.events()` reads `GET /webhooks/events`, the event types Siren delivers,
  and `apiKeys.scopes()` reads `GET /api-keys/scopes`, the scopes a new key may hold, grouped by
  resource. Both throw `UnexpectedResponseError` when Siren answers with a body of the wrong shape.
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

### Changed

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
