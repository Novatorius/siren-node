# Architecture: apps-cli (slice 8 of Siren apps)

Siren apps let a service an organization hosts act as part of Siren's engine. This slice is how a
developer meets that service from Node: an `apps` resource on the client, a helper that checks a
signed request from Siren, a helper that answers one, a `siren` command shipped in this package, and
an example app. This note is the contract for the packets that build it. It follows
[Architecture Phase Contract (KB 643)](https://navigator.novatori.us/r/kb/643), and every pending
test was proven a contract the way
[Proving a Test Is a Contract (KB 730)](https://navigator.novatori.us/r/kb/730) asks.

The architecture commit added the public surface as stubs, the acceptance tests marked pending
with `describe.skip`, the example's skeleton, the parity rows and the mutation list. Each packet
turned on its tests by changing `describe.skip` to `describe`. All eleven packets are built, and no
test of this slice is pending.

Round 2 answers the audit of this contract (the run folder's audit/cli-audit.md). It changes the
answer call, the error codes, the target and app-file rules, the confirmation and key messages and
the example, and adds the founder's walk. Each audit item is taken or declined by number in "The
audit's items" below.

Siren commits read: feat/apps at 1619218d0 (`AppInUseException`, `AppSerializer`, `Login`,
`OrgRegistrationService`), main at 20c47873d (session routes, `AuthService`, `OrgRegistrationService`),
e5061f7de and 7a843fed3 (apps-records: the app routes and their answers), 086615e2a (apps-exchange:
the envelope, the headers, the answer route, the request list and resend, and the two fixtures this
slice copies), and 55b9ea76a with the apps-sandbox branch at ec1b3a190 (`sk_test_` keys and the
`edition` field of `GET /auth/signup-options`).

## The calls

| Call | Route | Credential | File |
| --- | --- | --- | --- |
| `siren.apps.declare(key, params)` | `PUT /apps/{key}` | admin session | src/resources/apps.ts |
| `siren.apps.list()` | `GET /apps` | admin session | src/resources/apps.ts |
| `siren.apps.retrieve(key)` | `GET /apps/{key}` | admin session | src/resources/apps.ts |
| `siren.apps.setStatus(key, status)` | `POST /apps/{key}/status` | admin session | src/resources/apps.ts |
| `siren.apps.rotate(key)` | `POST /apps/{key}/rotate` | admin session | src/resources/apps.ts |
| `siren.apps.delete(key)` | `DELETE /apps/{key}` | admin session | src/resources/apps.ts |
| `siren.apps.verifyRequest(rawBody, headers, secret, options)` | none, it reads what Siren sent | the app's signing secret | src/resources/apps.ts |
| `siren.apps.requests.list(params)` | `GET /apps/requests` | admin session | src/resources/apps.ts |
| `siren.apps.requests.resend(id)` | `POST /apps/requests/{id}/resend` | admin session | src/resources/apps.ts |
| `siren.apps.requests.answer(id, answer)` | `POST /apps/requests/{id}/answer` | the app's key, or an admin session | src/resources/apps.ts |

Every app route but the answer route refuses an API key with 401 `api_key_not_accepted`. The types
live in src/record-types.ts. The vocabularies `AppItemKind`, `AppStatus`, `AppRequestStatus` and
`AppRequestMode` live in src/taxonomy.ts. `AppErrorCode` lives in src/errors.ts beside `ErrorCode`,
which must equal Siren's shared `ApiErrorCode` list exactly (test/wire-taxonomy.test.ts), so the app
codes cannot join it. `SANDBOX_BASE_URL` lives in src/http.ts beside `DEFAULT_BASE_URL`.

### The rules each call follows

They are this repository's rules (briefs/sdk-conventions.md), applied as follows.

- Reads (`list`, `retrieve`, `requests.list`) go through `readList` or `readObject`, so they retry on
  a network error, 429 or 5xx. Writes go through `writeRecord` or `deleteRecord` and are sent once.
- `requests.answer()` is sent once, like every write (AP-A630). After a lost answer, a dropped
  connection or a 5xx, the caller sends the same answer again. Siren takes each answer once, so
  `duplicate: true` then means the first one had already landed and nothing more was applied. A
  different answer after a lost one gets 409 `app_request_already_answered` when the first landed.
- Each method checks what it can before sending and refuses with `SirenError`. An app key is
  lowercase letters and digits joined by single dashes, at most 64 characters, and never `requests`,
  which Siren reserves for `/apps/requests`. A request id is `apr_` and 32 lowercase hex characters.
  An answer is a plain object with a text `outcome`, at most 16384 bytes as JSON.
- `declare()` sends a new object of `DECLARE_FIELDS` and a new object of `ITEM_FIELDS` per item,
  through `pickFields`, so an unknown field is refused whatever its value and an inherited `toJSON`
  never reaches the body. Siren checks the rest and answers 400 or 422 with the field.
- `declare()` answers `created: true` with `rawKey` and `signingSecret` when Siren sent both, and
  `created: false` when it sent neither. One without the other is `UnexpectedResponseError`. It
  reads presence, not the status, because `writeRecord` answers only the body and Siren sends the
  secrets on its 201 alone.
- A 2xx body of the wrong shape is `UnexpectedResponseError` with the status and the body.
- An `sk_test_` key with no `baseUrl` goes to `SANDBOX_BASE_URL`. An `sk_test_` key sent to the
  live API's origin, or an `sk_live_` key sent to the sandbox's origin, is refused when the client
  is built, without quoting the key. Any other origin takes either kind, so a local or UAT Cloud
  works. This sits in `baseUrlForKey()` in src/client.ts. `TEST_API_KEY` is an `sk_live_` key and
  no existing test builds a client with `sk_test_`, so nothing that passes today changes.

### Errors and what the caller does

| Siren answers | The SDK raises | The caller |
| --- | --- | --- |
| 401 `api_key_not_accepted` on an app route | `ApiKeyNotAcceptedError` | Signs in and sends an admin's session token. |
| 403 with `data.reason` `app_limit_reached` | `PermissionError` | Turns another app off, or moves to a plan with room. |
| 403 with `data.reason` `org_access_required` | `PermissionError` | Asks a member who sees every store. |
| 409 with `data.reason` `app_change_in_progress` | `ConflictError` | Sends again in a moment. |
| 409 with `data.reason` `app_in_use` and `data.uses` | `ConflictError` | Turns the app off instead, or moves the records in `uses` first. |
| 409 `app_request_not_resendable` | `ConflictError` | Reads the request. It is answered or applied, or its app is off. |
| 409 `app_request_already_answered` | `ConflictError` | Stops. A different answer came first, and it stands. |
| 404 `app_request_not_found` | `NotFoundError` | Checks the id and the key's app. |
| 403 `app_inactive` or `app_answer_forbidden` | `PermissionError` | Turns the app on, or answers as an admin. |
| 422 `app_answer_invalid` | `ValidationError` | Fixes the answer for the item's kind. |
| 401 `app_answer_unauthorized` | `AuthenticationError` | Uses the app's own key, not an org key. |
| a bad signature, an old timestamp, or no V2 header | `SignatureVerificationError` from `verifyRequest` | Answers 400 and does nothing else. |

`appErrorCode(error)` in src/errors.ts reads the code in one place: the error's `code` (Siren's
`error.code`) first, then `data.reason` (Siren's `error.context.reason`), else `undefined`
(AP-A631). Every caller, the `siren` command included, reads app codes through it. Slice 1's
`AppInUseException` already sends both on feat/apps at 1619218d0. Slice 1 gains coded exceptions
for `org_access_required` and `app_change_in_progress`, and slice 2's answer route moves to
`{"error":{"message","code","context"}}` (Claims on others). The table's `data.reason` rows then
also carry `error.code`, and neither shape breaks a caller.

## Checking a request

`verifyRequest(rawBody, headers, secret, { toleranceSeconds = 300, now })` is synchronous, like
`webhooks.constructEvent`, and reads headers the same way (any case, a `Headers` object, or an array
value's first item).

1. It refuses an empty secret, and a tolerance that is not a whole number from 1 to 3600, with
   `SirenError` before any check.
2. It refuses an `X-Siren-Event` other than `app.request` and names `webhooks.constructEvent()`.
3. It reads `X-Siren-Signature-V2: t=<seconds>,v1=<hex>`. A missing or unreadable header is refused.
   It never falls back to the older `X-Siren-Signature`, which signs no time, so a captured request
   could be replayed forever.
4. It refuses an `X-Siren-Timestamp` that differs from the signed `t`.
5. It checks each `v1` against HMAC-SHA256 of `"<t>.<body>"` with `timingSafeEqual`, and passes when
   one matches.
6. It refuses a `t` more than the tolerance from `now`, either way. Exactly 300 seconds passes.
7. It refuses a body that is not an envelope of version 1: `id` `apr_` and 32 hex, `type`
   `app.request`, `mode` `tell` or `ask`, `app`, `item` with `kind`, `key` and `id`, `createdAt`, an
   object `data`, and for an ask `answerBy` and `answerUrl`.
8. It answers the envelope with `timestamp` (the signed `t`) and `deliveryId` (`X-Siren-Delivery`,
   when present).

It ignores `Idempotency-Key`, which Siren does not sign. A receiver drops a repeat by the returned
`id`, which the signature covers.

`webhooks.constructEvent()` stays as it is (ruling S6, AP-A642). Checking the timestamped signature
there would break every webhook receiver that replays deliveries today, and it is not part of this
work. `apps.verifyRequest()` requires the timestamped signature and never falls back.

## The commands

The bin is `siren`, `./dist/cli.js`, built by tsup from src/cli/index.ts. tsup keeps the file's
`#!/usr/bin/env node` line. It needs no new dependency: options are read with `node:util`
`parseArgs`, strict.

| Command | Sends | Prints |
| --- | --- | --- |
| `siren signup [--org-name] [--email] [--password-stdin] [--accept-terms]` | `GET /auth/signup-options`, then `POST /auth/register-org` once | The organization and the address signed in to. See "Confirmation and plan answers" for the other outcomes. |
| `siren login [--email] [--org <slug or id>] [--password-stdin]` | signup-options, `POST /auth/login`, and `POST /auth/select-org` for a person in several organizations | The organization signed in to, and the days left to confirm the address when Siren says so. |
| `siren logout` | `POST /auth/logout` with the access token and the refresh token | That the session is forgotten. It forgets it even when Siren refuses, and it needs no `--live` (AP-A640). |
| `siren orgs` | `GET /auth/memberships` | One line per organization, `*` on the current one. |
| `siren use <slug or id>` | memberships, then `POST /auth/switch-org` | The organization now in use. |
| `siren apps init [--key] [--name]` | nothing | Writes siren.app.json, adds `.env.*` to .gitignore, and never overwrites a file. |
| `siren apps apply [file]` | `PUT /apps/{key}` once | The app and each item with its `app:{id}`, never the url, and the name of each variable it filled. On the first apply, the key's 16-character prefix and the absolute path of the env file it wrote. On a later apply with no `SIREN_API_KEY` in that file, a line that names `siren apps rotate <key>` (AP-A635). |
| `siren apps list [--json]` | `GET /apps` | One block per app with its items, or the JSON Siren sent. |
| `siren apps show <key> [--json]` | `GET /apps/{key}` | The app and its items. |
| `siren apps requests [--app <key>] [--attention] [--follow]` | `GET /apps/requests`, and `GET /apps/{key}` once for `--app` | One line per request, oldest first. `--follow` asks again every 2 seconds, prints each new request or status change once, and ends with 0 on Ctrl-C. |
| `siren apps requests <id>` | `GET /apps/requests`, `GET /apps`, `GET /webhooks/{subscription}/deliveries`, in that order | The request, each send with its HTTP status and the app's answer, and the body Siren sent. |
| `siren apps answer <id> (--body <json> or --file <path>)` | `POST /apps/requests/{id}/answer` with the session | Accepted, or that Siren already had this answer. |
| `siren apps resend <id>` | `POST /apps/requests/{id}/resend` | The request as it now stands. |
| `siren apps rotate <key> [--app-file <path>]` | `POST /apps/{key}/rotate` | The new prefix and the absolute path of the env file. Writes the new key and secret where `apply` wrote the first pair, or beside the named app file (AP-A634). |
| `siren apps on <key>` and `siren apps off <key>` | `POST /apps/{key}/status` | The app's new state. |
| `siren apps delete <key> --yes` | `DELETE /apps/{key}` | That it is gone. On 409 `app_in_use`: the records in `uses` with the `siren apps off` command, and when `openRequests` is above 0, `siren apps requests --app <key>` and the advice to answer or wait for the open asks (AP-A641). |

Every command takes `--sandbox`, `--live`, `--base-url <url>` and `--help`. Exit codes: 0 for done,
1 when Siren or the tool refused, 2 for a command line the tool cannot read, with nothing sent.
Results go to standard output and every refusal is one message on standard error.

### Confirmation and plan answers

Each answer gets one line that says what to do next, and the tool never prints Siren's
`confirmationToken` (AP-A637 to AP-A639).

| Siren answers | The tool says |
| --- | --- |
| register-org 201 with `emailConfirmationRequired: true` and no tokens (OrgRegistrationService.php 189 to 193) | It made the organization, sent a confirmation email to the address, and to open it from the inbox, confirm, then run `siren login`. It stores no session and answers 0. |
| a session with `emailConfirmation: { pending, deadline, daysUntilClosed }` from register-org or login (AuthService.php 572 and 1850) | It signed in, and to confirm the address from the email Siren sent, with the days left before Siren closes the account. |
| login 403 `email_unconfirmed` with a `confirmationToken` (Login.php 171 to 178) | To confirm the address first from the inbox, then run `siren login` again. Exit 1. |
| login 401 `no_entitlement`, `entitlement_lapsed` or `trial_ended` (Login.php 159 to 164) | That the organization has no plan, its plan lapsed, or its trial ended, and to choose or renew a plan in the dashboard. Exit 1. |
| login 401 `entitlements_unavailable` | That Siren could not check the plan, and to try again in a minute. Exit 1. |
| register-org 404, as when `SIREN_SAAS_SIGNUP_ENABLED` is off (saas/public/index.php 180) | `Sign-up is turned off on <address>. Ask its owner, or use siren login.` Exit 1. |

A command that confirms the address with Siren's code waits for a later slice. Until then the
person confirms from the email, which works on every edition. The sandbox edition never asks,
because its null identity provisioner treats every address as confirmed (AP-A200).

`runCli(argv, io)` in src/cli/run.ts takes a `CliIo` (src/cli/io.ts): the two output streams, the
prompts, standard input, the environment, the working and config folders, the `HttpClient`, the
clock, `sleep` and an abort signal. The bin builds it with `nodeIo()`. Tests build their own
(test/cli-fakes.ts), so no test reaches the network or the home folder. `run.ts` holds only the
option tables and the dispatch. Each group of commands goes in its own file under src/cli/commands
(session.ts, apply.ts, requests.ts), so the packets that build them do not edit the same lines.

## Signing in and the stored files

`SessionAuthClient` (src/cli/session-auth.ts) calls Siren's session routes through the `HttpClient`,
as `OAuthClient` calls the OAuth routes: one JSON request each, the SDK's headers, the reads retried
twice, every other call sent once, and no error that carries a password or a token. It is internal
to the command and the package does not export it. It reuses nothing of src/connect: the OAuth
client mints a connector token for a connected site, and the app routes need an admin's dashboard
session (AP-A606).

The password comes from a hidden prompt or from standard input with `--password-stdin`, never a
flag, and is sent once. `PasswordSignIn` is the one `SignInMethod`. Device sign-in (slice 9) adds a
second method that ends with the same `LoginResult`, so nothing after sign-in changes. That
interface is the seam slice 9 builds on.

`credentials.json` sits in `SIREN_CONFIG_DIR`, else `%APPDATA%\siren` on Windows, else
`$XDG_CONFIG_HOME/siren`, else `~/.config/siren`. The folder is mode 0700 and the file 0600, written
through a temporary file and a rename. A file anyone else can read is refused before a token in it
is used, with a message naming the file and `chmod 600`. It holds one session per Siren address:

```json
{ "version": 1, "sessions": { "https://sandbox.sirenaffiliates.com/siren/v1": {
  "edition": "sandbox", "email": "dev@acme.example", "userId": 7, "orgId": 3, "orgName": "Acme",
  "role": "admin", "accessToken": "<JWT>", "refreshToken": "<JWT>", "accessExpiresAt": 1794916800,
  "envFiles": { "acme-payouts": "/home/dev/acme/.env.sandbox" } } } }
```

It never holds the password, the five-minute verification token, an app's key or its secret.
`envFiles` holds, by app key, the absolute path of the env file `apply` chose, and nothing else. The
access token lasts an hour. The command reads its `exp`, refreshes 60 seconds before it, and
refreshes once after a 401, through `CallbackAccessTokenSource`. Each refresh answers a new pair,
which is saved at once because the old refresh token is spent. A refused refresh says to run
`siren login` again.

An app's key and secret go to `.env.sandbox`, or `.env.live` for a live session, beside the app
file. `apply` records that path in `envFiles` on every apply. `rotate` writes the new pair to the
recorded path, or beside the app file named with `--app-file`, and never to the working folder.
With neither, it refuses before sending, since the new pair would have nowhere known to go and
Siren shows it once. When the file already names another `SIREN_BASE_URL`, `rotate` says on
standard error which Siren's key it replaced (AP-A636). The file is mode 0600. Only the three lines
`SIREN_BASE_URL`, `SIREN_API_KEY` and `SIREN_SIGNING_SECRET` are replaced, and every other line is
kept. The command prints the key's 16-character prefix and the file name, never the key or the
secret. When the file cannot be written, it prints both once on standard error and answers 1, since
Siren will not show them again.

## Sandbox and live

- With no flag the command talks to `SIREN_BASE_URL`, else `SANDBOX_BASE_URL`. It reaches
  `https://api.sirenaffiliates.com` only with `--live`.
- `--sandbox` with `--live` or with `--base-url` is a usage error.
- `--base-url` and `SIREN_BASE_URL` take `http://` only for `localhost`, `127.0.0.1` and
  `host.docker.internal`. Any other address must be https, or the command is a usage error, exit 2,
  with nothing sent, since every command sends a password or a session token (AP-A632).
- `signup` and `login` read the edition from `GET /auth/signup-options` before they ask for the
  password. A Siren that names no edition counts as live.
- A live edition needs `--live` on every command but `logout`, whatever address chose it. Signing
  out sends only the session's own tokens, to revoke them. `--live` against a
  sandbox is refused. A stored session keeps its edition, so the check runs before anything is sent.

## The app file

`siren.app.json` is a Siren recipe that holds one `apps` stanza, so it can become a recipe stanza
later without a rewrite (design AP-A215):

```json
{
  "version": 1,
  "name": "Acme payouts",
  "description": "Pays collaborators through Acme's ledger.",
  "apps": {
    "acme-payouts": {
      "name": "Acme",
      "url": "${SIREN_APP_URL}",
      "scopes": ["event:site-visited", "event:sale"],
      "events": [],
      "items": {
        "notify-crm": { "kind": "postConversionAction", "name": "Tell the CRM" },
        "acme-ledger": { "kind": "fulfillmentMethod", "name": "Acme ledger", "currencies": ["USD"], "answerWindowMinutes": 1 },
        "acme-split": { "kind": "distributionResolver", "name": "Acme split", "answerWindowMinutes": 1 }
      }
    }
  }
}
```

`parseAppFile(text, env)` answers the file or every problem, each with its dotted path, line and
column. `apply` prints them as `siren.app.json:9:7: apps.acme-payouts.url: ...` and sends nothing.

- `version` is 1. `name` and `description` are both required and are text.
- Any other recipe stanza, such as `programs`, is refused by name. Recipes made of apps and
  programs wait for slice 12. Any other key is refused as not a recipe key.
- `apps` holds exactly one app, keyed by its app key.
- An app takes `name`, `description`, `url`, `scopes`, `events` and `items`, and nothing else.
  `url` starts with `https://`, or with `http://` for `localhost`, `127.0.0.1` or
  `host.docker.internal`, which only a local Cloud reaches (AP-A616).
- `items` is an object keyed by item key, so a key is unique within the app. An item takes `kind`,
  `name`, `description`, `currencies` and `answerWindowMinutes`. `currencies` is required for a
  `fulfillmentMethod` and refused for any other kind. `answerWindowMinutes` runs from 1 to 43200.
- `${NAME}` is filled from the environment only in the app's `url`, and only from a variable whose
  name starts with `SIREN_APP_` (AP-A633). A placeholder anywhere else, any other name, or a name
  that is not set is a problem at that key, naming the place and never a value. `parseAppFile`
  answers the names it filled in `filled`, and `apply` prints those names, never the values, and
  never writes them back to the file.
- A key written twice is a problem at the second one. A JSON mistake gives the line and column of
  the character the reader stopped at, or of the string that holds a raw line break. The reader is
  a small one in app-file.ts that tracks positions, since `JSON.parse` gives neither. It has its own
  tests: it reads what `JSON.parse` reads, and refuses a trailing comma, single quotes, a comment,
  `NaN`, text after the object and a raw line break, each at its place.

`declarationFor(file)` turns the one app into what `PUT /apps/{key}` takes: the same fields, and
`items` as a list in the file's order, each with its `key`.

## The example app

examples/apps/acme holds `handler.mjs`, `server.mjs`, `siren.app.json`, a package.json that depends
on this package by `file:`, and a README. `createAcmeApp({ siren, signingSecret, now, log })`
answers each request:

- A request that fails `verifyRequest` gets 400 and nothing else happens.
- Every request that passes gets 200. A repeat, found by `id`, gets 200 and is not acted on again.
- An ask is answered after the 200 with `requests.answer()`. A fulfillment method's payout is
  answered `{ outcome: 'paid', reference: 'acme-<payoutId>' }`. A distribution resolver's pool is
  answered `{ outcome: 'resolved', shares: [{ id, amount }] }`, divided by each metric's value in
  whole minor units, the remainder going to the largest fractions. An ask counts as handled only
  once its answer is accepted.

The example runs in place in a checkout of this repository, after `npm ci && npm run build`, since
its package.json takes this package by `file:` (AP-A646).

- `env.mjs` holds `loadAppEnv(folder, env)`. It reads `SIREN_ENV_FILE` when set. Otherwise the folder
  must hold exactly one of `.env.sandbox` and `.env.live`: none says to run `siren apps apply`, and
  both says to set `SIREN_ENV_FILE`, so the example never guesses between the sandbox and live. The
  file must hold `SIREN_BASE_URL`, `SIREN_API_KEY` and `SIREN_SIGNING_SECRET` (AP-A645).
- `server.mjs` starts after `apply`, reads the env file through `loadAppEnv`, builds its `Siren`
  from that file's address and key, and listens on `PORT`, 8787 by default.
- `sale.mjs` holds `sendSale(siren, { collaborator, total, currency, externalId })`. It records a
  visit for the collaborator, `events.siteVisited`, which answers the opportunity id, then a sale on
  that opportunity, `events.sale` with `source` `acme-example` and no `test` flag, as a store sends
  one. `send-sale.mjs` runs it with the app's own key from the env file:
  `npm run send-sale -- tracking:<code> [total]` (AP-A643).
- The app declares the scopes `event:site-visited` and `event:sale`. Ingestion on
  `/event/{slug}` needs `event:{slug}` (saas/Auth/ApiKeyScopeMiddleware.php, and
  `ApiKey::hasEventScope()`, which also wants the exact scope for a slug a connected site
  forwards), and `ApiKeyScopePolicy::isIssuable()` lets an app hold `event:` scopes. Both are in
  test/fixtures/api-key-scopes.json, which a test checks.
- Both ask items, `acme-ledger` and `acme-split`, declare `answerWindowMinutes: 1`, the shortest
  Siren allows (`AppService`, 1 to 43200). By the exchange contract's deadline rule an ask nobody
  answers is sent three times, each with a fresh one-minute window, and moves to `needs_attention`
  when the third window ends: about three minutes after the first send, plus however late the
  deadline wake runs (AP-A644).

The example imports nothing from the package but types, so its test drives it with a `Siren` built
from src.

## The package

`package.json` gains `"bin": { "siren": "./dist/cli.js" }`. tsup gains the `cli` entry. The build
also writes dist/cli.cjs and its type files, which nothing names. The version stays 0.3.0 and
`CLI_VERSION` must equal it, which a test checks.

## Tests and proof

109 tests are pending in seven files, 17 more than round 1. Each describe's name starts with
`apps-cli`.

| File | Tests | Round 2 | Packet |
| --- | --- | --- | --- |
| test/apps-verify-request.test.ts | 12 | | sdk-verify |
| test/apps-resource.test.ts, `apps.declare` and `apps reads and changes` | 12 | 1 new (the code reader) | sdk-apps |
| test/apps-resource.test.ts, `apps.requests` | 3 | | sdk-requests |
| test/apps-resource.test.ts, `apps.requests.answer` | 4 | 1 changed (sent once) | sdk-answer |
| test/apps-resource.test.ts, `sandbox and live keys` | 3 | | sdk-sandbox-guard |
| test/cli-app-file.test.ts, `the app file` | 10 | 1 new (filling), 2 changed (filled names, description) | cli-app-file |
| test/cli-app-file.test.ts, `the app file's JSON reader` | 8 | 8 new | cli-app-file |
| test/cli-commands.test.ts, `signup, login and the session` | 18 | 2 new (confirmation and plan answers, local http), 2 changed (http refused, logout) | cli-session |
| test/cli-build.test.ts | 4 | | cli-session |
| test/cli-commands.test.ts, `apps init, apply and the app key` | 9 | 1 new (rotate's refusal and other-Siren line), 4 changed (first apply, later apply, rotate, delete) | cli-apply |
| test/cli-commands.test.ts, `apps requests, answer and resend` | 6 | | cli-requests |
| test/apps-example.test.ts | 8 | 3 new (env file, sale, scopes and windows) | example-app |
| test/docs-apps-cli.test.ts | 12 | 1 new (thirteen), 2 changed (drop by `id`, Changed) | docs |

The Siren answers the tests fake sit in test/apps-siren-answers.ts, each citing its Siren file and
line (AP-A647). test/cli-fakes.ts keeps the session answers it had.

test/fixtures/apps-exchange holds Siren's signed-request.json and answer.json from 086615e2a, byte
for byte. The parity rows are in the README's Node-only table now, and test/docs-parity.test.ts
passes with them.

The proof ran in a separate clone (/media/alex/DATA/siren-wt/apps-node-cli-proof), never committed
from or pushed. It holds a scratch implementation of every stub, the tests turned on, and the docs.
There, `npm test` gives 101 files, 2616 passed and 1 skipped, and `npm run typecheck` is clean. On
the stubbed tree all 109 are pending and the suite gives 2507 passed and 110 skipped.

The mutation list is scripts/mutations/apps-cli.json. Its `find` texts are the scratch
implementation's. A packet that builds a guard rewrites that guard's `find` for its own code and
runs the list, as the harness's usage line says:

```
unshare -rn sh -c 'ip link set lo up && node scripts/mutation-proof.mjs scripts/mutations/apps-cli.json'
```

The list holds the four controls and 130 guards, one mutation per guard. Round 1 scored 97 of 97.
Round 2 rewrote five `find` texts and one failing name for the changed code, turned `answer-not-retried` into
`answer-retried` for the answer sent once, and added 37 mutations for the new guards and the two
fixed tests (`apply-later-sends-more` for S4(a), `docs-drop-by-key` for S4(b)). Its run on the proof
clone, the scored line of each mutation (the full output also names the failing tests under each):

```
OK   control-break: caught (expected caught)
OK   control-harmless: survives (expected survives)
OK   control-malformed: refused (expected refused)
OK   control-wrong-reason: wrong-reason (expected wrong-reason)
OK   verify-legacy-fallback: caught (expected caught)
OK   verify-tolerance-dropped: caught (expected caught)
OK   verify-tolerance-boundary: caught (expected caught)
OK   verify-tolerance-one-sided: caught (expected caught)
OK   verify-tolerance-option-ignored: caught (expected caught)
OK   verify-time-not-signed: caught (expected caught)
OK   verify-timestamp-header-ignored: caught (expected caught)
OK   verify-event-ignored: caught (expected caught)
OK   verify-empty-secret: caught (expected caught)
OK   verify-tolerance-range: caught (expected caught)
OK   verify-version-unchecked: caught (expected caught)
OK   verify-ask-fields-unchecked: caught (expected caught)
OK   verify-first-v1-only: caught (expected caught)
OK   verify-delivery-dropped: caught (expected caught)
OK   declare-requests-key: caught (expected caught)
OK   declare-item-fields-unpicked: caught (expected caught)
OK   declare-name-url-optional: caught (expected caught)
OK   declare-one-secret-accepted: caught (expected caught)
OK   declare-shape-unchecked: caught (expected caught)
OK   declare-toJSON-reaches-body: caught (expected caught)
OK   status-unchecked: caught (expected caught)
OK   rotate-secrets-unchecked: caught (expected caught)
OK   requests-rows-unchecked: caught (expected caught)
OK   requests-status-unchecked: caught (expected caught)
OK   request-id-loose: caught (expected caught)
OK   answer-retried: caught (expected caught)
OK   answer-size-boundary: caught (expected caught)
OK   answer-outcome-unchecked: caught (expected caught)
OK   answer-class-instance: caught (expected caught)
OK   answer-receipt-unchecked: caught (expected caught)
OK   sandbox-default-dropped: caught (expected caught)
OK   sandbox-key-to-live: caught (expected caught)
OK   live-key-to-sandbox: caught (expected caught)
OK   file-stanza-allowed: caught (expected caught)
OK   file-two-apps: caught (expected caught)
OK   file-env-unset-silent: caught (expected caught)
OK   file-duplicate-key: caught (expected caught)
OK   file-currencies-anywhere: caught (expected caught)
OK   file-window-upper: caught (expected caught)
OK   file-http-allowed: caught (expected caught)
OK   file-http-local-loose: caught (expected caught)
OK   file-kind-unchecked: caught (expected caught)
OK   file-column-off: caught (expected caught)
OK   edition-live-unguarded: caught (expected caught)
OK   edition-sandbox-live: caught (expected caught)
OK   edition-missing-is-sandbox: caught (expected caught)
OK   login-edition-unchecked: caught (expected caught)
OK   default-target-live: caught (expected caught)
OK   sandbox-with-live-allowed: caught (expected caught)
OK   credentials-mode-unchecked: caught (expected caught)
OK   credentials-file-0644: caught (expected caught)
OK   credentials-dir-open: caught (expected caught)
OK   refresh-not-before-expiry: caught (expected caught)
OK   refresh-refusal-raw: caught (expected caught)
OK   refresh-not-kept: caught (expected caught)
OK   no-session-message: caught (expected caught)
OK   login-org-by-id-only: caught (expected caught)
OK   login-first-org-silently: caught (expected caught)
OK   logout-keeps-refresh: caught (expected caught)
OK   logout-forgets-all: caught (expected caught)
OK   use-org-id-text: caught (expected caught)
OK   orgs-no-marker: caught (expected caught)
OK   signup-terms-unchecked: caught (expected caught)
OK   usage-exit-1: caught (expected caught)
OK   parse-not-strict: caught (expected caught)
OK   positionals-unchecked: caught (expected caught)
OK   help-misses-one: caught (expected caught)
OK   version-drifts: caught (expected caught)
OK   bin-points-elsewhere: caught (expected caught)
OK   apply-prints-key: caught (expected caught)
OK   env-fallback-silent: caught (expected caught)
OK   env-file-open-mode: caught (expected caught)
OK   env-lines-appended: caught (expected caught)
OK   env-written-on-update: caught (expected caught)
OK   problems-without-line: caught (expected caught)
OK   init-no-gitignore: caught (expected caught)
OK   init-overwrites: caught (expected caught)
OK   delete-without-yes: caught (expected caught)
OK   delete-in-use-plain: caught (expected caught)
OK   requests-app-unfiltered: caught (expected caught)
OK   requests-attention-ignored: caught (expected caught)
OK   follow-repeats: caught (expected caught)
OK   follow-ignores-ctrl-c: caught (expected caught)
OK   show-other-requests: caught (expected caught)
OK   answer-duplicate-hidden: caught (expected caught)
OK   example-no-dedupe: caught (expected caught)
OK   example-failed-counts: caught (expected caught)
OK   example-accepts-unverified: caught (expected caught)
OK   example-reference: caught (expected caught)
OK   example-remainder-lost: caught (expected caught)
OK   docs-answer-key: caught (expected caught)
OK   docs-cli-heading: caught (expected caught)
OK   docs-changelog-sandbox: caught (expected caught)
OK   error-code-not-first: caught (expected caught)
OK   error-code-no-reason: caught (expected caught)
OK   target-http-any-host: caught (expected caught)
OK   target-http-local-narrow: caught (expected caught)
OK   file-fill-anywhere: caught (expected caught)
OK   file-fill-any-name: caught (expected caught)
OK   file-filled-unreported: caught (expected caught)
OK   file-description-optional: caught (expected caught)
OK   reader-raw-line-break: caught (expected caught)
OK   signup-off-raw: caught (expected caught)
OK   signup-unconfirmed-vague: caught (expected caught)
OK   signup-window-silent: caught (expected caught)
OK   login-window-silent: caught (expected caught)
OK   login-unconfirmed-raw: caught (expected caught)
OK   login-plan-raw: caught (expected caught)
OK   logout-needs-live: caught (expected caught)
OK   apply-prints-url: caught (expected caught)
OK   apply-no-key-silent: caught (expected caught)
OK   apply-no-key-wrong-line: caught (expected caught)
OK   apply-later-sends-more: caught (expected caught)
OK   apply-not-remembered: caught (expected caught)
OK   rotate-to-cwd: caught (expected caught)
OK   rotate-unknown-guesses: caught (expected caught)
OK   rotate-other-siren-silent: caught (expected caught)
OK   rotate-app-file-unremembered: caught (expected caught)
OK   saved-path-relative: caught (expected caught)
OK   delete-open-asks-off: caught (expected caught)
OK   example-env-guesses: caught (expected caught)
OK   example-env-unchecked: caught (expected caught)
OK   example-sale-is-test: caught (expected caught)
OK   example-sale-no-opportunity: caught (expected caught)
OK   example-scope-missing: caught (expected caught)
OK   example-window-long: caught (expected caught)
OK   example-split-window-default: caught (expected caught)
OK   docs-drop-by-key: caught (expected caught)
OK   docs-count-three: caught (expected caught)
OK   docs-changelog-constructor: caught (expected caught)

134 of 134 mutations scored as expected.
```

## The founder's walk

This is design section 10's walk, rewritten so every step runs as written (ruling M1). It runs
against the sandbox edition of Siren Cloud, where the plan puts a developer's testing (AP-A13) and
where the tool goes by default (AP-A648). The address is the founder's UAT preview when it is a
sandbox, given once as `export SIREN_BASE_URL=https://<preview>/siren/v1`, or the public sandbox
when nothing is set. If the preview turns out to be a production edition, `siren signup` says it is
live, and the same steps run with `--live` added to every `siren` command, writing `.env.live` in
place of `.env.sandbox`.

It needs Node 18 or later, a checkout of the siren-node pull request's branch, and `cloudflared`.
Steps 7, 9, 10 and 12 also need Siren slices 1 to 4 on the preview, and step 11 slice 5.

| # | The person runs | The person sees | Made true by |
| --- | --- | --- | --- |
| 1 | `npm i -g ./novatorius-siren-<sha>.tgz`, the tarball attached to the siren-node pull request, then `siren --version` | `0.3.0` | cli-session (bin and build tests) |
| 2 | `siren signup`, answering the prompts: organization name, email, the terms, and the password at a hidden prompt | `Made <org> (<slug>) on <address>, and signed in as <email>.` On a live edition: `<address> is a live Siren. Add --live to act on a live organization.` With sign-up off: `Sign-up is turned off on <address>. Ask its owner, or use siren login.` | cli-session |
| 3 | In the checkout: `npm ci && npm run build`, then `cd examples/apps/acme && npm install` | npm's usual output | example-app |
| 4 | In a second terminal: `cloudflared tunnel --url http://localhost:8787`. Back in the first: `export SIREN_APP_URL=<the https address it printed>` | A `https://<words>.trycloudflare.com` address | none, cloudflared |
| 5 | `siren apps apply` | `Declared acme-payouts on <address>.`, the app line, one line per item with its `app:{id}`, `Its url came from SIREN_APP_URL.`, and `Key sk_test_<8 hex> and its signing secret are in <folder>/.env.sandbox.` No key, secret or url is printed. | cli-app-file, cli-apply, sdk-apps |
| 6 | `npm start` | `Acme example app on http://localhost:8787, for <address> (<folder>/.env.sandbox).` | example-app |
| 7 | In the dashboard, signed in with the same email and password: make a program with a sale reward, pick "Acme: Tell the CRM" among its post-conversion actions and "Acme: Acme split" as its distributor's resolver, and add a collaborator with a tracking code. Open Webhooks. | The three Acme items in the pickers, and the app's subscription marked as managed by the app | Siren slices 1, 3 (claim C3) and 4, not this slice |
| 8 | `npm run send-sale -- tracking:<code> 49` | `Sent a sale of 49 USD through <folder>/.env.sandbox: created, opportunity <id>.` | example-app |
| 9 | Approve the conversion in the dashboard. Then `siren apps requests --follow`, and in another terminal `siren apps requests <id>` for the tell | The tell's line going from `sent` to `delivered`. The single request shows the send, `HTTP 200`, the app's answer and the body Siren sent. Ctrl-C ends `--follow` with exit 0. | cli-requests, Siren slices 2 and 3 |
| 10 | Close the program's distribution with slice 4's test route (claim C7) | `--follow` shows the ask `sent`, then `answered`, then `applied`. The server logs the answer, and the distribution completes with the app's shares. | example-app, sdk-verify, sdk-answer, Siren slice 4 |
| 11 | With slice 5 only: pick "Acme: Acme ledger" on an autofulfiller and run a payout through it | The payout waits, then shows as paid with reference `acme-<payoutId>` | example-app, Siren slice 5 |
| 12 | Stop the server with Ctrl-C, close another distribution as in step 10, and run `siren apps requests --attention --follow` | Nothing at first. About three minutes later, after three one-minute windows, the ask's line with `needs_attention` and its send error. The Apps screen marks it too. | cli-requests, the shortest window in the example's app file, Siren slices 2 and 3 |
| 13 | `npm start` again, then `siren apps resend <id>` | The request's line back at `sent`, then `--follow` shows `answered` and `applied` | cli-requests |
| 14 | Or, with the server still stopped, read the metric ids with `siren apps requests <id>` and run `siren apps answer <id> --body '{"outcome":"resolved","shares":[{"id":"<metric id>","amount":<minor units>}]}'` | `Siren accepted the answer.` Sending it again prints `Siren already had this answer. Nothing changed.` | cli-requests, sdk-answer |
| 15 | `siren logout` | `Signed out of <address>.` | cli-session |

Without a tunnel, step 4 sets `SIREN_APP_URL` to any https address, deliveries fail, and steps 9 to
12 end in `needs_attention`, which step 14 answers by hand (AP-A216).

## The end-to-end checkpoint

A later lane runs this against a local sandbox Cloud. Nothing here ran it.

1. Run `df -h /` and stop below 10 GB. In a Siren worktree of feat/apps with slices 1, 2 and 7
   merged, build the sandbox image:
   `docker build -f saas/Dockerfile --build-arg SIREN_EDITION=sandbox --build-arg COMPOSER_AUTH="$COMPOSER_AUTH" -t siren-sandbox:apps-e2e .`
2. Write an override beside uat/sandbox/docker-compose.yml that sets, on `app`,
   `SIREN_SAAS_SIGNUP_ENABLED: "true"`, `SIREN_OUTBOUND_DEV_ALLOW_HOSTS: host.docker.internal` and
   `extra_hosts: ["host.docker.internal:host-gateway"]`. Start it as its own project:
   `SIREN_SANDBOX_IMAGE=siren-sandbox:apps-e2e SIREN_SANDBOX_PORT=33918 docker compose -p apps-e2e-cloud -f uat/sandbox/docker-compose.yml -f <override> up -d`.
   Check `curl -s localhost:33918/siren/v1/auth/signup-options` names `"edition":"sandbox"`.
3. In this repository: `npm ci && npm run build && npm pack`, then install the tarball in an empty
   folder and check `npx siren --version` prints 0.3.0.
4. `export SIREN_BASE_URL=http://localhost:33918/siren/v1 SIREN_CONFIG_DIR=$(mktemp -d)`.
5. `printf '%s' "$PASSWORD" | npx siren signup --org-name "Apps E2E" --email apps-e2e+$(date +%s)@example.invalid --password-stdin --accept-terms`.
   Check credentials.json is mode 0600 and holds no password. Then, by hand in a real terminal, run
   `npx siren login` with no flags and check the password prompt echoes nothing, and that Ctrl-C
   at it ends the command and leaves the terminal echoing again.
6. In examples/apps/acme of this checkout: `SIREN_APP_URL=http://host.docker.internal:8787 npx siren apps apply`.
   Check .env.sandbox holds an `sk_test_` key, and that no key, secret or url was printed.
7. `npm install && npm start`, then `npm run send-sale -- tracking:<code> 49` for a collaborator
   made in the sandbox dashboard, and run the walk above from step 7.
8. `npx siren apps requests --follow` shows the ask go from `sent` to `answered` to `applied`.
   `npx siren apps requests <id>` shows the send, the 200 and the body.
9. `npx siren apps answer <id> --body '{"outcome":"paid","reference":"acme-88"}'` says Siren already
   had it. A different answer gets 409 `app_request_already_answered`.
10. `npx siren apps rotate acme-payouts`, restart the server, and resend a request. The new secret
    verifies.
11. Capture every answer the steps saw (S1) and replace the hand-written fakes in
    test/sdk-gaps-fakes.ts, test/cli-fakes.ts and test/apps-siren-answers.ts where they differ.
12. `docker compose -p apps-e2e-cloud down -v` and remove the image.

A production-edition UAT Cloud needs `--live` on every command, and its app address must be public
https.

## Backlog for this slice

| Item | Taken or handed on |
| --- | --- |
| S1, capture Cloud answers and replace the fakes | Handed to the checkpoint lane, step 11. |
| S2, a test that `webhooks.subscriptions.update()` builds a fresh body | Done in eb732f9. |
| S3, the stale comment in test/records-retrieve.test.ts | Done in 1701e12. |
| S4, the build note in src/index.ts | Done in 1701e12. |
| The three routes missing from openapi.yaml | Done by the conventions lane. The docs packet adds the app routes. |
| `GET /obligations/{id}` has no call | Handed to a later SDK lane. It is not an app route. |
| The CLI's sign-in reuses the OAuth client | Not taken, see AP-A606. |
| Two Siren frontend specs expect `^sk_live_` | Handed to the Siren integrator. They are Siren's specs, and this slice runs none. |
| A V2 timestamp check in `webhooks.constructEvent()` | Declared out of scope by ruling S6 (AP-A642). Not handed on. |

## Claims on others

- Slices 4 and 5: the data of a fulfillment-method ask is `{ payoutId, amount, currency }` as
  Siren's fixture shows, and the answer `{ outcome: 'paid', reference }` as answer.json shows. The
  distribution resolver's data `{ amount, currency, metrics: [{ id, value }] }` and answer
  `{ outcome: 'resolved', shares: [{ id, amount }] }` are this slice's guess. Slice 5 owns both and
  the example follows it.
- Slice 9: device sign-in is a second `SignInMethod` that ends in the same `LoginResult`.
- Slice 12: a recipe that holds `apps` beside other stanzas. `parseAppFile` refuses the others until
  then, and `apply` reads only `apps`. A recipe shared with someone else cannot carry a filled
  address, since only `url` is filled and only from `SIREN_APP_` names on the machine that applies
  it. Slice 12 says how a shared recipe carries the app's address: a `${SIREN_APP_URL}` the
  receiver sets, or an address the recipe names outright.
- Slice 1: met. On pkt/apps-exchange at 651704b75, `AppInUseException`, `AppLimitException`,
  `AppChangeInProgressException` and `AppOrgAccessRequiredException` each send `error.code` and
  `context.reason` (saas/Strategies/RestStrategy.php lines 274 to 279 and 354).
- Slice 2: met. The answer route's refusals are `{"error":{"message","code","context"}}`
  (lib/Apps/Core/Models/AppAnswerResult.php), the resend route's carry both, and 409 `app_in_use`
  carries `openRequests` beside `uses`, all on pkt/apps-exchange at 651704b75.
- AP-A214 and slice 7: the sandbox's public address is `https://sandbox.sirenaffiliates.com/siren/v1`.
  No Siren file names it. If the deployment differs, `SANDBOX_BASE_URL` changes in one place.
- Siren: `GET /webhooks/{id}/deliveries` answers an admin for an app-owned subscription. Only writes
  to it are refused (409 `app_owned_subscription`).

## Where the design or a contract was wrong or unclear

1. The backlog says the CLI's sign-in reuses the OAuth client in src/connect. That client mints a
   connector token for a connected site. The app routes need an admin's dashboard session, which
   only `/auth/login` gives. The command calls the session routes instead (AP-A606).
2. Siren lets one app hold two items with the same key under two kinds. The file keys items by key,
   so a key is unique within an app, which keeps `app:<appKey>/<itemKey>` unambiguous. A file cannot
   declare the same key twice under two kinds.
3. There is no `GET /apps/requests/{id}`. `siren apps requests <id>` finds the request among the
   latest 50 and its sends through the app's webhook deliveries. An older request cannot be shown.
4. The app routes put their code in `error.context.reason` and the exchange routes in `error.code`
   when this note was written. `appErrorCode()` reads both in one place, code first. Slices 1 and 2
   have since moved every app refusal to carry `error.code` (Claims on others).
5. `POST /auth/register-org` answers 404 on a sandbox unless `SIREN_SAAS_SIGNUP_ENABLED` is true,
   and the sandbox compose file leaves it unset. Step 2 of the checkpoint sets it.
6. The sandbox's public address is in no Siren file (above).
7. uat/sandbox/docker-compose.yml turns durable tasks off, so jobs run inside the request. Whether an
   ask's delayed wakes run there is not proven. The checkpoint lane finds out at step 8.

## The audit's items

Each item of the audit, taken or declined, with its reason.

| Item | Taken or declined |
| --- | --- |
| M1, the walk | Taken. "The founder's walk", with a sale script, the app's own scopes and one-minute windows. |
| M2, plain http | Taken. Only the three local hosts take http, for `--base-url` and `SIREN_BASE_URL` (AP-A632). |
| M3, filling from the environment | Taken. Only `url`, only `SIREN_APP_` names, never printed or written back (AP-A633). |
| S1, the answer retried | Taken. Sent once, and the caller resends the same answer (AP-A630). |
| S2, email confirmation | Taken. "Confirmation and plan answers". A confirm command waits for a later slice. |
| S3, the key issued once | Taken. The no-key line on `apply`, `envFiles`, `rotate --app-file`, and the line when another Siren's key is replaced (AP-A634 to AP-A636). |
| S4(a), the later apply test | Taken. It now asserts `paths()` is one `PUT`, and mutation `apply-later-sends-more` proves it. |
| S4(b), the drop-by-id docs test | Taken. The README test asserts the drop-by-`id` sentence and that every `Idempotency-Key` sentence says not or never. Mutation `docs-drop-by-key` proves it. |
| S5, the delete advice | Taken. `openRequests` above 0 names `siren apps requests --app <key>` (AP-A641). |
| S6, constructEvent | Taken as ruled. Left as it is (AP-A642). |
| S7, sign-up off | Taken. The 404 line in "Confirmation and plan answers". |
| N1, `--live` for logout and orgs | Taken for `logout`, which sends only the session's own tokens. Declined for `orgs`, which reads a live organization's memberships like any other read. |
| N2, the review checks the comparison | Taken. The review of sdk-verify checks that each `v1` is compared with `timingSafeEqual` after a length check, and never with `===`. |
| N3, read the code first | Taken. `appErrorCode()`. |
| N4, description required and recipes' addresses | Taken. A test case refuses a file with no `description`, and the slice 12 claim says how a shared recipe carries an address. |
| N5, the hidden prompt | Taken. Checkpoint step 5 checks it by hand. |
| N6, the command list | Nothing to do. The audit judged the list close to the smallest, and the walk's sale is a script, not a command. |
| N7, the bin name | Taken as a note. The `siren` link in a project's node_modules/.bin can collide with another package's `siren` bin, and npm warns when it does. The package keeps the name the design gives it. |
| N8, docs, parity and fakes | Taken. The docs test asserts the CHANGELOG names the `new Siren()` change under Changed and the parity intro counts thirteen methods, and the docs packet writes both. The Siren answers moved to test/apps-siren-answers.ts, each citing its Siren file and line. The JSON reader has its own tests. The pinned read order of `apps requests` stays, as the note states it. |

## Packets in build order

Each packet is one commit and turns on the tests named. Packets on the same line can run side by
side.

1. **sdk-verify**: `verifyRequest`. Turns on test/apps-verify-request.test.ts (12). Its review
   checks each `v1` is compared with `timingSafeEqual` after a length check (N2).
   **sdk-apps**: `declare`, `list`, `retrieve`, `setStatus`, `rotate`, `delete` and `appErrorCode`.
   Turns on `apps.declare` and `apps reads and changes` (12).
   **sdk-requests**: `requests.list`, `requests.resend` (3).
   **sdk-answer**: `requests.answer`, sent once (4).
   **sdk-sandbox-guard**: `baseUrlForKey` (3).
   **cli-app-file**: `parseAppFile` with `filled` and the `url`-only rule, `declarationFor`,
   `appFileTemplate`, and the JSON reader. Turns on test/cli-app-file.test.ts (18).
   All six run side by side. They touch different methods and files.
2. **cli-session**, after sdk-apps: `nodeIo`'s prompts, `SessionAuthClient` with the confirmation
   window, `PasswordSignIn`, `CredentialStore` with `envFiles`, `resolveTarget` with the http rule,
   `assertEditionAllowed`, `runCli`'s parsing and dispatch, src/cli/commands/session.ts with the
   confirmation, plan and sign-up-off lines and `logout` without `--live`, and `apps list`, which
   the guard tests use. Turns on `signup, login and the session` (18) and test/cli-build.test.ts (4).
3. **cli-apply**, after cli-session and cli-app-file: src/cli/commands/apply.ts with `apps init`,
   `apply` (filled names, `envFiles`, the no-key line), `show`, `on`, `off`, `rotate` (`--app-file`,
   the recorded path, the other-Siren line), `delete` (the open-asks advice), `list --json` and the
   env file (9).
   **cli-requests**, after cli-session, sdk-requests and sdk-answer: src/cli/commands/requests.ts
   with `apps requests`, `answer` and `resend` (6).
   **example-app**, after sdk-verify and sdk-answer: examples/apps/acme/handler.mjs, env.mjs and
   sale.mjs, with server.mjs and send-sale.mjs as written (8).
   All three run side by side.
4. **docs**, last: the README's `## Siren apps` section with the drop-by-`id` sentence, its
   `## Command-line tool` section, the parity intro's "thirteen methods", the CHANGELOG under
   Unreleased, Added, and under Changed for `new Siren()`, and openapi.yaml's app paths under the
   `dashboardSession` scheme, with `apiKey: []` on the answer route. Turns on
   test/docs-apps-cli.test.ts (12).
