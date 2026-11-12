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
   the call carries it until a refresh replaces it. A token that fails the
   bearer token rule (see "Hardening (2b)") raises `SirenError`, naming
   `getAccessToken` and never quoting the value, and nothing is sent.
2. On the first 401 of the call, it asks the source for a new token, passing
   the token that was refused. An answer that passes the bearer token rule
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
| Missing, double or empty credential, an `apiKey` or string `accessToken` that fails the bearer token rule, bad `accessToken`, `httpClient` without `send` | `SirenError` from the constructor, with no credential in it |
| A `timeout` or `maxRetries` out of range | `SirenError` from the constructor, naming the option and what it got |
| The token store throws | That error, unchanged. Nothing sent |
| The token store answers a token that fails the bearer token rule | `SirenError` naming `getAccessToken`, without the value. Nothing sent |
| 401 and the source cannot refresh | The 401's `AuthenticationError` or `SiteDisconnectedError` |
| The refresh throws | That error, unchanged. Nothing more sent |
| 401 again after the resend | `SiteDisconnectedError` for a revoked site, else `AuthenticationError` |
| A redirect | `SirenError` with the 3xx status. Never followed |
| No complete response, retries used up | `ConnectionError`, tokens removed from its message. Its `cause` is the host's error as the host built it, so a host client that put the token in its error leaks it there |
| A host client bug | That error, unchanged. Never resent |
| Bad record id | `SirenError` naming the id. Nothing sent |
| A record body that is not an object | `UnexpectedResponseError` with the status, path and parsed body |
| A list body that is neither a list nor a list envelope | An empty page |

## Tests

The acceptance tests take the integration shape of
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
cover the `FetchHttpClient` boundary. A run against a live Cloud waits for
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
| `test/bearer-token.test.ts` | 2b P1 |
| `test/siren-option-checks.test.ts` | 2b P2, and 2c P1 for the baseUrl character rule |
| `test/siren-option-resolvers.test.ts` | 2b P2, unit tests for the constructor's resolvers |
| `test/docs-hardening.test.ts` | The 2b and 2c README and CHANGELOG lines |

## Hardening (2b)

These rules govern the inputs the transport takes: the bearer token, the
client options and where the client reads them from. Each rule throws
`SirenError` for a value outside it. The public surface keeps its names and
types. The review that set them is
[PR audit: siren-node PR 26, slice 2 review (Journal 32275)](https://navigator.novatori.us/r/journal/32275).
The baseUrl character rule came from the slice 2b review,
[PR audit: siren-node PR 36, slice 2b review (Journal 32289)](https://navigator.novatori.us/r/journal/32289),
and ships as slice 2c.

### The bearer token rule

`usableBearerToken(value)` in `src/auth/bearer-token.ts` is the one rule for a
token the SDK sends: a non-empty string with no control character (C0,
U+0000 to U+001F, DEL, U+007F, or C1, U+0080 to U+009F) and no character
above U+00FF. It answers the token, or `null`. It is internal and not
exported.

Fetch refuses a header value with a character above U+00FF before it sends,
so the rule refuses such a token first, and the SDK never resends that
refusal as a lost connection. A host client that writes headers as Latin-1
keeps only the low byte, which would send U+010A as a line feed. A character
outside the Basic Multilingual Plane is two UTF-16 code units, both above
U+00FF, so the rule refuses it too. Siren's tokens are ASCII, so the rule
also refuses the C1 controls, which fetch would send as single bytes and some
readers take as a line break (U+0085). U+00A0 to U+00FF pass.

The rule applies at each place a bearer token enters the SDK:

| Where | What a token that fails the rule gets |
|---|---|
| `HttpTransport.request`, the `getAccessToken` answer | `SirenError` naming `getAccessToken` and the rule, never the value. Nothing sent |
| `HttpTransport.request`, the `refreshAccessToken` answer | The first 401 is raised, with a `cause` that is a `SirenError` naming `refreshAccessToken` and the rule, never the value. An answer of exactly `null` means the source cannot refresh, and the 401 carries no `cause` |
| `StaticAccessToken`'s constructor, and so `new Siren({ apiKey })` and a string `accessToken` | `SirenError` when the client is built, naming the rule, never the token |

The `cause` keeps the 401 a caller already handles, `SiteDisconnectedError`
included, and still shows that the host's refresh returned something the SDK
cannot send. `CallbackAccessTokenSource` hands every refresh answer other
than `null` to the transport unchanged, so a refresh function that forgets
to return raises the 401 with that `cause`. The PHP SDK reads an empty or
non-string answer as `null`, but PHP's return type catches a missing
return, and JavaScript has nothing that does.

The storefront module (`@novatorius/siren/storefront`) runs in the browser
and builds its own requests. It sends a visitor's tracking token, and
`verifyApplication` and `submitApplication` send an email confirmation token
and an applicant's details. Its functions read `baseUrl` and `fetch` from
their params through the prototype chain. It stays outside both rules here,
and a later slice owes it the own-property and token checks.

### Option checks

`new Siren()` checks three options when it is built. The PHP SDK checks only
that `maxRetries` is not negative, and its `timeout` is in seconds.

- `baseUrl` is a string that `new URL` parses, with the http or https
  scheme and no user name or password, because it decides where the token
  goes. Fetch refuses a URL with no scheme or with a user name, and the
  transport would read that refusal as a lost connection, resend it and
  raise a `ConnectionError` that quotes the URL. Every character is
  visible ASCII, U+0021 to U+007E, and none is a `?`, `#`, backslash or
  `@`. The transport joins each path onto the string as given, so a query
  or fragment would swallow every path. `new URL` drops a tab or line break
  anywhere and a space at either end, percent-encodes any other space or
  non-ASCII character in the path, and turns a non-ASCII host into
  punycode. The check would then pass a string other than the one a host
  client receives, and a client that writes Latin-1 sends U+010A as a line
  feed. `new URL` also reads a backslash as a slash, so it reads
  `http://localhost:1\:SECRET@127.0.0.1` as host localhost, port 1, with no
  user name. A lenient parser reads `localhost` as the user name and
  `1\:SECRET` as the password: Python's `urlsplit` does, and curl sends
  such a URL to 127.0.0.1. A base URL has no other use for an `@`.
- `baseUrl` starts with `http://` or `https://` and a host that holds no
  `%`. `new URL` repairs `https:host`, `http:/host` and `http:///host` into
  a host, while a client that follows RFC 3986 sees no host at all, and one
  such as axios joins the string onto a base URL of its own and sends the
  token there. `new URL` also decodes a `%` in the host, so
  `b%C3%BCcher.example` becomes a non-ASCII host and `evil%E3%80%82com`
  becomes `evil.com`. An international host goes in its punycode form, and
  a non-ASCII path character must be percent-encoded. Inside the range,
  `new URL` still percent-encodes a few path characters, such as `"`, `<`
  and `{`, so the path fetch sends can differ from the string, though the
  host stays the same.
- `timeout` is a number from 1 to 2147483647 milliseconds, fractions
  allowed, for each send. A Node timer above 2147483647 fires after 1 ms. A
  call can make up to `maxRetries + 2` sends, each with its own timeout,
  plus a backoff of at most 8 s between retries.
- `maxRetries` is a whole number of 0 or more, with a default of 2. It has
  no ceiling, as in PHP: the caller owns the bound.

`undefined` means absent and takes the default. `null`, strings, booleans,
NaN and Infinity are refused. The message names the option, its range and
what it got: the number, or the type of any other value. It never quotes a
string, which might be a credential passed in the wrong place. Unknown
option names are ignored.

### Own properties only

The constructor reads `apiKey`, `accessToken`, `httpClient`, `baseUrl`,
`timeout` and `maxRetries` only when the options object holds them itself,
and reads each once, so a getter cannot pass a check with one value and be
used with another. A value it inherits from any prototype,
`Object.prototype` included, counts as absent, so prototype pollution
elsewhere in a host cannot choose the host, the client, the credential or
the retry policy. That is a deliberate
choice: a caller that builds options as a class instance with getters on its
prototype spreads it into a plain object first. An options object with no
prototype works. The values are read as they are, so a token source or a
client class keeps its methods on its prototype. A method counts only when
the value or a prototype other than `Object.prototype` holds it, so a
polluted `Object.prototype.send` or `refreshAccessToken` cannot turn a plain
object into a client or a token source.

The rule covers what the SDK reads. Fetch reads its own options too, such as
undici's `dispatcher`, so a polluted `Object.prototype` can still change
where the default `FetchHttpClient` sends. A host that cannot rule out
pollution passes its own `httpClient`, and that client either sends without
the global `fetch` or sets its own dispatcher, because a fetch-based client
inherits the same reads.

### Tests

Three packets implement these rules. 2b P1 is the bearer token rule and every
place it applies, with its tests in `test/bearer-token.test.ts`. 2b P2 is the
option checks and the own-property reads in the `Siren` constructor, with its
tests in `test/siren-option-checks.test.ts`. 2c P1 is the baseUrl character
rule, described below. Some of their rows pin values each rule must accept, such as U+00FF in a token or
a timeout of 1 ms, so a check that refuses too much fails as surely as one
that refuses too little. `test/siren-option-resolvers.test.ts` adds unit
tests for the constructor's resolvers, driven through the public
constructor.

The tests run the real client, transport and resources, mocked only at the
`HttpClient` seam, and the real `FetchHttpClient` against a real HTTP server
on 127.0.0.1 where fetch itself refuses a header or the default client's
wiring matters. The change adds no surface that needs an end-to-end test
under KB 569. The slice 2 transport tests already pin the empty, non-string
and control-character cases on both token paths.

`scripts/mutations/ncc-slice-2b-p1.json` breaks the bearer token rule at each
place it applies and `scripts/mutations/ncc-slice-2b-p2.json` breaks each
constructor check. Each list carries the four controls the harness asks for.
To reproduce, run
`node scripts/mutation-proof.mjs scripts/mutations/ncc-slice-2b-p1.json` and
the same for the P2 list.

2c P1's tests are the `2c P1` describe of the option checks file. Each
refused row checks that the message names the range, the backslash, the `@`
and only the type, that the error has no `cause`, and that no message,
stack, field, getter or `inspect` output holds a word of the URL or a
character outside the range, raw or escaped. Its rows that accept a URL,
`localhost`, an IPv6 loopback, the two ends of the range and a
percent-encoded path among them, pin what the rule must let through, and one
of them pins that the client sends the string as given, not as `new URL`
would rewrite it.

The 2c mutation list (`scripts/mutations/ncc-slice-2c.json`) breaks each
part of the rule, refuses each edge the rule must accept, drops each part of
the message and the docs, and leaks the URL in each way the rows look for,
with the same controls. `node scripts/mutation-proof.mjs
scripts/mutations/ncc-slice-2c.json` reruns it. Until 2c P1 lands, the rows
that refuse a URL are skipped and the list's entries find the scratch build
it was proven on, not the code on this branch.
