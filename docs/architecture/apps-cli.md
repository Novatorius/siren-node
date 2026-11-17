# Architecture: apps-cli (slice 8 of Siren apps)

Siren apps let a service an organization hosts act as part of Siren's engine. This slice is how a
developer meets that service from Node: an `apps` resource on the client, a helper that checks a
signed request from Siren, a helper that answers one, a `siren` command shipped in this package, and
an example app. This note is the contract for the packets that build it. It follows
[Architecture Phase Contract (KB 643)](https://navigator.novatori.us/r/kb/643), and every pending
test was proven a contract the way
[Proving a Test Is a Contract (KB 730)](https://navigator.novatori.us/r/kb/730) asks.

The architecture commit adds the public surface as stubs that return valid empty values and never
throw, the acceptance tests marked pending with `describe.skip`, the example's skeleton, the parity
rows and the mutation list. A packet turns on its tests by changing `describe.skip` to `describe`.
Nothing here is built yet.

Siren commits read: main at 20c47873d (session routes, `AuthService`, `OrgRegistrationService`),
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
- `requests.answer()` is the one write that retries. Siren takes each answer once and answers the
  same answer again with `duplicate: true` and no further effect, so a resend after a lost answer is
  safe and a lost answer would otherwise leave a payout unpaid until its window ends. It calls the
  transport with `retriable: true` itself and says why in its docblock.
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

The answer and resend routes put the code in `error.code`, so it is the error's `code`. The declare,
status and delete routes put it in `error.context.reason`, so it is `data.reason`.

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

A V2 check in `webhooks.constructEvent()` is left out. Refusing a stale delivery there would break
every receiver that replays deliveries today. It goes to the backlog below.

## The commands

The bin is `siren`, `./dist/cli.js`, built by tsup from src/cli/index.ts. tsup keeps the file's
`#!/usr/bin/env node` line. It needs no new dependency: options are read with `node:util`
`parseArgs`, strict.

| Command | Sends | Prints |
| --- | --- | --- |
| `siren signup [--org-name] [--email] [--password-stdin] [--accept-terms]` | `GET /auth/signup-options`, then `POST /auth/register-org` once | The organization and the address signed in to. |
| `siren login [--email] [--org <slug or id>] [--password-stdin]` | signup-options, `POST /auth/login`, and `POST /auth/select-org` for a person in several organizations | The organization signed in to. |
| `siren logout` | `POST /auth/logout` with the access token and the refresh token | That the session is forgotten. It forgets it even when Siren refuses. |
| `siren orgs` | `GET /auth/memberships` | One line per organization, `*` on the current one. |
| `siren use <slug or id>` | memberships, then `POST /auth/switch-org` | The organization now in use. |
| `siren apps init [--key] [--name]` | nothing | Writes siren.app.json, adds `.env.*` to .gitignore, and never overwrites a file. |
| `siren apps apply [file]` | `PUT /apps/{key}` once | The app and each item with its `app:{id}`. On the first apply, the key's 16-character prefix and the env file it wrote. |
| `siren apps list [--json]` | `GET /apps` | One block per app with its items, or the JSON Siren sent. |
| `siren apps show <key> [--json]` | `GET /apps/{key}` | The app and its items. |
| `siren apps requests [--app <key>] [--attention] [--follow]` | `GET /apps/requests`, and `GET /apps/{key}` once for `--app` | One line per request, oldest first. `--follow` asks again every 2 seconds, prints each new request or status change once, and ends with 0 on Ctrl-C. |
| `siren apps requests <id>` | `GET /apps/requests`, `GET /apps`, `GET /webhooks/{subscription}/deliveries`, in that order | The request, each send with its HTTP status and the app's answer, and the body Siren sent. |
| `siren apps answer <id> (--body <json> or --file <path>)` | `POST /apps/requests/{id}/answer` with the session | Accepted, or that Siren already had this answer. |
| `siren apps resend <id>` | `POST /apps/requests/{id}/resend` | The request as it now stands. |
| `siren apps rotate <key>` | `POST /apps/{key}/rotate` | The new prefix. Writes the new key and secret to the env file. |
| `siren apps on <key>` and `siren apps off <key>` | `POST /apps/{key}/status` | The app's new state. |
| `siren apps delete <key> --yes` | `DELETE /apps/{key}` | That it is gone, or the records that still use it and the `siren apps off` command. |

Every command takes `--sandbox`, `--live`, `--base-url <url>` and `--help`. Exit codes: 0 for done,
1 when Siren or the tool refused, 2 for a command line the tool cannot read, with nothing sent.
Results go to standard output and every refusal is one message on standard error.

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
  "role": "admin", "accessToken": "<JWT>", "refreshToken": "<JWT>", "accessExpiresAt": 1794916800 } } }
```

It never holds the password, the five-minute verification token, an app's key or its secret. The
access token lasts an hour. The command reads its `exp`, refreshes 60 seconds before it, and
refreshes once after a 401, through `CallbackAccessTokenSource`. Each refresh answers a new pair,
which is saved at once because the old refresh token is spent. A refused refresh says to run
`siren login` again.

An app's key and secret go to `.env.sandbox`, or `.env.live` for a live session, beside the app file
for `apply` and in the working folder for `rotate`. The file is mode 0600. Only the three lines
`SIREN_BASE_URL`, `SIREN_API_KEY` and `SIREN_SIGNING_SECRET` are replaced, and every other line is
kept. The command prints the key's 16-character prefix and the file name, never the key or the
secret. When the file cannot be written, it prints both once on standard error and answers 1, since
Siren will not show them again.

## Sandbox and live

- With no flag the command talks to `SIREN_BASE_URL`, else `SANDBOX_BASE_URL`. It reaches
  `https://api.sirenaffiliates.com` only with `--live`.
- `--sandbox` with `--live` or with `--base-url` is a usage error.
- `signup` and `login` read the edition from `GET /auth/signup-options` before they ask for the
  password. A Siren that names no edition counts as live.
- A live edition needs `--live` on every command, whatever address chose it. `--live` against a
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
      "url": "${ACME_SIREN_URL}",
      "scopes": [],
      "events": [],
      "items": {
        "notify-crm": { "kind": "postConversionAction", "name": "Tell the CRM" },
        "acme-ledger": { "kind": "fulfillmentMethod", "name": "Acme ledger", "currencies": ["USD"], "answerWindowMinutes": 4320 }
      }
    }
  }
}
```

`parseAppFile(text, env)` answers the file or every problem, each with its dotted path, line and
column. `apply` prints them as `siren.app.json:9:7: apps.acme-payouts.url: ...` and sends nothing.

- `version` is 1. `name` and `description` are text.
- Any other recipe stanza, such as `programs`, is refused by name. Recipes made of apps and
  programs wait for slice 12. Any other key is refused as not a recipe key.
- `apps` holds exactly one app, keyed by its app key.
- An app takes `name`, `description`, `url`, `scopes`, `events` and `items`, and nothing else.
  `url` starts with `https://`, or with `http://` for `localhost`, `127.0.0.1` or
  `host.docker.internal`, which only a local Cloud reaches (AP-A616).
- `items` is an object keyed by item key, so a key is unique within the app. An item takes `kind`,
  `name`, `description`, `currencies` and `answerWindowMinutes`. `currencies` is required for a
  `fulfillmentMethod` and refused for any other kind. `answerWindowMinutes` runs from 1 to 43200.
- `${NAME}` in any string is filled from the environment. A name that is not set is a problem at
  that key, naming the variable.
- A key written twice is a problem at the second one. A JSON mistake gives the line and column of
  the character the reader stopped at. The reader is a small one in app-file.ts that tracks
  positions, since `JSON.parse` gives neither.

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

`server.mjs` listens on `PORT`, 8787 by default, and reads the env file `apply` wrote. The example
imports nothing from the package but types, so its test drives it with a `Siren` built from src.

## The package

`package.json` gains `"bin": { "siren": "./dist/cli.js" }`. tsup gains the `cli` entry. The build
also writes dist/cli.cjs and its type files, which nothing names. The version stays 0.3.0 and
`CLI_VERSION` must equal it, which a test checks.

## Tests and proof

92 tests are pending in seven files. Each describe's name starts with `apps-cli`.

| File | Tests | Packet |
| --- | --- | --- |
| test/apps-verify-request.test.ts | 12 | sdk-verify |
| test/apps-resource.test.ts, `apps.declare` and `apps reads and changes` | 11 | sdk-apps |
| test/apps-resource.test.ts, `apps.requests` | 3 | sdk-requests |
| test/apps-resource.test.ts, `apps.requests.answer` | 4 | sdk-answer |
| test/apps-resource.test.ts, `sandbox and live keys` | 3 | sdk-sandbox-guard |
| test/cli-app-file.test.ts | 9 | cli-app-file |
| test/cli-commands.test.ts, `signup, login and the session` | 16 | cli-session |
| test/cli-build.test.ts | 4 | cli-session |
| test/cli-commands.test.ts, `apps init, apply and the app key` | 8 | cli-apply |
| test/cli-commands.test.ts, `apps requests, answer and resend` | 6 | cli-requests |
| test/apps-example.test.ts | 5 | example-app |
| test/docs-apps-cli.test.ts | 11 | docs |

test/fixtures/apps-exchange holds Siren's signed-request.json and answer.json from 086615e2a, byte
for byte. The parity rows are in the README's Node-only table now, and test/docs-parity.test.ts
passes with them.

The proof ran in a separate clone (/media/alex/DATA/siren-wt/apps-node-cli-proof), never committed
from or pushed. It holds a scratch implementation of every stub, the tests turned on, and the docs.
There, `npm test` gives 101 files, 2599 passed and 1 skipped, and `npm run typecheck` is clean. On
the stubbed tree all 92 are pending and the suite gives 2507 passed and 93 skipped.

The mutation list is scripts/mutations/apps-cli.json. Its `find` texts are the scratch
implementation's. A packet that builds a guard rewrites that guard's `find` for its own code and
runs the list, as the harness's usage line says:

```
unshare -rn sh -c 'ip link set lo up && node scripts/mutation-proof.mjs scripts/mutations/apps-cli.json'
```

The list holds the four controls and 93 guards, one mutation per guard. A first run scored 91 of 96:
five mutations did not compile, so the harness refused them. They were rewritten to compile, the
local http rule (AP-A616) gained its test and a guard, and the second run below scored all 97.

The second run on the proof clone, the scored line of each mutation (the full output also names the
failing tests under each):

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
OK   answer-not-retried: caught (expected caught)
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

97 of 97 mutations scored as expected.
```

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
   Check credentials.json is mode 0600 and holds no password.
6. In a copy of examples/apps/acme: `ACME_SIREN_URL=http://host.docker.internal:8787 npx siren apps apply`.
   Check .env.sandbox holds an `sk_test_` key, and that no key or secret was printed.
7. `npm install && npm start`. In the sandbox dashboard, pick "Acme: Acme ledger" on an
   autofulfiller and pay a payout through it, or run the walk the design names.
8. `npx siren apps requests --follow` shows the ask go from `sent` to `answered` to `applied`.
   `npx siren apps requests <id>` shows the send, the 200 and the body.
9. `npx siren apps answer <id> --body '{"outcome":"paid","reference":"acme-88"}'` says Siren already
   had it. A different answer gets 409 `app_request_already_answered`.
10. `npx siren apps rotate acme-payouts`, restart the server, and resend a request. The new secret
    verifies.
11. Capture every answer the steps saw (S1) and replace the hand-written fakes in
    test/sdk-gaps-fakes.ts, test/cli-fakes.ts and test/apps-resource.test.ts where they differ.
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
| A V2 timestamp check in `webhooks.constructEvent()` | New. Handed to the next SDK lane, as a breaking change. |

## Claims on others

- Slices 4 and 5: the data of a fulfillment-method ask is `{ payoutId, amount, currency }` as
  Siren's fixture shows, and the answer `{ outcome: 'paid', reference }` as answer.json shows. The
  distribution resolver's data `{ amount, currency, metrics: [{ id, value }] }` and answer
  `{ outcome: 'resolved', shares: [{ id, amount }] }` are this slice's guess. Slice 5 owns both and
  the example follows it.
- Slice 9: device sign-in is a second `SignInMethod` that ends in the same `LoginResult`.
- Slice 12: a recipe that holds `apps` beside other stanzas. `parseAppFile` refuses the others until
  then, and `apply` reads only `apps`.
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
4. The app routes put their code in `error.context.reason` and the exchange routes in `error.code`.
   Both are documented, but a caller has to read both.
5. `POST /auth/register-org` answers 404 on a sandbox unless `SIREN_SAAS_SIGNUP_ENABLED` is true,
   and the sandbox compose file leaves it unset. Step 2 of the checkpoint sets it.
6. The sandbox's public address is in no Siren file (above).
7. uat/sandbox/docker-compose.yml turns durable tasks off, so jobs run inside the request. Whether an
   ask's delayed wakes run there is not proven. The checkpoint lane finds out at step 8.

## Packets in build order

Each packet is one commit and turns on the tests named. Packets on the same line can run side by
side.

1. **sdk-verify**: `verifyRequest`. Turns on test/apps-verify-request.test.ts (12).
   **sdk-apps**: `declare`, `list`, `retrieve`, `setStatus`, `rotate`, `delete`. Turns on
   `apps.declare` and `apps reads and changes` (11).
   **sdk-requests**: `requests.list`, `requests.resend` (3).
   **sdk-answer**: `requests.answer` (4).
   **sdk-sandbox-guard**: `baseUrlForKey` (3).
   **cli-app-file**: `parseAppFile`, `declarationFor`, `appFileTemplate`. Turns on
   test/cli-app-file.test.ts (9).
   All six run side by side. They touch different methods and files.
2. **cli-session**, after sdk-apps: `nodeIo`'s prompts, `SessionAuthClient`, `PasswordSignIn`,
   `CredentialStore`, `resolveTarget`, `assertEditionAllowed`, `runCli`'s parsing and dispatch,
   src/cli/commands/session.ts, and `apps list`, which the guard tests use. Turns on
   `signup, login and the session` (16) and test/cli-build.test.ts (4).
3. **cli-apply**, after cli-session and cli-app-file: src/cli/commands/apply.ts with `apps init`,
   `apply`, `show`, `on`, `off`, `rotate`, `delete`, `list --json` and the env file (8).
   **cli-requests**, after cli-session, sdk-requests and sdk-answer: src/cli/commands/requests.ts
   with `apps requests`, `answer` and `resend` (6).
   **example-app**, after sdk-verify and sdk-answer: examples/apps/acme/handler.mjs (5).
   All three run side by side.
4. **docs**, last: the README's `## Siren apps` and `## Command-line tool` sections, the CHANGELOG
   under Unreleased, Added, and openapi.yaml's app paths under the `dashboardSession` scheme, with
   `apiKey: []` on the answer route. Turns on test/docs-apps-cli.test.ts (11).
