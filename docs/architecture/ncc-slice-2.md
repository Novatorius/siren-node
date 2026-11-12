# Slice 2: SDK auth and transport

Slice 2 of the Siren Node commerce connectors build. It lets the Node SDK send
an OAuth token that refreshes itself, send through a host's own HTTP stack,
name the scopes a connected site asks for, and read one conversion or
transaction. The connector core in later slices needs all four. Design:
section 3, gaps 8 to 11, of
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).

Read from: the Siren PHP SDK `59383e6` (`src/HttpTransport.php` lines 81 to
118, `src/Auth`, `src/Http`, `src/ConnectorScope.php`, `src/Siren.php`) and
Siren `bb49b7d` (`saas/Auth/ApiKeyAuthMiddleware.php`,
`saas/Auth/ConnectorTokenMiddleware.php`, `saas/Strategies/RestStrategy.php`,
`GetConversionById`, `GetTransactionById`).

## What changes

| Gap | Change | Where |
|---|---|---|
| 8 | `AccessTokenSource` (`getAccessToken`, `refreshAccessToken(rejected)`), `StaticAccessToken`, `CallbackAccessTokenSource`. `new Siren()` takes `apiKey` or `accessToken`, a string or a source. The transport refreshes once after a 401 and resends, writes included | `src/auth/`, `src/http.ts`, `src/client.ts`, `src/types.ts` |
| 9 | `HttpClient` with one method, `send(request): Promise<HttpResponse>`, plus `HttpRequest`, `HttpResponse`, `HttpClientError` and the default `FetchHttpClient`. `new Siren()` takes `httpClient` | `src/http.ts` |
| 10 | `ConnectorScope`: `ConnectAll`, `Webhooks`, `RecordsRead`, `RecordsWrite`, `CONNECTED_SITE` and `forConnectedSite()` | `src/auth/connector-scope.ts` |
| 11 | `conversions.retrieve(id, params)` and `transactions.retrieve(id, params)` on new `ConversionsResource` and `TransactionsResource` classes | `src/resources/records.ts` |

The version is 0.3.0, `engines` is `node >=18`, and nothing publishes.
`DEFAULT_MAX_RETRIES` is 2. A caller with a durable queue sets
`maxRetries: 0`, because its queue owns redelivery, as
[Retry Unification (KB 591)](https://navigator.novatori.us/r/kb/591) asks.
The connector core is that caller. Slice 11, which builds `SdkProviderClient`
and `SdkRemoteIngest` over the SDK, passes 0 and carries that as an
acceptance test. The one resend after a 401 stays outside the queue's count,
because it renews a credential Siren refused before doing any work, and
nothing Siren recorded can repeat.

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

`HttpTransport` is the internal transport. `HttpClient` is the public seam,
as in PHP, and `HttpClientError` sits beside it in `http.ts`, as PHP keeps
`HttpClientException` beside `HttpClient`. The transport hands resources an
`ApiResponse`, the part of the Fetch `Response` they read, so no resource
changes beyond its import.

The SDK stays free of TS Nomad. The connector core adapts its
`FetchStrategy` to `HttpClient` in a later slice.

`ConnectorScope` carries the four scopes, `CONNECTED_SITE` and
`forConnectedSite()` on one object, as PHP's `ConnectorScope` class carries
its constants and static method. Its type comes from the four values, so the
two cannot drift. It sits in `src/auth/` beside the token sources, since a
host asks for these scopes in the OAuth flow that produces the token.

## The 401 rule

The transport mirrors the PHP SDK's refresh loop (`HttpTransport.php` lines
81 to 118):

1. It reads the token once per call, before the first send, and every send of
   the call carries it until a refresh replaces it. A token that is not a
   non-empty string, or that holds a control character such as a line break,
   raises `SirenError`, naming `getAccessToken` and never quoting the value,
   and nothing is sent. A line break in a header would make fetch quote the
   whole value in its error.
2. On the first 401 of the call, it asks the source for a new token, passing
   the token that was refused. A non-empty string with no control character
   goes out at once, with no wait, in a new request with the same method, URL
   and body. Any other answer raises the 401.
3. A later 401 in the same call, with or without retries in between, never
   refreshes again. It goes through `errorFromResponse`, so Siren's
   revoked-site answer (401, `site_disconnected`, "This site is no longer
   connected.") raises `SiteDisconnectedError`, and any other 401 raises
   `AuthenticationError`.
4. No other status refreshes. A 403 for a missing scope, a 404 or a 409 goes
   out once and is raised.
5. An error from either token method reaches the caller unchanged, and
   nothing more goes out. That error replaces the 401, so a source whose
   refresh Siren refuses answers `null` and lets the disconnect surface. It
   throws only for a fault, such as an unreachable token store, as Siren's
   own `ConnectionAccessTokenSource` does in PHP. The host's source owns any
   logging of that fault, since the SDK has no logger.

An `apiKey` or a string `accessToken` becomes a `StaticAccessToken`, which
answers `null`, so its 401 surfaces after one send.

The SDK never shares one refresh between calls that fail together. Each call
refreshes at most once, and the source keeps its own lock. In the connector
core that lock is `RefreshLock` (slice 11), and the source answers the stored
token when another caller already rotated it.

On event routes Siren names a revoked site in other words, with no code
(`ApiKeyAuthMiddleware` lines 384 and 394), so that answer raises
`AuthenticationError` with Siren's message. A test pins this. The fix
belongs in Siren, which should send `site_disconnected` there too.

## How the resend counts against send-once

Slice 1 made some requests send-once: `events.siteVisited`, `events.ingest`
for every slug, a sale with no `externalId`, and the management writes
`apiKeys.create` and `webhooks.subscriptions.create`. Siren cannot match a
resent copy of any of them, so a retry after a lost reply would record the
event twice.

A resend after a 401 cannot record anything twice, because Siren recorded
nothing the first time. At `bb49b7d`, every 401 these routes send comes from
middleware, or from a request with no accepted credential, before any write.
On event ingestion, `ApiKeyAuthMiddleware` checks the key or the connected
site's token before the event controller. On the record and connect routes,
`ConnectorTokenMiddleware` refuses a revoked or cut-off site with
`site_disconnected`. A token it cannot verify leaves the request with no
organization, and `RestStrategy` answers 401 "Authentication required." when
the route first reaches organization data, before it writes. Once a
credential is accepted, `RestStrategy` turns a refused permission into a 403,
not a 401.

That holds by route convention, not by the shape of the auth layer: a route
that wrote before it first read organization data could send a 401 after a
write. The record write routes of slices 3 and 4 must be checked against this
rule when they land.

So the resend is not a retry, and the rule is:

- The resend after the first 401 applies to every request, `retriable` or
  not, and does not use up one of `maxRetries`.
- A send-once request reaches Siren with a usable credential exactly once.
  It goes out at most twice: the refused send and the resend. After the
  resend it never goes out again, whatever the reply: a 503, a 429, a second
  401 or a dropped connection surfaces at once. A first send that fails for
  any other reason is never retried either.
- A retriable request keeps its `maxRetries` retries around the resend. It
  goes out at most `maxRetries + 2` times. At `maxRetries: 0` it goes out
  once, or twice when the first reply is a 401.

Tests pin each of these for every send-once request the SDK has today
(`test/http-transport.test.ts`). The record writes that slices 3 and 4 add
are not retried, as in PHP, and they take the same rule through the same
`retriable: false` flag.

## The HttpClient seam

`send(request)` gets a request with the URL, query string included, every
header and the body already built, and `timeout` in milliseconds. It answers
an `HttpResponse` for every status, 3xx, 4xx and 5xx included, with the body
as text and headers the SDK reads in any case.

A client never follows a redirect. PHP's client refuses to, because a
followed redirect would send the bearer token to another host and could turn
a write into a bodiless GET. `FetchHttpClient` sends with
`redirect: 'manual'`, and the transport raises a 3xx as `SirenError` with its
status and never sends it again.

A client rejects with `HttpClientError` only when no complete response
arrived: no connection, a timeout, or a connection that dropped while the
body was read. The SDK may resend those, then raises `ConnectionError`, whose
`cause` is the `HttpClientError`'s own `cause` (fetch's error, for
`FetchHttpClient`), as PHP does. The `ConnectionError` message carries the
client error's message with every token the call sent replaced. Any other
error from the client reaches the caller unchanged and is never resent,
because the SDK cannot tell whether that request left.

The request's headers carry a live credential, so the seam's contract asks a
client to keep them out of its errors. The SDK keeps tokens out of every
error it builds. It cannot clean an error a host client builds, and it hands
that error on as `cause` unchanged.

`FetchHttpClient` sends the headers as the same plain object, reads the
global `fetch` at each send unless given one, counts the body read in the
timeout, and writes every reply header under its lower-case name.

## Retrieve

`retrieve(id, params)` sends `GET /conversions/{id}` or
`GET /transactions/{id}` with `fields` (a list is sent comma-separated),
`include` and `propertyId`. `include` stays a string, because Siren owns that
vocabulary and names one value today, `extended`. It is a read, so it retries
on 429, 5xx and a dropped connection.

It throws `SirenError` before sending when `id` is not a positive whole
number, a string included, as PHP's `recordPath` does, and the message names
the id it got.
Siren's 404 ("No record found with that ID.", which a key bound to another
store also gets) raises `NotFoundError`. A 2xx body that is not a JSON object
raises `UnexpectedResponseError`, as slice 1's catalog reads do, because an
empty record would look like a real one. The error carries the status, the
path with the id, and the parsed body as `data`, which is `undefined` when the
body is empty or is not JSON. `obligations` and `payouts` keep the list
reader only, as in PHP.

## Failure paths

The SDK has no logger. Every failure below but the last reaches the caller as
a thrown error:

| Failure | What the caller gets |
|---|---|
| Missing, double or empty credential, bad `accessToken`, `httpClient` without `send` | `SirenError` from the constructor, with no credential in it |
| The token store throws | That error, unchanged. Nothing sent |
| The token store answers no token, or one with a control character | `SirenError` naming `getAccessToken`, without the value. Nothing sent |
| 401 and the source cannot refresh | The 401's `AuthenticationError` or `SiteDisconnectedError` |
| The refresh throws | That error, unchanged. Nothing more sent |
| 401 again after the resend | `SiteDisconnectedError` for a revoked site, else `AuthenticationError` |
| A redirect | `SirenError` with the 3xx status. Never followed |
| No complete response, retries used up | `ConnectionError`, `cause` set, tokens removed from its message |
| A host client bug | That error, unchanged. Never resent |
| Bad record id | `SirenError` naming the id. Nothing sent |
| A record body that is not an object | `UnexpectedResponseError` with the status, path and parsed body |
| A list body that is neither a list nor a list envelope | An empty page, as before this slice. This slice leaves that reading alone |

## Tests

Acceptance tests are written in full and skipped with `it.skip` or
`it.skip.each`. The packet's implementer deletes the `.skip` from every one
of its own tests and leaves none skipped. The vocabulary in `ConnectorScope`
runs now. Integration shape per
[Integration Testing Standards (KB 568)](https://navigator.novatori.us/r/kb/568):
the real client, transport and resources, with the network mocked only at
the `HttpClient` seam by the fake client (`test/http-fakes.ts`), or at the
global `fetch` by the existing helper (`test/helpers.ts`) where a test runs
the default client. New transport tests use the fake client.
`FetchHttpClient` runs against a real HTTP server on 127.0.0.1, and one
done-condition test runs the whole client through it.

The Cloud answers in the fake client come from reading Siren's source at
`bb49b7d`, cited beside each one. Nobody captured them from a running Cloud,
so they can drift. Slice 20, which runs the connectors against a local Cloud,
captures them and refreshes the fixtures. The transport and client tests replace the global `fetch`
with a stub that fails the test when called, so a transport that ignores its
client fails on that and never reaches the network.

The slice owes no end-to-end test. Per
[End-to-End Testing Standards (KB 569)](https://navigator.novatori.us/r/kb/569),
an SDK proves itself against real wire shapes, and the real-socket tests
cover the one boundary this slice adds. A run against a live Cloud waits for
the connector slices.

| File | Packet |
|---|---|
| `test/access-token-sources.test.ts` | P1, P2 |
| `test/fetch-http-client.test.ts` | P3 |
| `test/http-transport.test.ts` | P4 |
| `test/siren-options.test.ts` | P5, and the done condition at the seam and over a real socket |
| `test/connector-scope.test.ts` | P6 |
| `test/records-retrieve.test.ts` | P7 |
| `test/docs-slice-2.test.ts` | P8 |

## The stubs and the interim send path

Until P4 lands, `HttpTransport.request` sends through the global `fetch`,
reads the token once and never refreshes. Until P5 lands, the constructor
takes an `apiKey` only and hands the transport an inline source that answers
it. That keeps the existing suite green on the architecture commit. P4
replaces the transport's body, and P5 replaces the constructor's resolution.
Every other new body returns a fixed value of its type. The two token
sources' stubs answer an empty string from `refreshAccessToken`, not the
documented `null`, so the `null` tests fail against them.

## Proof

Each acceptance test was unskipped against the stubs and failed on its
assertion, except nine tests the stubs already pass. A scratch implementation
of all eight packets passed the whole suite, then was deleted. A mutation run
against it, one mutation for each rule a test checks, with the harness's
three controls, scored every mutation as expected. The packet mutation lists
target that scratch code, so they stay in the run folder with the scratch
patch and the outputs, as in slice 1. The surface mutation list, which
changes the branch's own code (`scripts/mutations/ncc-slice-2-surface.json`),
runs here.
