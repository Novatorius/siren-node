# Slice 2: SDK auth and transport

Slice 2 of the Siren Node commerce connectors build. It lets the Node SDK send
an OAuth token that refreshes itself, send through a host's own HTTP stack,
name the scopes a connected site asks for, and read one conversion or
transaction. The connector core in later slices needs all four. Design:
section 3, gaps 8 to 11, of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

Read from: the Siren PHP SDK `59383e6` (`src/HttpTransport.php` lines 81 to
118, `src/Auth`, `src/Http`, `src/ConnectorScope.php`, `src/Siren.php`) and
Siren `bb49b7d` (`saas/Auth/ConnectorTokenMiddleware.php`,
`saas/Strategies/RestStrategy.php`, `GetConversionById`, `GetTransactionById`).

## What changes

| Gap | Change | Where |
|---|---|---|
| 8 | `AccessTokenSource` (`getAccessToken`, `refreshAccessToken(rejected)`), `StaticAccessToken`, `CallbackAccessTokenSource`. `new Siren()` takes `apiKey` or `accessToken`, a string or a source. The transport refreshes once after a 401 and resends, writes included | `src/auth/`, `src/http.ts`, `src/client.ts`, `src/types.ts` |
| 9 | `HttpClient` with one method, `send(request): Promise<HttpResponse>`, plus `HttpRequest`, `HttpResponse`, `HttpClientError` and the default `FetchHttpClient`. `new Siren()` takes `httpClient` | `src/http.ts` |
| 10 | `ConnectorScope`: `ConnectAll`, `Webhooks`, `RecordsRead`, `RecordsWrite`, `CONNECTED_SITE` and `forConnectedSite()` | `src/auth/connector-scope.ts` |
| 11 | `conversions.retrieve(id, params)` and `transactions.retrieve(id, params)` on new `ConversionsResource` and `TransactionsResource` classes | `src/resources/records.ts` |

`package.json` keeps version 0.3.0 and `engines` keeps `node >=18`. Nothing
publishes. `DEFAULT_MAX_RETRIES` stays 2, which is on the morning agenda.

## Class roles

```
Siren (client.ts)
  resolves apiKey | accessToken -> AccessTokenSource
  resolves httpClient           -> HttpClient (FetchHttpClient by default)
  builds one HttpTransport and hands it to every resource

HttpTransport (http.ts, internal)
  reads the token, builds an HttpRequest, sends it through the HttpClient,
  refreshes once on a 401, retries retriable requests, maps errors,
  hands resources an ApiResponse (status, headers.get, text)

Resources (events, webhooks, apiKeys, RecordsResource,
           ConversionsResource, TransactionsResource)
  build a SirenRequest and say whether it is retriable
```

The internal transport class was called `HttpClient`. It is now
`HttpTransport`, the PHP SDK's name, and `HttpClient` names the public seam,
as in PHP. `src/index.ts` never exported the old class, so no caller breaks.
The transport hands resources an `ApiResponse`, the part of the Fetch
`Response` they already read, so no resource changes beyond its import.

The SDK stays free of TS Nomad (A21). The connector core adapts its
`FetchStrategy` to `HttpClient` in a later slice.

## The 401 rule

The transport mirrors `HttpTransport.php` lines 81 to 118:

1. It reads the token once per call, before the first send.
2. On the first 401 of the call, it asks the source for a new token, passing
   the token that was refused. A non-empty string is sent at once in a new
   request with the same method, URL and body. `null` or an empty string
   raises the 401.
3. A second 401 in the same call never refreshes again. It goes through
   `errorFromResponse`, so Siren's revoked-site answer (401,
   `site_disconnected`, "This site is no longer connected.") raises
   `SiteDisconnectedError`, and any other 401 raises `AuthenticationError`.
4. An error from either token method reaches the caller unchanged, and
   nothing more is sent. No token appears in an error the SDK raises.

An `apiKey` or a string `accessToken` becomes a `StaticAccessToken`, which
answers `null`, so its 401 surfaces after one send, as in 0.3.0.

The SDK never shares one refresh between calls that fail together. Each call
refreshes at most once, and the source keeps its own lock. In the connector
core that lock is `RefreshLock` (slice 11), and the source answers the stored
token when another caller already rotated it, as Siren's
`ConnectionAccessTokenSource` does in PHP.

## How the resend counts against send-once

Slice 1 made some requests send-once (A67, PR-A6): `events.siteVisited`,
`events.ingest` for every slug, a sale with no `externalId`, and the
management writes `apiKeys.create` and `webhooks.subscriptions.create`. Siren
cannot match a resent copy of any of them, so a retry after a lost reply would
record the event twice.

A resend after a 401 cannot record anything twice, because Siren recorded
nothing the first time. Siren answers 401 from its authentication layer
before the route runs. On event ingestion, `ApiKeyAuthMiddleware` checks the
key or the connected site's token before the event controller. On the record
and connect routes, `ConnectorTokenMiddleware` refuses a revoked or cut-off
site with `site_disconnected`, and a token it cannot verify leaves the
request with no organization, which `RestStrategy` answers with 401
"Authentication required." the moment the route reaches organization data,
before any write.

So the resend is not a retry, and the rule is:

- The resend after the first 401 applies to every request, `retriable` or
  not, and does not use up one of `maxRetries`.
- A send-once request reaches Siren with a usable credential exactly once.
  It is sent at most twice: the refused send and the resend. After the resend
  it is never sent again, whatever the reply: a 503, a 429 or a dropped
  connection surfaces at once.
- A retriable request keeps its `maxRetries` retries around the resend. It is
  sent at most `maxRetries + 2` times.

Tests pin each of these for every send-once request the SDK has today
(`test/http-transport.test.ts`). The record writes that slices 3 and 4 add
are not retried, as in PHP, and they take the same rule through the same
`retriable: false` flag.

## The HttpClient seam

`send(request)` gets a request with the URL, query string included, every
header and the body already built, and `timeout` in milliseconds. It answers
an `HttpResponse` for every status, 4xx and 5xx included, with the body as
text and headers the SDK reads in any case. It rejects with `HttpClientError`
only when no response arrived. The SDK may resend those, then raises
`ConnectionError`, whose `cause` is the `HttpClientError`'s own `cause`
(fetch's error, for `FetchHttpClient`), as PHP does and as 0.3.0 did. Any
other error from the client reaches the caller unchanged and is never resent,
because the SDK cannot tell whether that request left.

`FetchHttpClient` sends the headers as the same plain object, reads the
global `fetch` at each send unless given one, aborts on the timeout, and
writes every reply header under its lower-case name.

## Retrieve

`retrieve(id, params)` sends `GET /conversions/{id}` or
`GET /transactions/{id}` with `fields` (a list is sent comma-separated),
`include` and `propertyId`. It is a read, so it retries on 429, 5xx and a
dropped connection. It throws `SirenError` before sending when `id` is not a
positive whole number, as PHP's `recordPath` does. Siren's 404 ("No record
found with that ID.", which a key bound to another store also gets) raises
`NotFoundError`. A 2xx body that is not a JSON object raises
`UnexpectedResponseError` with the status and the body, as slice 1's catalog
reads do (A119), because an empty record would look like a real one.
`obligations` and `payouts` keep the list reader only, as in PHP.

## Failure paths

The SDK has no logger. Every failure reaches the caller as a thrown error:

| Failure | What the caller gets |
|---|---|
| Missing, double or empty credential, bad `accessToken`, `httpClient` without `send` | `SirenError` from the constructor |
| The token store throws | That error, unchanged. Nothing sent |
| 401 and the source cannot refresh | The 401's `AuthenticationError` or `SiteDisconnectedError` |
| The refresh throws | That error, unchanged. Nothing more sent |
| 401 again after the resend | `SiteDisconnectedError` for a revoked site, else `AuthenticationError` |
| No response, retries used up | `ConnectionError`, `cause` set |
| A host client bug | That error, unchanged. Never resent |
| Bad record id | `SirenError`. Nothing sent |
| A record body that is not an object | `UnexpectedResponseError` |

## Tests

Acceptance tests are written in full and skipped with `it.skip`, which the
packet's implementer turns into `it` (A113). The vocabulary in
`ConnectorScope` runs now. Integration shape per
[Integration Testing Standards (KB 568)](https://navigator.novatori.us/r/kb/568):
the real client, transport and resources, with the network mocked only at
the `HttpClient` seam (`test/http-fakes.ts`) or at the global `fetch`
(`test/helpers.ts`). `FetchHttpClient` runs against a real HTTP server on
127.0.0.1. Cloud answers come from Siren's source at `bb49b7d`, cited beside
each one. The transport and client tests stub the global `fetch` with a
tripwire, so a transport that ignores its client fails on that and never
reaches the network.

| File | Packet |
|---|---|
| `test/access-token-sources.test.ts` | P1, P2 |
| `test/fetch-http-client.test.ts` | P3 |
| `test/http-transport.test.ts` | P4 |
| `test/siren-options.test.ts` | P5, and the done condition through the whole stack |
| `test/connector-scope.test.ts` | P6 |
| `test/records-retrieve.test.ts` | P7 |
| `test/docs-slice-2.test.ts` | P8 |

## The stubs and the 0.3.0 send path

Until P4 lands, `HttpTransport.request` keeps the 0.3.0 body: it sends
through the global `fetch`, reads the token once and never refreshes. Until
P5 lands, the constructor takes an `apiKey` only and hands the transport an
inline source that answers it. That keeps the existing suite green on the
architecture commit. P4 replaces the body, and P5 replaces the constructor's
resolution. Every other new body returns a fixed value of its type.

## Proof

Each acceptance test was unskipped against the stubs and failed on its
assertion, except nine guards the stubs already satisfy. A scratch
implementation of all eight packets passed the whole suite, then was thrown
away. A mutation run against it, one mutation per guard with the harness's
three controls, scored every mutation as expected after one test fix. The
packet mutation lists, the scratch patch and the outputs stay in the run
folder, as in slice 1 (A114). The surface list,
`scripts/mutations/ncc-slice-2-surface.json`, runs on this branch.
