# Slice 5: SDK connected-site surface

Slice 5 of the Siren Node commerce connectors build. It gives a connected
site what it needs to connect to Siren Cloud and stay connected: OAuth
registration with PKCE, the token calls, a client for the `/connect/*`
routes, and `events.forward` with typed envelopes. The connector core in
later slices calls all of it. Design: sections 3 and 4 of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

Seven packets built it, and a contract fix after the slice review
([PR audit: siren-node PR 37, slice 5 review (Journal 32315)](https://navigator.novatori.us/r/journal/32315))
tightened `OAuthClient`'s options, the refresh advice and the no-network
guard. The section "After the review" says what that fix changed.

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

The method names follow what each route does, not design gap 14's short
names: `reportSiteState`, `reportIntegrations` and `syncProducts` for the
site-state, integrations and products routes, and `webhook.replace` for the
webhook `PUT`. A report is a write the site sends from its task queue, and
`replace` rotates the signing secret, so a name like `siteState()` would
read as a harmless getter.

`ConnectResource` and `ConnectWebhookResource` are ordinary resources over
`HttpTransport`, so they follow the slice 2 rules without new code: one
resend with a refreshed token after the first 401, retries for retriable
calls, typed errors. `SirenConnect` builds the transport from `SirenConnectOptions`
through the same option code as `new Siren()` and exposes `connect` and
`events`.

`events.forward` lives on the main `EventsResource`, because an API key with
an exact `event:{slug}` scope may forward too.

## Wire rules

- Every OAuth call is sent exactly once. Cloud keeps a 30-second reuse
  window from the rotation: a repeat inside it that carries the same
  `attemptId` gets the pair Cloud already issued, and any repeat after it
  makes Cloud revoke the refresh token's whole family. A code is single
  use. The store locks its own refresh and gives each refresh a random
  `attemptId` from its first try. After a lost answer, a 429 or a 5xx it
  may resend that refresh once, with the same `attemptId`, and it sends
  that resend at once, as Siren's `OAuthConnectService` does. A request
  that cannot wait hands it to a background task that runs straight away,
  as Siren's `RetryLostRefresh` does. Nothing resends the refresh after
  that. The one resend is the only exception to
  [Retry Unification (KB 591)](https://navigator.novatori.us/r/kb/591)
  in this slice, because a queue waits minutes between tries and Cloud's
  window closes after 30 seconds.
- 400 or 401 with a text `error` raises `OAuthError`. A refresh refused with
  `invalid_grant` or `invalid_client` means the grant is gone, as Siren's
  `OAuthConnectService::grantIsGone` reads it. 429 and 5xx raise the usual
  `RateLimitError` and `ApiError`.
- The OAuth wait defaults to 15 seconds, Siren's own, half the grace window.
- `authorizeUrl` writes the query in `OAuthConnectService::begin()` order and
  refuses anything that is not a 43-character base64url challenge, so a
  verifier never reaches a browser.
- Retried connect routes: every read, `update-grant` (each send signs a
  fresh grant) and webhook `DELETE`. A site calls them inline, while a
  person waits or as a task starts. A store that calls one from its own
  queue builds its client with `maxRetries: 0`, so the queue's tries are
  the only ones. Sent once: the three reports
  (`site-state`, `integrations`, `products`), because a site sends them
  from its task queue and Siren's own reporters retry them there, webhook
  `PUT`, which rotates the secret, webhook test, which Cloud limits to ten a
  site an hour, and `disconnect`, because Cloud cuts the client off as it
  commits and answers a resend with 401.
- `events.forward` is sent once. After a 401 it sends again with a
  refreshed token, and only then, because Cloud refused the first send
  before it logged the event. The site's outbox, not the SDK, sends a
  failed event again, as
  [Retry Unification (KB 591)](https://navigator.novatori.us/r/kb/591)
  asks. Siren's own `ForwardedEventSender` sends once per outbox try and
  waits minutes between tries. The site mints `eventId` once, when it
  records the event, and the outbox resends with that `eventId` and the
  same credential. Cloud records an event once for each site (its
  Property), recognised by the event's natural key or by `eventId`, and
  answers a repeat `duplicate`, which the outbox counts as delivered.
  `finalAttempt` adds
  `X-Siren-Final-Attempt: 1` to the outbox's last try, so Cloud's log of an
  event it will never record matches one logged send.
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
| Connect route 429, 5xx or network failure, retried | `plan`, `migrationWindow`, `customerEmailKey`, `ping`, `updateGrant`, `webhook.get`, `webhook.deliveries` and `webhook.delete` retry, then raise `RateLimitError`, `ApiError` or `ConnectionError` |
| Connect route 429, 5xx or network failure, sent once | `reportSiteState`, `reportIntegrations` and `syncProducts` raise at once, and the site's queue reports again. `disconnect`, `webhook.replace` and `webhook.test` raise at once, and the store decides |
| `plan` 503 `plan_unavailable` | `ApiError` with that code once retries run out. The store logs it and keeps its last plan |
| `disconnect` resent after a lost answer | 401 or the store's `OAuthError` `invalid_grant`. The site is disconnected |
| `forward` 429, other 5xx or network failure | `RateLimitError`, `ApiError` or `ConnectionError`. The outbox tries again later with the same `eventId` and credential |
| `forward` 500 `waiting_for_record` | `ApiError` with the reason in `data`. The outbox tries again later |
| `forward` 404 `reference_not_found` | `NotFoundError` with the reason in `data`. The outbox tries again later, a bounded number of times, as Siren's `ForwardedEventSender` does |
| `forward` 401 | One resend with a refreshed token. A second 401 raises `AuthenticationError` |
| `forward` 400, 403, 409 or 422 | `BadRequestError`, `PermissionError`, `ConflictError` or `ValidationError`, with Cloud's reason in `data`. The outbox stops trying and keeps the event as failed |

## Edits to the transport and the client

Slice 2b hardened `src/http.ts` and `src/client.ts` before two packets
edited them, each with a small change:

- P6 added an optional `headers` field to `SirenRequest`. `buildRequest`
  merges it beneath the SDK's own headers, so a caller header never
  replaces `Authorization`, `Accept`, `User-Agent` or `Content-Type`.
- P5 moved the body of `Siren`'s constructor into an `@internal`
  `createHttpTransport(options)` in `client.ts`, unchanged, and exported
  `ownOption` as internal. `Siren` and `SirenConnect` both call it.

`OAuthClient` keeps its own copy of the token scrub (`redact`) rather than
importing `scrubTokens`, and the contract fix's packet F1 makes it read and
check its options through the same functions in `client.ts`.

## The build

A second Node entry would bundle its own copy of every shared class, and
`instanceof SirenError` would fail across entries. `splitting: true` makes
tsup put shared code in one chunk that both entries import, for ESM and CJS.
The storefront entry imports no chunk, and its build test still passes.
`test/connect-build.test.ts` checks the identity in both formats.

## Tests

The envelope types are vocabulary, and `test/types/forwarded-events.ts`
checks them at compile time against `test/fixtures/forwarded-event-fields.ts`,
the codec key lists copied from Siren with file and line. For each of the 16
typed slugs, the keys the type can carry equal the codec's accepted keys,
and the keys every form requires equal the codec's required keys, nested
objects included.

The acceptance tests take the integration shape per
[Integration Testing Standards (KB 568)](https://navigator.novatori.us/r/kb/568):
real resources, the real transport, and a fake at the `HttpClient` seam,
answered with bodies read from the cited Cloud controllers, each with its
file and line. Nobody captured them from a running Cloud, so a misread
status or key would pass every packet. Slice 20 of the design runs the
connector's golden path against a local Cloud, the first time these routes
meet a running one, and it captures these bodies there and swaps them in.
The hand-read bodies are the connect answers (`ConnectAnswers` in
`test/connect-fakes.ts`), the OAuth answers (`Cloud` in
`test/oauth-client.test.ts`), the event answers (`Answers` in
`test/forwarded-events.test.ts`) and the codec lists
(`test/fixtures/forwarded-event-fields.ts`). The Siren fixture script
(`scripts/siren-fixtures.mjs`) does not check them for drift.

| File | Packet |
|---|---|
| `test/pkce.test.ts` | P1 |
| `test/oauth-client.test.ts` | P2 |
| `test/connect-resource.test.ts` | P3 |
| `test/connect-webhook-resource.test.ts` | P4 |
| `test/siren-connect.test.ts` | P5 |
| `test/forwarded-events.test.ts` | P6, plus the slug vocabulary |
| `test/docs-connect.test.ts` | P7 |
| `test/oauth-client-options.test.ts` | F1, the contract fix |
| `test/types/forwarded-events.ts`, `test/connect-vocabulary.test.ts`, `test/connect-build.test.ts`, `test/no-network.test.ts`, `test/no-network-check.test.ts`, `test/docs-refresh.test.ts` | none |

Each packet committed its own mutation list,
`scripts/mutations/ncc-slice-5-pN.json`, against its real code. The surface
list (`scripts/mutations/ncc-slice-5-surface.json`) changes the vocabulary
and the no-network guard, and `scripts/mutations/ncc-slice-5-fix.json`
proves the contract fix's tests that run now. `scripts/mutations/ncc-slice-5-f1.json`
was proven against a scratch F1 constructor, so packet F1 re-points its
entries at its own lines.

## No test reaches the network

The Vitest config runs the no-network setup file (`test/setup/no-network.ts`)
before every test file. It replaces the global fetch with a guard that lets
a request to this machine through and fails any test that sends one
anywhere else, even when the code under test caught the error. It covers
only the global fetch, the one way the SDK sends today.
`test/no-network.test.ts` proves the guard refuses and records a host, and
`test/no-network-check.test.ts` runs a fixture in a child Vitest process to
prove the afterEach check fails a test that reached the network.

Every host those tests send to off this machine is under `.invalid`, a name
reserved never to resolve. A mutation that weakens the guard carries
`"offline": true` in its list, and the mutation harness refuses to score it
unless the process has no network interface but loopback:

```sh
unshare -rn sh -c 'ip link set lo up && node scripts/mutation-proof.mjs scripts/mutations/ncc-slice-5-surface.json'
```

## After the review

The slice review found five contract defects, K1 to K5, and asked for a
ruling on a sixth question.

- K1: the guard test sent its refused request to a Siren Cloud host, so a
  mutation that opened the guard sent one unauthenticated GET to
  production. Every guard test now aims at `.invalid`, and the harness
  runs guard mutations only without a route out.
- K2: `OAuthClient` took `baseUrl`, `consentScreenUrl`, `timeout` and
  `httpClient` without the checks `new Siren()` makes, so
  `https://api.sirenaffiliates.com@evil.invalid/siren/v1` sent a refresh
  grant to evil.invalid. Packet F1 makes it read only its own options, once
  each, and check them with `client.ts`'s functions and Siren's messages.
  `consentScreenUrl` takes the `baseUrl` rule, `?` and `#` included, because
  the SDK writes the link's only query.
- K3: the refresh advice now says the one resend runs at once and nothing
  resends after it.
- K4: `test/no-network-check.test.ts` proves the guard's afterEach check.
- K5: this note and the slice PR describe the slice as built.
- K6: the transport keeps the client error as `ConnectionError`'s cause
  when it carries none, while `OAuthClient` drops it. The transport's
  secret is the bearer token in a header, which the `HttpClient` contract
  forbids a client to quote. The OAuth secrets sit in the body, which the
  contract does not cover. The ruling keeps both as they are.
