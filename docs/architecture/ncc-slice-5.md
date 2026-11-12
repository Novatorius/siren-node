# Slice 5: SDK connected-site surface

Slice 5 of the Siren Node commerce connectors build. It gives a connected
site what it needs to connect to Siren Cloud and stay connected: OAuth
registration with PKCE, the token calls, a client for the `/connect/*`
routes, and `events.forward` with typed envelopes. The connector core in
later slices calls all of it. Design: sections 3 and 4 of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

Read from Siren `b6f7140d0`, the tip of `feat/node-commerce-connectors`,
which holds `main` and slice 14's `software_id` and site customer types:
`lib/EventForwarding/Core` (the slug enum, `EventWireFormat`, the codecs and
wire formats), `lib/OAuth` (`OAuthService`, `ConnectorSoftware`,
`OAuthScopeMiddleware`), `saas/Rest/OAuth`, `saas/Rest/Connector`,
`lib/Webhooks/Service/Rest/Connector`, `lib/Connect/Service/Services`
(`OAuthConnectService`, `ForwardedEventSender`) and the developer guide.

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
envelope to `OAuthError`. It holds no state. The store keeps the client id,
the state, the verifier and the token pair, and locks its own refresh (A20).

`ConnectResource` and `ConnectWebhookResource` are ordinary resources over
`HttpTransport`, so they get the slice 2 rules for free: one resend with a
refreshed token after the first 401, retries for retriable calls, typed
errors. `SirenConnect` builds the transport from `SirenConnectOptions`
through the same option code as `new Siren()` and exposes `connect` and
`events`.

`events.forward` lives on the main `EventsResource`, because an API key with
an exact `event:{slug}` scope may forward too.

## Wire rules

- Every OAuth call is sent exactly once. Cloud revokes a refresh token's whole
  family when it sees the token again more than 30 seconds after rotation,
  and a code is single use. The caller retries a refresh with the same
  `attemptId`, which Cloud answers with the pair it already issued.
- 400 or 401 with a text `error` raises `OAuthError`. A refresh refused with
  `invalid_grant` or `invalid_client` means the grant is gone, as Siren's
  `OAuthConnectService::grantIsGone` reads it. 429 and 5xx raise the usual
  `RateLimitError` and `ApiError`.
- The OAuth wait defaults to 15 seconds, Siren's own, half the grace window.
- `authorizeUrl` writes the query in `OAuthConnectService::begin()` order and
  refuses anything that is not a 43-character base64url challenge, so a
  verifier never reaches a browser.
- Retried connect routes: every read, the idempotent `PUT`s, `update-grant`
  (each send signs a fresh grant), `disconnect` (Cloud answers a repeat as
  done) and webhook `DELETE`. Sent once: webhook `PUT`, which rotates the
  secret, and webhook test, which Cloud limits to ten a site an hour.
- `events.forward` is retried, because Cloud claims each forwarded event once
  by its natural key or `event:{eventId}` and answers a repeat `duplicate`.
  It refuses, before sending, a slug outside the 28 (or it would become a
  custom event), a version other than 1, a non-UUID `eventId`, an origin
  other than `site`, an `occurredAt` without an offset, and non-object
  `data`. `finalAttempt` adds `X-Siren-Final-Attempt: 1`.

## Edits to files 2b also touches

The architecture commit touches neither `src/http.ts` nor `src/client.ts`.
Two packets must, and each keeps the change small:

- P6 adds an optional `headers` field to `SirenRequest` and merges it into
  `buildRequest` below the SDK's own headers, so a caller header never
  replaces `Authorization`, `Accept`, `User-Agent` or `Content-Type`.
- P5 moves the body of `Siren`'s constructor into an `@internal`
  `createHttpTransport(options)` in `client.ts`, and `SirenConnect` calls it.
  P5 starts after 2b merges, so it moves 2b's hardened code, not today's.

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
answered with bodies read from the cited Cloud controllers. Nobody captured
them from a running Cloud. Slice 20 does that. No test reaches the network:
the files that build real clients replace the global fetch with one that
fails the test.

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

In a separate clone, each skipped test was unskipped against the stubs and
failed on its assertion, except eleven the stubs already meet. A scratch
implementation of all seven packets passed all 723 tests and was thrown
away. A run of 112 mutations against it, one per rule, with the harness's
controls, scored as expected once a malformed test title was fixed.
The packet mutation lists target that scratch code and stay in the run
folder. `scripts/mutations/ncc-slice-5-surface.json` changes the branch's own
vocabulary and runs here.
