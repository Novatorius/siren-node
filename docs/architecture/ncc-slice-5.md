# Slice 5: SDK connected-site surface

Slice 5 of the Siren Node commerce connectors build. It gives a connected
site what it needs to connect to Siren Cloud and stay connected: OAuth
registration with PKCE, the token calls, a client for the `/connect/*`
routes, and `events.forward` with typed envelopes. The connector core in
later slices calls all of it. Design: sections 3 and 4 of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

This note records the architecture commit. Its Stubs, Tests and packet
sections describe the branch before the seven packets land.

It reads Siren at `b6f7140d0`, the tip of `feat/node-commerce-connectors`,
which holds `main` and slice 14's `software_id` and site customer types.
The parts it reads:

- the event forwarding core, with the slug enum, `EventWireFormat`, the
  codecs and the wire formats (`lib/EventForwarding/Core`)
- the OAuth library, with `OAuthService`, `ConnectorSoftware` and
  `OAuthScopeMiddleware` (`lib/OAuth`)
- the OAuth and connector REST controllers (`saas/Rest/OAuth`,
  `saas/Rest/Connector`, `lib/Webhooks/Service/Rest/Connector`)
- the site side of a connection, `OAuthConnectService` and
  `ForwardedEventSender` (`lib/Connect/Service/Services`)
- the developer guide

## What changes

| Piece | Where | Entry |
|---|---|---|
| Envelope types for 28 slugs, 16 of them typed key for key, plus `ForwardedEventSlug` and `FORWARDED_EVENT_VERSION` | `src/connect/forwarded-events.ts` | main and connect |
| `events.forward(slug, envelope, { finalAttempt })` | `src/resources/events.ts` | main |
| `createCodeVerifier`, `createState`, `codeChallengeS256` | `src/connect/pkce.ts` | connect |
| `OAuthClient`: `register`, `authorizeUrl`, `exchangeCode`, `refresh`, and `OAuthError` | `src/connect/oauth.ts`, `errors.ts` | connect |
| `ConnectResource` and `ConnectWebhookResource` over `HttpTransport` | `src/connect/connect-resource.ts`, `connect-webhook-resource.ts` | connect |
| `SirenConnect`: `connect` and `events` with the site's token | `src/connect/siren-connect.ts` | connect |
| `ConnectScope` (six scopes), `ConnectorSoftware`, `OAuthErrorCode` | `src/connect/scopes.ts`, `types.ts` | connect |
| `./connect` in the export map, a third tsup entry, shared chunks | `package.json`, `tsup.config.ts` | |
| `/connect/*`, `/oauth/register`, `/oauth/token` and the envelope in `openapi.yaml`, README, CHANGELOG | docs | |

The version stays 0.3.0, `engines` stays `node >=18`, and nothing publishes.

## Class roles

`OAuthClient` is the one piece that sends without a token. It speaks the
RFC 6749 and 7591 calls through the `HttpClient` seam directly, with no
`Authorization` header, and maps Cloud's `{ error, error_description }`
envelope to `OAuthError`. It holds no state. It takes camelCase parameters
and answers Cloud's bodies in the RFCs' snake_case, unchanged, because a
store saves the registration and the token pair as the RFCs name them and
an answer read field for field could drop a field Cloud adds later. The store keeps the client id,
the state, the verifier and the token pair, and locks its own refresh.

`ConnectResource` and `ConnectWebhookResource` are ordinary resources over
`HttpTransport`, so they follow the slice 2 rules without new code: one
resend with a refreshed token after the first 401, retries for retriable
calls, typed errors. `SirenConnect` builds the transport from `SirenConnectOptions`
through the same option code as `new Siren()` and exposes `connect` and
`events`.

`events.forward` lives on the main `EventsResource`, because an API key with
an exact `event:{slug}` scope may forward too.

## Wire rules

- Every OAuth call is sent exactly once. Cloud revokes a refresh token's whole
  family when it sees the token again more than 30 seconds after rotation,
  and a code is single use. The store locks its own refresh. It may resend a
  refresh within 30 seconds with the same random `attemptId`, which Cloud
  answers with the pair it already issued.
- 400 or 401 with a text `error` raises `OAuthError`. A refresh refused with
  `invalid_grant` or `invalid_client` means the grant is gone, as Siren's
  `OAuthConnectService::grantIsGone` reads it. 429 and 5xx raise the usual
  `RateLimitError` and `ApiError`.
- The OAuth wait defaults to 15 seconds, Siren's own, half the grace window.
- `authorizeUrl` writes the query in `OAuthConnectService::begin()` order and
  refuses anything that is not a 43-character base64url challenge, so a
  verifier never reaches a browser.
- Retried connect routes: every read, the idempotent `PUT`s, `update-grant`
  (each send signs a fresh grant) and webhook `DELETE`. Sent once: webhook
  `PUT`, which rotates the secret, webhook test, which Cloud limits to ten a
  site an hour, and `disconnect`, because Cloud cuts the client off as it
  commits and answers a resend with 401.
- `events.forward` is sent once, never retried. A forwarded event is queue
  work, and the site's outbox owns redelivery, as
  [Retry Unification (KB 591)](https://navigator.novatori.us/r/kb/591)
  asks. Siren's own `ForwardedEventSender` sends once per outbox try and
  waits minutes between tries. The outbox resends with the same `eventId`,
  which Cloud claims once and answers `duplicate`. `finalAttempt` adds
  `X-Siren-Final-Attempt: 1` to the outbox's last try, so Cloud's log of an
  event it will never record matches one send.
- `forward` refuses, before sending, a slug outside the 28 (or it would
  become a custom event), a version other than 1, a non-UUID `eventId`, an
  origin other than `site`, an `occurredAt` without an offset, and
  non-object `data`.

## Failure paths

The SDK has no logger. Each failure reaches the caller as a thrown error.

| Failure | What the caller gets |
|---|---|
| A bad argument to any method | `SirenError` before sending, quoting no secret or envelope value |
| OAuth 400 or 401 with a text `error` | `OAuthError` with Cloud's code and status. Sent once |
| OAuth 3xx | `SirenError` with the status. Never followed |
| OAuth 429 or 5xx | `RateLimitError` or `ApiError`. Sent once |
| OAuth network failure | `ConnectionError` with the client error's own cause and no grant in it. Sent once |
| A 2xx without the shape a method names | `UnexpectedResponseError`, with no secret from the body in it |
| Connect route refused for scope | `MissingScopeError` with the scope, or `PermissionError` for `/ping` |
| Connect route 401 | One resend with a refreshed token, as slice 2 sends it |
| Connect route 429, 5xx or network failure | Retried for the retried routes. The others raise at once |
| `plan` 503 `plan_unavailable` | `ApiError` with that code once retries run out. The store logs it and keeps its last plan |
| `disconnect` resent after a lost answer | 401 or the store's `OAuthError` `invalid_grant`. The site is disconnected |
| `forward` 500 `waiting_for_record` | `ApiError` with the reason in `data`. The outbox tries again later |
| `forward` 409, 404 or 422 | `ConflictError`, `NotFoundError` or `ValidationError`. The outbox stops trying |

## Edits to files slice 2b also touches

Slice 2b hardens the transport and has not merged. It edits `src/http.ts`
and `src/client.ts`, and the architecture commit touches neither. Two
packets must, and each keeps the change small:

- P6 adds an optional `headers` field to `SirenRequest` and merges it into
  `buildRequest` below the SDK's own headers, so a caller header never
  replaces `Authorization`, `Accept`, `User-Agent` or `Content-Type`.
- P5 moves the body of `Siren`'s constructor into an `@internal`
  `createHttpTransport(options)` in `client.ts`, and `SirenConnect` calls it.
  P5 starts after slice 2b merges, so it moves the hardened code.

P2 may export `scrubTokens` from `http.ts` instead of copying it.

## The build

A second Node entry would bundle its own copy of every shared class, and
`instanceof SirenError` would fail across entries. `splitting: true` makes
tsup put shared code in one chunk that both entries import, for ESM and CJS.
The storefront entry imports no chunk, and its build test still passes.
`test/connect-build.test.ts` checks the identity in both formats.

## Tests

The envelope types are vocabulary, written in full now, and
`test/types/forwarded-events.ts` checks them at compile time against
`test/fixtures/forwarded-event-fields.ts`, the codec key lists copied from
Siren with file and line. That file is the done condition for the 16 slugs:
the keys each type can carry equal the codec's accepted keys, and the keys
every form requires equal the codec's required keys, nested objects
included. The entry and build tests run now too.

Everything else is skipped with `it.skip` or `it.skip.each`, one packet per
describe block. Integration shape per
[Integration Testing Standards (KB 568)](https://navigator.novatori.us/r/kb/568):
real resources, the real transport, and a fake at the `HttpClient` seam,
answered with bodies read from the cited Cloud controllers, each with its
file and line. Nobody captured them from a running Cloud, so a misread
status or key would pass every packet. Slice 20 of the design runs the
connector's golden path against a local Cloud, the first time these routes
meet a running one. The hand-read bodies live in `test/connect-fakes.ts`
(`ConnectAnswers`), the `Cloud` object in `test/oauth-client.test.ts`, the
`Answers` object in `test/forwarded-events.test.ts` and the codec lists in
`test/fixtures/forwarded-event-fields.ts`. `scripts/siren-fixtures.mjs` does
not check them for drift.

No test reaches the network. `vitest.config.ts` runs `test/setup/no-network.ts`
before every file. It replaces the global fetch with a guard that lets a
request to this machine through and fails any test that sends one anywhere
else, even when the code under test caught the error.

| File | Packet |
|---|---|
| `test/pkce.test.ts` | P1 |
| `test/oauth-client.test.ts` | P2 |
| `test/connect-resource.test.ts` | P3 |
| `test/connect-webhook-resource.test.ts` | P4 |
| `test/siren-connect.test.ts` | P5 |
| `test/forwarded-events.test.ts` | P6, plus the slug vocabulary, which runs now |
| `test/docs-connect.test.ts` | P7 |
| `test/types/forwarded-events.ts`, `test/connect-vocabulary.test.ts`, `test/connect-build.test.ts` | none, they run now |

## Stubs

Each stub returns a fixed value of its type and never throws. The PKCE stubs
answer zeros, the OAuth calls send nothing, the connect methods send nothing,
`forward` resolves `{}`, and `SirenConnect` builds a placeholder transport
whose client answers every send itself.

## Proof

Against the stubs, every skipped test fails on its assertion except eleven,
each a guard the stubs already meet. A throwaway implementation of all
seven packets passed all 723 tests, and each of 112 mutations against it,
one per rule, scored as its control predicted.
`scripts/mutations/ncc-slice-5-surface.json` changes the branch's own
vocabulary and runs here.
