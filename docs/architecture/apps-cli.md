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
| `siren.apps.requests.retrieve(id)` | `GET /apps/requests/{requestKey}` | admin session | src/resources/apps.ts |
| `siren.apps.requests.resend(id)` | `POST /apps/requests/{id}/resend` | admin session | src/resources/apps.ts |
| `siren.apps.requests.answer(id, answer)` | `POST /apps/requests/{id}/answer` | the app's key, or an admin session | src/resources/apps.ts |

Every app route but the answer route refuses an API key with 401 `api_key_not_accepted`. The types
live in src/record-types.ts. The vocabularies `FeatureKind`, `AppStatus`, `AppRequestStatus` and
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
| 409 `app_request_not_resendable` | `ConflictError` | Reads the request. It is applied, or it would be sent and its app is off. A request that holds an answer not yet applied, `answered` or `needs_attention`, is never refused: Siren applies the stored answer, even while the app is off. |
| 409 `app_request_already_answered` | `ConflictError` | Stops. A different answer came first, and it stands. |
| 409 `app_request_not_needing_attention` | `ConflictError` | A person answered an ask that does not need attention, such as one `pending` or `sent`. Waits for the app, or answers once `siren apps requests --attention` lists the ask. The app's own key answers its own ask at any time before it is applied. Siren checks the status before the answer's fit, so a misfit answer gets this and not 422. The code is named by Siren (lib/Apps/Service/Services/AppRequestService.php lines 680 to 687 on pkt/apps-screen-a at fcf19b1f0). |
| 404 `app_request_not_found` | `NotFoundError` | Checks the id. The answer route tells an admin "This organization has no request with this key." and an app's key "No request with this key was sent to this app.", which also covers another app's request (AppRequestService.php line 698 at 27169452a). The resend and read routes say "App request not found." |
| 403 `app_inactive` or `app_answer_forbidden` | `PermissionError` | Turns the app on, or answers as an admin. |
| 422 `app_answer_invalid` | `ValidationError` | Fixes the answer for the item's kind. |
| 401 with no code, for a missing or unknown bearer | `AuthenticationError` with `code` `app_answer_unauthorized`, and a message that names `siren apps rotate-key <app key>` for a lost key and `siren apps add-key <app key>` for an app that holds none (slice C6) in place of Siren's "make a new one under API keys", which is kept as `cause` | Uses the app's own key or an admin's session. Siren's key check, which every route shares, sends this 401 with no code before the answer route runs (captures apps-answer-401-no-bearer and apps-answer-401-unknown-key), so `requests.answer()` gives it the code. An org key that is no app's gets 404 `app_request_not_found` (capture apps-answer-404-plain-org-key). |
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
   `app.request`, `mode` `tell` or `ask`, `app`, `feature` with `kind`, `key` and `id`, `createdAt`, an
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
`parseArgs`, first loosely to find the command, then strictly with that command's options, so an
unknown option is refused in the tool's own words with the nearest real one (`There is no option
--emial for siren login. Did you mean --email?`), and a mistyped command names the nearest command.
`siren` alone plays the hook and prints where you stand: signed in or not, to which Siren, and the
three commands that come next, with exit code 0. `siren apps` lists the apps commands. `siren help
[command]`, `siren version` and `-v` work as `--help` and `--version` do. Each command's `--help`
lists its options with a line each, the shared ones, and an example (CLI pass 1, findings 3 and
7).

| Command | Sends | Prints |
| --- | --- | --- |
| `siren signup [--org-name] [--email] [--password-stdin] [--accept-terms]` | `GET /auth/signup-options`, then `POST /auth/register-org` once | The organization and the address signed in to. See "Confirmation and plan answers" for the other outcomes. |
| `siren login` | signup-options, `POST /auth/cli/code`, then `POST /auth/cli/token` each interval | The logo with its halves apart beside the code, the link and a spinner while it waits, the halves gripping when the approval lands, then `Logged in as <email> · N organizations`. |
| `siren login --password [--email]`, or `--password-stdin --email` | signup-options, `POST /auth/login`, and `POST /auth/select-org` with the first organization for a person in several | The same line, and the days left to confirm the address when Siren says so. `--email` alone is a usage error. |
| `siren logout` | `POST /auth/logout` with the access token and the refresh token | That the session is forgotten. It forgets it even when Siren refuses, and it needs no `--live` (AP-A640). |
| `siren whoami [--json]` | nothing, or with `SIREN_TOKEN` signup-options and `GET /personal-tokens/current` | Which credential is in use, who it acts as, the organization and role, and whether that Siren is live. For a session, the session file's path, and exit 1 when none is kept there (CLI pass 1, finding 2). For a token, its name, last four characters and expiry. |
| `siren orgs [--json]` | `GET /auth/memberships` | A table of slug, name and role, with the one --org, SIREN_ORG, the app file or a single membership picks marked by a green ● in a terminal and `*` plain. With several and none picked, a tip says how a command picks one. `--json` prints the memberships. |
| `siren apps init [--key] [--name]` | nothing | Writes siren.app.json with `$schema` and one Post-conversion action, adds `.env.sandbox`, `.env.live` and `.env.*.tmp` to .gitignore, never overwrites a file, and says where `SIREN_APP_URL` goes, how to add a feature, and that Siren sends requests only to a handler on an https address (CLI pass 1, finding 5). |
| `siren apps apply [file] [--yes]` | `GET /apps/{key}`, then `PUT /apps/{key}` once after the person agrees (slice C6) | Each change the file would make, then the question, then the app and each feature with its `app:{id}`, never the url, and the name of each variable it filled. On the first apply, the key's 16-character prefix and the absolute path of the env file it wrote. On a later apply with no `SIREN_API_KEY` in that file, a line that says this is fine when the service already holds a key, and that `siren apps rotate-key <key>` would revoke the key in use (CLI pass 2, finding 2). A file that gives a feature Siren holds a new kind is refused before anything is sent, naming its `app:{id}` and how many records select it, because the kind locks and the plan would replace the feature with a new id (finding 3). `--json` prints `{plan, applied, app}`, never the key or secret, and sends nothing without `--yes` (finding 1). Each scope and event the app does not hold yet, compared as Siren stores scopes, is checked against `GET /apps/scopes` and `GET /apps/events` before the plan. An unknown one is refused with the nearest name, or the names that share its first part, and the command that lists them. A list it cannot read leaves the check to Siren, and a wildcard scope is Siren's to judge (finding 5). The schema offers the SDK's scopes and events as examples, not an enum, so a custom event type's scope still passes. Under the plan, or under "already matches", an amber line says when the app is off and names `siren apps on <key>`, and the plan's JSON carries `on` (finding 10). A file problem whose message already starts with its path, or its app's, prints no path before it (finding 11), and an unknown kind names the nearest one (finding 7). Each change line gives the old and new value: text in quotes cut at 40 characters, `none` for an empty side, a number or yes and no as it is, a set as what it adds and removes, and a moved address by its hosts (finding 3). |
| `siren apps pull <key> [file] [--url-env] [--yes] [--json]` | `GET /apps/{key}` | `✓ Wrote siren.app.json from <key>` with the features, the url's host or `from SIREN_APP_URL`, the archived features it left out, and `siren apps diff` as the next step (CLI pass 2, finding 6). The file is the inverse of `declarationFor`: scopes as Siren stores them, events only with an address, and each setting only for the kind that takes it, so diff finds nothing to change. It reads only, so a live organization needs no `--live`. It asks before replacing a file, refuses with no terminal and no `--yes`, and adds the env files to `.gitignore` as init does. `--json` prints `{path, file}`. |
| `siren apps scopes [--json]` | `GET /apps/scopes` | A SCOPE and ALLOWS table, or Siren's groups as JSON (CLI pass 2, finding 5). |
| `siren apps events [--json]` | `GET /apps/events` | An EVENT and MEANS table in the catalog's order, or Siren's list as JSON. |
| `siren apps diff [file] [--json]` | `GET /apps/{key}`, and the scope and event lists when the file names one the app lacks | The plan apply would print, or that the file matches, with no question. Exit 0 when it matches and 3 when it differs, as `terraform plan -detailed-exitcode` and `git diff --exit-code` do (CLI pass 2, finding 1). It reads only, so a live organization needs no `--live`, and it skips apply's env file checks since it writes nothing. `--json` prints the plan with each change marked `add`, `remove` or `change`. |
| `siren apps list [--json]` | `GET /apps` | One block per app with its features, and under an app whose `needsAttention` is above 0 the count and `siren apps requests --app <key> --attention`, or the JSON Siren sent. |
| `siren apps show <key> [--json]` | `GET /apps/{key}` | The key, with the name beside it only when it differs, then the app and its features. Each kind reads `Post-conversion action (postConversionAction)` when the line fits the terminal. When it does not, the table drops the code name first, a Kinds row in the block names the code names, and only then is NAME cut with an ellipsis. `--json` keeps both, each archived feature marked "archived, so Siren no longer calls it" beside it, as `list` and `apply` mark it, and the `needsAttention` line `list` prints. |
| `siren apps requests [--app <key>] [--attention] [--follow] [--json]` | `GET /apps` once, then `GET /apps/requests` and `GET /apps/requests?status=needs_attention` | A count line, then a table, oldest first: the organization's latest 50 and every request that needs attention, however old, so an app that `apps list` counts one for never shows none. The columns are ID (the first 8 hex characters, or the whole id on a Siren without the prefix lookup), WHEN (local time, from `TZ`), APP, FEATURE (the kind's short name), ABOUT, SENDS and STATE, or WHY with `--attention`. In a terminal the table leaves out SENDS, then APP, then ABOUT until it fits the width. `--attention` reads the attention list alone. `--follow` asks again every 2 seconds, reading the target's edition before each poll, prints each new request or status change once as a row, and ends with 130 on Ctrl-C, or with 1 when the target changed edition. `--json` prints the rows as Siren sent them, as one array, or one object a line with `--follow`. |
| `siren apps requests <id> [--json]` | `GET /apps/requests/{requestKey}`, `GET /apps`, `GET /webhooks/{subscription}/deliveries`, in that order | A block with the request's state, kind, app and feature, subject, time, and the answer Siren took and who gave it, or that none came yet. Then SENDS, a table of each send with its HTTP status and what the app said back, then DATA, the data Siren sent, as indented key and value lines with the keys dim and aligned at each level, an object's entries two spaces in under its key, each object in a list under its number from 1, and a list of plain values on one line. In a terminal a long value wraps under itself, so no line passes 80 columns. `--json` keeps the data whole. Then the commands that answer it or send it again. Here and in `answer` and `resend`, a request id may be its first 4 or more hex characters after `apr_`, with or without the `apr_`, as git takes a commit's. The tool finds the whole id with one call, `GET /apps/requests?idPrefix=apr_<start>`, which Siren reads from feat/apps 76d5bbdf83 and answers with at most two of the organization's matches, newest first (CLI pass 3, must-fix 1). One match is the request. None is refused with `siren apps requests`. Two are refused with both listed and "and maybe more", and the tool never picks one. An older Siren refuses the param with 400 or ignores it and answers its latest requests. Against that Siren a start is refused with the advice to give the whole id, and the list, its tips and the views print whole ids, since a short one could not be found. Before it prints a short id, a command makes one lookup for an id it shows, the list's newest or the request it acted on, and prints whole ids when that lookup doesn't find it. A start the person typed was found that way already, so it costs no second call. A request whose answer Siren took prints no tip, so it costs none. `--json` prints Siren's detail with three fields added: `appKey` and `featureKey`, which Siren's detail names only by id, and `sends`, the deliveries found for the request. The keys are null and `sends` is empty when the app is gone. The SDKs' replay helpers read this object. A request the organization does not have gets one line that names `siren apps requests`. |
| `siren apps answer <id> (--body <json> or --file <path>)` | `POST /apps/requests/{id}/answer` with the session | `✓ Answered <short id>` with the answer, or that Siren already had this answer. A person may answer only a request that needs attention, which `siren apps requests --attention` lists. Siren refuses a hand answer to any other ask with 409 `app_request_not_needing_attention`, named by Siren (pkt/apps-screen-a at fcf19b1f0), and the command prints Siren's line and that `--attention` list. A refusal whose code the SDK does not know prints Siren's message and the code, and exits 1. |
| `siren apps resend <id>` | `POST /apps/requests/{id}/resend`, and on 409 `app_request_not_resendable` for a request not `applied`, `GET /apps/requests/{requestKey}` and `GET /apps` | `✓ Sent <short id> again` with the request's state and sends. On that 409, that its app is off, with `siren apps on <key>` and the resend to run after. An `applied` request is told there is nothing to send. |
| `siren apps rotate-key <key> [--app-file <path>] [--yes]` | `POST /apps/{key}/key/rotate` | The new prefix and the absolute path of the env file. Asks first. Writes the new key where `apply` wrote the first, or beside the named app file (AP-A634), and leaves the signing secret's line alone (slice C6). |
| `siren apps rotate-secret <key> [--app-file <path>] [--yes]` | `POST /apps/{key}/secret/rotate` | The absolute path of the env file. Asks first, and writes only `SIREN_SIGNING_SECRET` (slice C6). |
| `siren apps on <key>` and `siren apps off <key>` | `POST /apps/{key}/status` | `✓ <key> is on. Siren sends it requests again.`, or `✓ <key> is off. Siren sends it nothing until siren apps on <key>.` |
| `siren apps delete <key> --yes` | `DELETE /apps/{key}`, and `GET /apps/{key}` after a 409 that names records | That it is gone. On 409 `app_in_use`: the records in `uses` with the `siren apps off` command while the app is on, or, once it is off, that those records must change before a delete, and when `openRequests` is above 0, `siren apps requests --app <key>` and the advice to answer or wait for the open asks (AP-A641). |

Every command takes `--sandbox`, `--live`, `--base-url <url>`, `--quiet` and `--help`. Exit codes:
0 for done, 1 when Siren or the tool refused, 2 for a command line the tool cannot read, with
nothing sent, and 130 after Ctrl-C during the hook.
Results go to standard output and every refusal is one message on standard error.

A command checks what it was given on the line before it sends anything, the edition read
included, and answers 2 in its own words with the usage line: a request id that is not `apr_` and
32 lowercase hex characters (`answer`, `resend`, `requests <id>`), an app key Siren cannot hold
(`show`, `on`, `off`, `rotate-key`, `rotate-secret`, `add-key`, `delete`, `requests --app`), and an answer that is not JSON, not
an object, has no text `outcome`, or is longer than 16384 bytes. Before, `siren apps answer
apr_xyz` exited 1 with the SDK's line, which named `apps.requests.answer()` (e2e step 11d), and
`requests --app <bad key>` sent the list before it refused. test/cli-arguments.test.ts covers each.

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

Login logs in the person, not an organization (Alex, 2026-11-24). The session keeps every
membership, and each command picks its organization in this order: `--org <slug>`, `SIREN_ORG`,
`org` in siren.app.json, then the person's only organization. With none of those it asks in a
terminal and refuses elsewhere with the list (`CommandContext.wantedOrg` and `pickOrg` in
src/cli/context.ts). When the chosen organization differs from the one the tokens act in, the tool
calls `POST /auth/switch-org` and holds the new pair in memory for that run, refreshes included
(src/cli/org.ts). The stored session never changes, so two folders can act in two organizations
at once.
A personal access token acts in the organization it was made in, and the tool refuses when a flag,
the variable or the file names another. Every question before a write names the organization, as
`Apply to Acme (acme), live? [y/N]`.

`SessionAuthClient` (src/cli/session-auth.ts) calls Siren's session routes through the `HttpClient`,
as `OAuthClient` calls the OAuth routes: one JSON request each, the SDK's headers, the reads retried
twice, every other call sent once, and no error that carries a password or a token. It is internal
to the command and the package does not export it. It reuses nothing of src/connect: the OAuth
client mints a connector token for a connected site, and the app routes need an admin's dashboard
session (AP-A606).

The password comes from a hidden prompt or from standard input with `--password-stdin`, never a
flag, and is sent once. The hidden prompt turns the terminal's echo off before it writes
`Password: `, and puts the terminal back however the prompt ends, Ctrl-C included. The order
matters: Node sets raw mode only once the terminal has taken the output already written (libuv
uses TCSADRAIN), so with the question written first, a person or a password manager typing the
instant it appeared got in while echo was still on. The checkpoint saw that in 3 of 6 runs, and
test/cli-hidden-prompt.test.ts saw it in 45 of 60 runs before the fix and in none of 180 after.
`PasswordSignIn` is one `SignInMethod`, which `--password` or `--password-stdin` chooses.

`DeviceSignIn` is the other, and `siren login` uses it by default in a terminal (Alex's ruling
M105, contract/cli-signin.md in the run folder). It follows RFC 8628:

- `POST /auth/cli/code` with the machine's host name, cut to the 1 to 63 letters, digits, dots, hyphens and underscores Siren takes, with any other character made a hyphen and `siren-cli` for an empty one (`machineName`). Siren answers a device code, which the tool
  keeps in memory and never prints, a short user code, the dashboard's approval page with the code
  filled in, its life and the poll interval.
- The tool prints the user code and the page, and opens the page with the system's opener (`open`,
  `rundll32` or `xdg-open`), given the address as one argument and never through a shell. It opens
  nothing over SSH, on a Linux machine with no display, or for an address that is not http or
  https. It refuses an answer whose user code holds anything but letters, digits and dashes.
- Before it opens or prints the page, it checks where the page is. A plain http page must be on
  this machine, as the API must be. The page must be on the API's own host, or, for a Siren Cloud
  API, on another `sirenaffiliates.com` host, where the dashboard lives apart from the API. Any
  other page stops the login before the first poll, so a server that answers for Siren cannot send
  the person to a look-alike page (`pageProblem`). The view shows the host of the Siren the tool
  polls beside the code, so the person can match it against the page.
- It polls `POST /auth/cli/token` every interval: `authorization_pending` waits the interval Siren
  names, `slow_down` waits the longer one it names, and a network fault, a 5xx or a 429 waits and
  polls again until the code's life runs out. `access_denied`, `expired_token` and `invalid_grant`
  stop with one line. An interval is held between 1 and 60 seconds whatever Siren names, and the
  wait stops after the code's life or 15 minutes, whichever comes first.
- Ctrl-C under the logo wins over an approval that lands in the same poll: the tool keeps no
  session and exits 1.
- The approval answers the same `LoginResult` a password gives, so the session is kept as before.
  The store writes credentials.json at mode 0600 and sets its folder to 0700 on every write, also
  when the folder was already there with looser modes.
- Every name, email and role Siren sends loses its escape sequences and control characters before
  the tool keeps or prints it (`clean` in the style module), so no answer can move the cursor,
  clear the screen or plant a terminal link.
- The logo animation plays the moment the approval lands, with every skip rule. It counts as the
  first-run animation, which `login` holds back for that moment.

With no terminal, or with `CI` set, `siren login` with no password flag sends nothing and says to set
`SIREN_TOKEN` or pass `--email` and `--password-stdin`. `--org` belongs to the password path, since
the approval page asks for the organization.

### SIREN_TOKEN

A personal access token (`siren_pat_` and 48 hex characters) acts as one person in one organization
on the apps routes the commands call, and nowhere else. When `SIREN_TOKEN` is set,
`CommandContext.signedIn()` uses it before credentials.json:

- A value of another form is refused before it is sent anywhere, and no message quotes it.
- The edition read and the `--live` rule run as for a session. Then `GET /personal-tokens/current`
  says who the token acts as, once a command, so `apply` can name the organization in its question.
- The token is never refreshed. A 401 says the token was revoked or has expired. A 403
  `token_not_accepted` says Siren takes no token there and names `siren login`.
- Nothing is written to credentials.json, `envFiles` included.
- The target is the flag, `SIREN_BASE_URL` or the default, never the Siren remembered from the last
  sign-in, so a token never goes to a Siren the script did not name.
- `apps answer`, `orgs` and `use` call routes that take no token. They use the stored session when
  there is one, and otherwise refuse before sending.
- `apply` reads how many records select a dropped feature from the `uses` that `GET /apps/{key}`
  gives each feature, since the feature routes take no token.
- `whoami` names the source in use. With a token it reads the edition and the token's own record,
  and prints its name and last four characters, never the token.

`credentials.json` sits in `SIREN_CONFIG_DIR`, else `%APPDATA%\siren` on Windows, else
`$XDG_CONFIG_HOME/siren`, else `~/.config/siren`. The folder is mode 0700 and the file 0600, written
through a temporary file and a rename. A file anyone else can read is refused before a token in it
is used, with a message naming the file and `chmod 600`. `signup` and `login` read it before they
send anything, so a file the tool would refuse stops them before the password leaves the machine.
It holds one session per Siren address:

```json
{ "version": 1, "sessions": { "https://sandbox.sirenaffiliates.com/siren/v1": {
  "edition": "sandbox", "baseUrl": "https://sandbox.sirenaffiliates.com/siren/v1",
  "email": "dev@acme.example", "userId": 7, "orgId": 3, "orgName": "Acme",
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
Siren shows it once. A later `apply`, and `rotate`, stop before sending when the file names
another `SIREN_BASE_URL`, say which Siren's key it holds, and say to move the file aside and run the
command again (AP-A906), so a key the machine still needs is never replaced and the app never talks
to the wrong Siren unnoticed. Only the three lines `SIREN_BASE_URL`, `SIREN_API_KEY` and
`SIREN_SIGNING_SECRET` are replaced, and every other line is kept. The whole text goes to a new
file made with mode 0600 beside the env file, which is then renamed over it, as credentials.json is
written. So the key is never in a file wider than 0600, a failed write leaves the old file whole,
and a link at the path is replaced rather than followed. Before `apply` or `rotate` sends
anything, it checks that the env path can be written as a regular file: it is a regular file, or it
is not there and its folder exists and can be written to. A symbolic link, a folder, a missing
folder and a folder the tool cannot write to are each refused with one line that says why, since
Siren issues a pair once (the orchestrator's ruling in the fix round, AP-A904). The command prints
the key's 16-character prefix and the file name, never the key or the secret. When a write the
check could not foresee still fails, it says on standard error that Siren issued a pair it could
not save and that `siren apps rotate-key <key>` or `rotate-secret` issues a new one, prints neither value, and answers 1.
After a rotate it also says that the old key left in the file is revoked. The new file is written
as `.env.sandbox.<hex>.tmp` before the rename, a name the `.env.*` line `apps init` writes covers.

### A closed pipe

When the reader of the tool's output goes away, as `siren apps list | head` does after ten lines,
Node reports EPIPE on standard output. The bin entry ends the command with exit code 0 there and
prints nothing, as gh and git do (src/cli/pipe.ts). Any other stream error still ends the process.

## How the tool prints

Every line the tool prints goes through one module, src/cli/style.ts (Alex's ruling M108, "I would
expect much cleaner error messages and more styled responses. across the board on this."). No
command writes its own escape codes.

- Siren green (#00FFB9, or color 49 of 256) marks success and the wordmark. Red marks an error,
  amber a warning, and dim the detail around it. Bold marks the one thing a line is about, and a
  command a person can run.
- ✓ means done, ✗ failed, ! a warning and › a next step or a tip.
- A command's success output has one shape, which `siren apps init` set: a ✓ headline with the
  thing in bold, a short block of dim labels and their values, a numbered Next with the commands
  in bold, and one or two dim tips. A file in the working folder is named, not given as a path.
- An error has three parts: a red bold ✗ headline, the why under it indented two spaces, and the
  fix led by a green ›, with the command in bold (catalog mockup 4). `RefusalParts` in
  src/cli/targets.ts requires the why and the fix, a command or a sentence, so tsc holds every
  refusal to the shape (CLI pass 3, must-fix 2). In a terminal, the style module wraps every ✗, ✓,
  ! and › line at a word boundary within 80 columns with a two-space hanging indent, and keeps a
  command that fits a line on one line. Piped, an error stays one `siren:` line. An error names a
  Siren by its host, never its whole address, and a file in the working folder by its name.
  `--verbose` or `SIREN_DEBUG=1` adds one dim line under it with the HTTP status, Siren's error
  code and the host, such as `HTTP 401 · sandbox.sirenaffiliates.com`. A wrong email or password
  reads "Siren didn't accept that email and password." with the why and the fix on their own
  lines, not Siren's sentence. Siren's own 404 for an app or a request names the key or id the
  person typed, and Node's JSON parser text never prints. Problems in siren.app.json print under
  the ✗ headline, each place dim with its message under it, and piped, each is one
  `file:line:col: message` line (must-fix 3). A browser login against a Siren that answers
  `POST /auth/cli/code` with 404 says it offers no browser login yet and names `siren login
  --password` (must-fix 4). A command typo and a flag typo share the shape: the headline, the
  help or usage line, and `› Did you mean …?` (should-fix 15). `siren app list` offers `siren apps
  list` (should-fix 6). With no session, every command says "Not logged in.", that the tool keeps
  no session for that host, and "Run siren login to log in."
- Long work shows a spinner that turns into one ✓ or ✗ line.
- Help follows gh's: a one-line description, USAGE, the commands under Getting started, Apps,
  Requests and Account with one aligned line each, FLAGS, ENVIRONMENT, EXAMPLES and LEARN MORE.
  `siren <command> --help` has the same shape with its own flags and one or two examples. No help
  line passes 80 columns.

Output is plain when the stream is not a terminal, under `NO_COLOR` (any value but empty), when
`TERM` is `dumb`, under `CI`, and with `--json`. Plain output carries no symbol and no escape code.
It keeps the same layout, and an error keeps its old one-line form, `siren: ` and the headline,
why and fix in one sentence. `--json` output is never styled. Exit codes do not change.

## The hook on first run

The first time a person runs the tool in a terminal, it plays Siren's hook (src/cli/hook.ts). The
two halves of the logo slide in and grip, 39 frames 50 milliseconds apart, about 1.9 seconds. Then
the logo floats: it lifts up to one braille row (4 dots) into a blank row above it and settles,
over a dim shadow that narrows as it rises, 20 frames more. The shadow goes when the logo
settles, so no stray line sits above the next output. The whole run takes 2.95 seconds.

The text never waits for the logo. Every line is printed with the first frame, and each later frame
redraws only the logo's columns in place. In a terminal wide enough for the logo and the longest
line, the text sits to its right: "Siren" in bold Siren green with the version, then the card's
lines. In a narrower one that is tall enough, the text sits under the logo, as before. When neither
fits, the hook does not play and the plain text is printed.

On first run the card is the wordmark and one line that names `siren --help`. `siren` with nothing
after it plays the hook each time with the status card: "Not logged in. Run siren login to log in."
or who is logged in to which organization on which Siren, the three commands that come next
(`login`, `apps init` and `apps apply`, or `apps init`, `apps apply` and `apps requests --follow`
once logged in), and `siren --help`, and answers 0. It reads credentials.json and sends nothing.
The signed-out card names the Siren only when it is not the default sandbox or live one.

The frames are braille, 24 characters by 14 lines, in src/cli/hook-frames.ts. They come from the
website's public/logo-animated-once.svg through scripts/build-hook-frames.mjs with `--slow 1.6`,
which steps the SVG's 1.2 second CSS animation in headless Chromium at 1.6 times as many points. The
hover is not in the file: hook.ts lifts the last frame by whole dots. The package gains no runtime
dependency. The green is
the dark theme's `--primary` in Siren's frontend/src/index.css, `164 100% 50%`, which that file
names the exact logo color #00FFB9. The logo fills both halves with it. The tool draws it in
truecolor when `COLORTERM` is `truecolor` or `24bit`, else as color 49 of 256.

It never plays when standard output is not a terminal, under `CI` (any value but `false` or `0`),
under `NO_COLOR` (any value but empty), when `TERM` is `dumb`, with `--quiet` or `--json`, in a
terminal smaller than 28 by 20, or in a Windows console other than Windows Terminal. Each of those
skips costs no time and leaves first run for later. Any key jumps to the still logo. Ctrl-C stops
the command with exit code 130. The cursor comes back and standard input leaves raw mode however
it ends, also when the process exits mid-way. When standard input is not a terminal, as with
`--password-stdin`, the hook never reads it. `state.json` in the config folder records that it
played.

## Sandbox and live

- With no flag the command talks to `SIREN_BASE_URL`, else the Siren the last `login`, `signup`
  or `use` was for (`current` in credentials.json), else `SANDBOX_BASE_URL`. It reaches
  `https://api.sirenaffiliates.com` only with `--live` or after signing in to it. `--live` alone
  skips a remembered sandbox. `logout` forgets the remembered Siren with its session. A command
  with no session for its Siren names the Siren a session is kept for and the `--base-url` that
  reaches it (CLI pass 1, finding 2).
- An address may be a bare host. `siren.example.com` becomes `https://siren.example.com/siren/v1`,
  and an address with no path gets `/siren/v1` (CLI pass 1, finding 9).
- `--sandbox` with `--live` or with `--base-url` is a usage error.
- `--base-url` and `SIREN_BASE_URL` take `http://` only for `localhost`, `127.0.0.1` and
  `host.docker.internal`. Any other address must be https, or the command is a usage error, exit 2,
  with nothing sent, since every command sends a password or a session token (AP-A632).
- Every command that sends anything reads the edition from `GET /auth/signup-options` first, on
  every run, before anything else is sent. `signup` and `login` read it before they ask for the
  password. A Siren that names no edition counts as live. The read costs one GET with no
  credential, a few dozen bytes. Each attempt may take 3 seconds and it is sent once more after a
  network error, 429 or 5xx, so a target that hangs is given up after 6.5 seconds with the line
  `<address> did not answer when the tool asked which edition it is, so nothing was sent.`
  `CommandContext` keeps the answer for the
  run, so a refresh and a second call use it. `apps requests --follow` reads it again before each
  poll after the first (`recheckEdition()`), so a target that changes edition during the run stops
  it with the same one line before the session is sent there again. That costs one more GET every
  2 seconds while following. `apps init` sends nothing and reads nothing.
- A live edition needs `--live` to sign up, sign in, and change anything: `apply`, `answer`,
  `resend`, `rotate-key`, `rotate-secret`, `add-key`, `on`, `off` and `delete`, whatever address
  chose it. The reads, `whoami`, `orgs`, `use`, `apps list`, `apps show` and `apps requests`, need
  none, since signing in with `--live` already said the person means that Siren (CLI pass 1,
  finding 2). Signing out sends only the session's own tokens, to revoke them. `--live` against a
  sandbox is refused. A new app's question names the organization and whether it is live.
- A stored session keeps the edition and the address it was made for (`edition`, `baseUrl`). A
  command whose target now reports another edition, or a session stored for another address,
  stops with one line before it sends anything with the session: what the target is now, what the
  session was made for, and the `siren login` to run, with `--live` when the target is live. So a
  session made on a sandbox never lists or changes a live organization because the same address
  became live, and a live session never acts on a Siren that became a sandbox. The checkpoint saw
  both against a real Cloud (e2e steps 20a and 20l) before this check.
- Every hint that names a command carries the flags that reach the same Siren: the `--base-url
  <address>` or `--sandbox` the person typed, and `--live` for a live one when the command named
  changes the organization (`LIVE_WRITES` in src/cli/targets.ts). A hint to a read or to `apps init`
  carries no `--live`, since none needs it (CLI pass 2, finding 8). A hint to a write carries it when
  the session is live, even when the read that printed it was run without it. An address that came from
  `SIREN_BASE_URL` or the default adds nothing, since the next command reads it the same way.
  `commandLine` in src/cli/targets.ts builds every such hint, `apps init` included. Before, `apply
  --live` printed `Run siren apps rotate <key> ...`, which a live Siren refuses without `--live`
  (e2e step 20g). test/cli-hints.test.ts runs each path that prints a hint against a live Siren
  and checks every `siren` command it printed.
- `logout` reads the edition too. On a mismatch it sends the tokens nowhere and forgets the
  session on this machine, since the tokens were made for another Siren. When the edition cannot
  be read, it forgets the session anyway, as it does when Siren refuses the sign-out.
- test/cli-edition-check.test.ts covers a stored sandbox session against a live target, a stored
  live session against a sandbox, every command that sends anything, and the built command against
  a fake Cloud on 127.0.0.1 whose edition changes between two commands.

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
      "features": {
        "notify-crm": { "kind": "postConversionAction", "name": "Tell the CRM" },
        "acme-ledger": { "kind": "payoutMethod", "name": "Acme ledger", "currencies": ["USD"], "answerWindowMinutes": 1 },
        "acme-split": { "kind": "distributionResolver", "name": "Acme split", "answerWindowMinutes": 1 }
      }
    }
  }
}
```

`parseAppFile(text, env)` answers the file or every problem, each with its dotted path, line and
column. `apply` prints them as `siren.app.json:9:7: apps.acme-payouts.url needs ...`, the path
once, and sends nothing.

- A file that still says `items` is refused at that key with `Siren calls an app's features
  "features" now. Write them under features.`, so an old file never declares an app with none
  (Alex's ruling M104, contract/feature-rename.md in the run folder).
- A kind's readable name, as in `Attribution model (incentiveResolver)`, comes from
  src/cli/app-kinds.json, Siren's docs/api/app-kinds.json copied byte for byte. Siren writes that
  file from its kind registry, and test/cli-app-kinds.test.ts holds the copy to Siren's when
  SIREN_CHECKOUT names a Siren checkout. No name is typed by hand in the tool.
- `version` is 1. `name` and `description` at the top are optional text since CLI pass 1 (finding
  5). The tool never sends them, and Siren's recipe schema (lib/Recipes/Core/recipe.schema.json on
  feat/apps at 6d2abd936a) has no `apps` stanza to read them with yet. The dashboard shows the
  app's own name. `$schema` is allowed and ignored. `apps init` writes it as
  `https://unpkg.com/@novatorius/siren@<version>/siren.app.schema.json`, which resolves from any
  folder with a global install, a local one or npx (pass 1 re-check). The help text calls the hook
  "Siren's logo animation", since a newcomer reads "hook" as a webhook.
- siren.app.schema.json ships in the package. `appFileSchema()` in src/cli/app-file-schema.ts
  builds it from the lists and limits the checks use (`TOP_FIELDS`, `APP_FIELDS`, `ITEM_FIELDS`,
  `KINDS`, `CONVERSION_TYPES` and the rest), and test/cli-app-file-schema.test.ts holds the file to
  that output and runs good and bad files through both. The schema checks shape. The tool alone
  checks the url's scheme after filling, each contact's address and their count, and each domain's
  grammar.
- Any other recipe stanza, such as `programs`, is refused by name. Recipes made of apps and
  programs wait for slice 12. Any other key is refused as not a recipe key.
- `apps` holds exactly one app, keyed by its app key. A file with more hears that a folder holds
  one app, since the env file beside it keeps one app's key. The map stays because a Siren recipe
  maps each key to its record, so the CLI and the dashboard can share the file. CLI pass 2,
  finding 4 asked for a flat file instead, and was declined for that reason. `apps init` and
  `apps pull` write a top `description` that calls the file a recipe and names `siren apps apply`,
  and the schema's text for `apps` says why it is a map.
- An app takes `name`, `description`, `url`, `scopes`, `events`, `contacts` and `features`, and
  nothing else. Its key is never `requests`, `events`, `scopes` or `kinds`, which Siren keeps for its own routes.
  `url` is optional, and an app with none is a key-only app (slice C6). When given, it starts with
  `https://`, or with `http://` for `localhost`, `127.0.0.1` or `host.docker.internal`, which only a
  local Cloud reaches (AP-A616).
- `features` holds the app's features, at most 50 (`AppService::MAX_ITEMS`), an object keyed by
  feature key, so a key is unique within the
  app. A feature takes `kind`, `name`, `description`, `currencies` and `answerWindowMinutes`.
  `currencies` is required for a `payoutMethod` and refused for any other kind. The old word
  `fulfillmentMethod` is refused with a message that names `payoutMethod`. `answerWindowMinutes`
  runs from 1 to 43200. A file with features and no `url` is refused before anything is sent, since
  Siren asks a feature at the app's address. A feature's kind and key lock once Siren makes it:
  Siren matches the file's features to its own by kind and key, so a renamed key is a new feature,
  and the old one is archived while a record selects it and deleted otherwise.
- `${NAME}` is filled only in the app's `url`, and only from a variable whose name starts with
  `SIREN_APP_` (AP-A633): from the shell, else from `.env` beside the app file, read for
  `SIREN_APP_` lines alone. `apply` says `Its url came from SIREN_APP_URL in .env.` for the second. A placeholder anywhere else, any other name, or a name
  that is not set is a problem at that key, naming the place and never a value. `parseAppFile`
  answers the names it filled in `filled`, and `apply` prints those names, never the values, and
  never writes them back to the file.
- A key written twice is a problem at the second one. A JSON mistake gives the line and column of
  the character the reader stopped at, or of the string that holds a raw line break. The reader is
  a small one in app-file.ts that tracks positions, since `JSON.parse` gives neither. It has its own
  tests: it reads what `JSON.parse` reads, and refuses a trailing comma, single quotes, a comment,
  `NaN`, text after the object and a raw line break, each at its place.

`declarationFor(file)` turns the one app into what `PUT /apps/{key}` takes: the same fields, a
field the file leaves out left out, `url` included, and `items` as a list in the file's order, each
with its `key`.

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
- An ask whose data lacks what the answer needs, such as a pool with no metrics or a payout with no
  `payoutId`, gets 500 and a logged line that says why, and no guessed answer. Siren sends it again
  on its deadline, then marks it `needs_attention`. `createRequestListener` gives server.mjs a
  listener that answers 500 for anything the handler throws and keeps serving (AP-A905).

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
- Both ask features, `acme-ledger` and `acme-split`, declare `answerWindowMinutes: 1`, the shortest
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

The build is `"prepare": "tsup"`, and it stays. npm builds a git dependency by running `prepare` in
the clone, never `prepack`, and Siren's Node connector installs this SDK as
`git+https://github.com/Novatorius/siren-node.git#<commit>`. Without `prepare` that install has no
dist and the package cannot be required. npm 11 lists `prepare` as an install script and warns
about it on `npm i -g` of the tarball and on the example's `file:` install (e2e step 03), though it
does not run it there. The warning is harmless. test/cli-build.test.ts fails when `prepare` no longer
runs the build, and the checkpoint script below installs the SDK as a git dependency.

## Tests and proof

109 acceptance tests in seven files, 17 more than round 1, and every one is on. Each describe's
name starts with `apps-cli`.

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

### The run on the built branch

The finished branch holds every packet's code, so each packet's implementer rewrote the `find` texts
of its own guards. Four were still stale at the end and were rewritten: the three example mutations
written against the scratch handler, and `docs-drop-by-key`, whose sentence the README wraps. Two
more prove the example's own unit tests: `example-inflight-twice` (a repeat that arrives while the
first answer is on its way) and `example-sale-unattributed` (a visit with no opportunity). The list
holds 179 mutations.

Run offline under the heavy lock, the first pass scored 178 of 179. `docs-changelog-sandbox`
survived, because the CHANGELOG named `SANDBOX_BASE_URL` twice in one bullet, so removing one left
the other for the test to find. The bullet now names it once, and a rerun of that mutation with the
four controls scored 5 of 5:

```
OK   control-break: caught (expected caught)
OK   control-harmless: survives (expected survives)
OK   control-malformed: refused (expected refused)
OK   control-wrong-reason: wrong-reason (expected wrong-reason)
OK   docs-changelog-sandbox: caught (expected caught)
```

## The founder's walk

Steps 1 to 6, 8 and 15 run today on Siren's `feat/apps` at 1557b0030, given a sandbox Cloud with
sign-up on. The other steps wait on Siren slices that are not on `feat/apps` yet:

| Step | Waits on |
| --- | --- |
| 7 | Slice 3 for "Acme: Tell the CRM", slice 4 for the resolver, and slice 11 for the distributor's resolver picker |
| 9 | Slice 3, since Siren sends a tell only after a program picks the action |
| 10, 12, 13 and 14 | Slice 4, or slice 5, since only those make an ask |
| 11 | Slice 5 |

This is design section 10's walk, rewritten so every step runs as written (ruling M1). It runs
against the sandbox edition of Siren Cloud, where the plan puts a developer's testing (AP-A13) and
where the tool goes by default (AP-A648). The address is the founder's UAT preview when it is a
sandbox, given once as `export SIREN_BASE_URL=https://<preview>/siren/v1`, or the public sandbox
when nothing is set. If the preview turns out to be a production edition, `siren signup` says it is
live, and the same steps run with `--live` added to every `siren` command, writing `.env.live` in
place of `.env.sandbox`.

It needs Node 18.3 or later, a checkout of the siren-node pull request's branch, and `cloudflared`.

| # | The person runs | The person sees | Made true by |
| --- | --- | --- | --- |
| 1 | `npm i -g ./novatorius-siren-0.3.0.tgz`, the tarball attached to the siren-node pull request, then `siren --version` | `0.3.0` | cli-session (bin and build tests) |
| 2 | `siren signup`, answering the prompts: organization name, email, the terms, and the password at a hidden prompt | `Made <org> (<slug>) on <address>, and signed in as <email>.` On a live edition: `<address> is a live Siren. Add --live to sign up on a live Siren.` With sign-up off: `Sign-up is turned off on <address>. Ask its owner, or use siren login.` | cli-session |
| 3 | In the checkout: `npm ci && npm run build`, then `cd examples/apps/acme && npm install` | npm's usual output | example-app |
| 4 | In a second terminal: `cloudflared tunnel --url http://localhost:8787`. Back in the first: `export SIREN_APP_URL=<the https address it printed>` | A `https://<words>.trycloudflare.com` address | none, cloudflared |
| 5 | `siren apps apply` | The plan, then `✓ Made acme-payouts in <org>` with a `Key` row (`sk_test_<8 hex>… in .env.sandbox, with its signing secret`), one row per feature with its `app:{id}`, `URL from  SIREN_APP_URL`, and two numbered next steps. No key, secret or url is printed. | cli-app-file, cli-apply, sdk-apps |
| 6 | `npm start` | `Acme example app on http://localhost:8787, for <address> (<folder>/.env.sandbox).` | example-app |
| 7 | In the dashboard, signed in with the same email and password: make a program with a sale reward, pick "Acme: Tell the CRM" among its post-conversion actions and "Acme: Acme split" as its distributor's resolver, and add a collaborator with a tracking code. Open Webhooks. | The three Acme features in the pickers, and the app's subscription marked as managed by the app | Siren slices 1, 3 (claim C3), 4 and 11, not this slice |
| 8 | `npm run send-sale -- tracking:<code> 49` | `Sent a sale of 49 USD through <folder>/.env.sandbox: Siren made 1 conversion on opportunity <id>.` A sale no program pays for prints `Siren recorded it on opportunity <id> and made no conversion (no_program).` and Siren's message, which is what step 7 skipped gives (capture events-sale-200-no-program). | example-app |
| 9 | Approve the conversion in the dashboard. Then `siren apps requests --follow`, and in another terminal `siren apps requests <id>` for the tell | The tell's line going from `sent` to `delivered`. The single request shows the send, `HTTP 200`, the app's answer and the body Siren sent. Ctrl-C ends `--follow` with exit 130. | cli-requests, Siren slices 2 and 3 |
| 10 | Close the program's distribution with slice 4's test route (claim C7) | `--follow` shows the ask `sent`, then `answered`, then `applied`. The server logs the answer, and the distribution completes with the app's shares. | example-app, sdk-verify, sdk-answer, Siren slice 4 |
| 11 | With slice 5 only: pick "Acme: Acme ledger" on an autofulfiller and run a payout through it | The payout waits, then shows as paid with reference `acme-<payoutId>` | example-app, Siren slice 5 |
| 12 | Stop the server with Ctrl-C, close another distribution as in step 10, and run `siren apps requests --attention --follow` | Nothing at first. About three minutes later, after three one-minute windows, the ask's line with `needs_attention` and its send error. The Apps screen marks it too. Each window's end is a wake on Siren's task queue, so this needs a Siren whose worker runs: the public sandbox, or a Siren you run with `SIREN_DURABLE_TASKS` on (README, "Running against your own Siren Cloud"). With it off, the ask is sent once, its job fails at the first wake, and it never needs attention. | cli-requests, the shortest window in the example's app file, Siren slices 2 and 3 |
| 13 | `npm start` again, then `siren apps resend <id>` | `✓ Sent <short id> again` with its state back at waiting, then `--follow` shows `answered` and `applied` | cli-requests |
| 14 | Or, with the server still stopped and the ask still shown by `siren apps requests --attention` after step 12, read the metric ids with `siren apps requests <id>` and run `siren apps answer <id> --body '{"outcome":"resolved","shares":[{"id":"<metric id>","amount":<minor units>}]}'` | `✓ Answered <short id>` with the answer. Sending it again prints `Siren already had this answer for <short id>. Nothing changed.` A person may answer only a request that needs attention, so the same answer to an ask still `pending` or `sent` is refused with Siren's line and `See the requests that need attention with siren apps requests --attention.` | cli-requests, sdk-answer |
| 15 | `siren logout` | `Logged out of <host>.` | cli-session |

Without a tunnel, step 4 sets `SIREN_APP_URL` to any https address, deliveries fail, and steps 9 to
12 end in `needs_attention`, which step 14 answers by hand (AP-A216).

## The end-to-end checkpoint

A later lane runs this against a local sandbox Cloud. Nothing here ran it.

1. Run `df -h /` and stop below 10 GB. In a Siren worktree of feat/apps with slices 1, 2 and 7
   merged, build the sandbox image. `saas/Dockerfile` needs a GitHub token in `COMPOSER_AUTH`.
   Without one, fill the vendor folder with `composer install` and build the UAT image, which copies
   it: `docker build -f uat/saas/Dockerfile --build-arg SIREN_EDITION=sandbox --build-arg SIREN_SAAS_SIGNUP_ENABLED=true -t siren-sandbox:apps-e2e .`
   The slice 8 checkpoint built it this way.
2. Write an override beside uat/sandbox/docker-compose.yml that sets, on `app`,
   `SIREN_SAAS_SIGNUP_ENABLED: "true"`, `SIREN_DURABLE_TASKS: "true"`,
   `SIREN_OUTBOUND_DEV_ALLOW_HOSTS: host.docker.internal`,
   `extra_hosts: ["host.docker.internal:host-gateway"]`, and, for the UAT image,
   `command: /usr/local/bin/startup.sh`, so it starts as Siren does and seeds no UAT organization.
   The sandbox file sets `SIREN_DURABLE_TASKS` to `"false"`, and with it off no worker starts and an
   ask's job fails at its first wake, so step 8 never sees a second send or `needs_attention`. The
   README's "Running against your own Siren Cloud" says why each setting matters. Start it as its
   own project:
   `SIREN_SANDBOX_IMAGE=siren-sandbox:apps-e2e SIREN_SANDBOX_PORT=33918 docker compose -p apps-e2e-cloud -f uat/sandbox/docker-compose.yml -f <override> up -d`.
   Check `curl -s localhost:33918/siren/v1/auth/signup-options` names `"edition":"sandbox"`.
3. In this repository: `npm ci && npm run build && npm pack`, then install the tarball in an empty
   folder and check `npx @novatorius/siren --version` prints 0.3.0.
4. `export SIREN_BASE_URL=http://localhost:33918/siren/v1 SIREN_CONFIG_DIR=$(mktemp -d)`.
5. `printf '%s' "$PASSWORD" | npx @novatorius/siren signup --org-name "Apps E2E" --email apps-e2e+$(date +%s)@example.invalid --password-stdin --accept-terms`.
   Check credentials.json is mode 0600 and holds no password. Then, by hand in a real terminal, run
   `npx @novatorius/siren login` with no flags and check the password prompt echoes nothing, and that Ctrl-C
   at it ends the command and leaves the terminal echoing again.
6. In examples/apps/acme of this checkout: `SIREN_APP_URL=http://host.docker.internal:8787 npx @novatorius/siren apps apply`.
   Check .env.sandbox holds an `sk_test_` key, and that no key, secret or url was printed.
7. `npm install && npm start`, then `npm run send-sale -- tracking:<code> 49` for a collaborator
   made in the sandbox dashboard, and run the walk above from step 7.
8. `npx @novatorius/siren apps requests --follow` shows the ask go from `sent` to `answered` to `applied`.
   `npx @novatorius/siren apps requests <id>` shows the send, the 200 and the body.
9. `npx @novatorius/siren apps answer <id> --body '{"outcome":"paid","reference":"acme-88"}'` says Siren already
   had it. A different answer gets 409 `app_request_already_answered`.
10. `npx @novatorius/siren apps rotate-secret acme-payouts --yes`, restart the server, and resend a request. The new secret
    verifies.
11. Capture every answer the steps saw (S1) and replace the hand-written fakes in
    test/sdk-gaps-fakes.ts, test/cli-fakes.ts and test/apps-siren-answers.ts where they differ.
12. Install the SDK as a git dependency, as Siren's Node connector does: in an empty folder with a
    bare package.json, `npm install --offline 'git+file://<this checkout>#<commit>'`, then check
    `node_modules/@novatorius/siren/dist` holds the build and `node -e "require('@novatorius/siren')"`
    works. On 953f355 it took 20 seconds with a warm npm cache and built 34 files, too slow for the
    suite, so test/cli-build.test.ts checks package.json in its place.
13. `docker compose -p apps-e2e-cloud down -v` and remove the image.

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
2. Siren lets one app hold two features with the same key under two kinds. The file keys features by key,
   so a key is unique within an app, which keeps `app:<appKey>/<itemKey>` unambiguous. A file cannot
   declare the same key twice under two kinds.
3. Siren had no `GET /apps/requests/{id}` at 1557b0030 (capture apps-request-one-404-no-route).
   It has `GET /apps/requests/{requestKey}` on feat/apps at 27169452a, and
   `siren.apps.requests.retrieve(id)` reads it, so `siren apps requests <id>` shows any request
   however old ("Follow-ups after the merge", section 7).
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
| S3, the key issued once | Taken. The no-key line on `apply`, `envFiles`, `rotate --app-file`, and the line when another Siren's key is replaced (AP-A634 to AP-A636), now a refusal before sending (AP-A906). |
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

## The review's items

The review of the built slice (the run folder's review/cli-review.md) read it against Siren's
`feat/apps` at 1557b0030. Each finding, taken or declined, with its reason.

| Finding | Taken or declined |
| --- | --- |
| 1, the env file written in place | Taken. A new 0600 file and a rename, a link or other path refused, and a failed write leaves the old file whole (AP-A896). |
| 2, the resend contract | Taken. The docblock, the error comment, the error table, the README, openapi and the fake follow ResendAppRequest.php at 1557b0030, and a docs test holds them (AP-A897). |
| 3, no secret in an error | Taken. test/cli-secrets.test.ts fails when the redaction, the scrub or the transport's redaction is removed (AP-A898). |
| 4, the password before the credentials file | Taken. `signup` and `login` read the file first (AP-A899). |
| 5, another Siren's key | Taken. A later `apply` stops before sending (AP-A900). |
| 6, the README's handler | Taken. The snippet hands each request to the example's tested handler and passes a failure to `next` (AP-A901). |
| 7, the fakes | Taken where no assertion changes. The resend, in-use and item fakes follow Siren, and the wrong password's fake and its assertion use Login.php's NO_MATCH, which the review names. The different answer's message stays short, since an assertion pins it (AP-A902). |
| 8, the walk | Taken. The walk names the steps that run today, the slices the others wait on, slice 11 among them, and npm's tarball name. |
| 9, the CHANGELOG's four exports | Taken. One bullet each. |
| 10, Node 18.3 | Taken. `engines` says `>=18.3`, since `parseArgs` arrived in 18.3. |
| 11, the example's base url | Declined. Apply writes only a checked address, and the SDK's own `baseUrl` rule is the one every client follows. |
| 12, a coded 401 refreshed | Declined. That is the repository's 401 rule, and a resend after a 401 applies nothing. |
| 13, Pending comments and the typo | Taken. |
| 13, .gitignore on apply | Declined. `apps init` adds `.env.*`, and a hand-written app file is the developer's own repository. |
| 13, the config folder's mode | Declined. The file is 0600, and the folder is one the person chose. |
| 13, control characters in `apps requests <id>` | Declined for now. The app's own answer is shown as Siren stored it, and a later slice can escape it. |
| After the review, the example server | Taken. An ask the example cannot answer gets 500 and a logged reason, and the server's listener survives a handler that throws (AP-A905). |
| After the review, an env path that is a folder | Taken by ruling. `apply` and `rotate` refuse before sending an env path they cannot write as a regular file, and a later failure names the lost pair and `siren apps rotate` without printing it (AP-A904). |
| Re-review, the temp file's name | Taken. `.env.sandbox.<hex>.tmp`, which `.env.*` covers, so a crash before the rename leaves nothing git would stage (AP-A906). |
| Re-review, rotate over another Siren's key | Taken by ruling. `rotate` stops before sending, as `apply` does (AP-A906). |
| Re-review, a failed rotate | Taken. The message says the old key in the file is revoked. |
| Re-review, the example's Node | Taken. Its package.json asks for Node 18.3, as the SDK does. |
| 13, the example logs a tell's data | Declined. The example is a demonstration on a sandbox, and its comment says a real app keeps its own store. |

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

## Follow-ups after the merge (pkt/apps-sdk-followups-1)

A fix lane made these changes after the slice merged, each with a test that failed first on
`feat/apps` at 934169a and a mutation in scripts/mutations/apps-sdk-followups-1.json. Siren was
read on `feat/apps` at 27169452a.

### 1. The amount in a tell

Both tells now carry the reward's currency beside its value (AppActionSubjects.php lines 34 to 41,
128 to 137 and 179 to 190). `reward` on an approved conversion is `{ value, units, currency }` or
null, and `allocation` on a completed allocation gains `currency`. `currency` is
`CurrencyAdapter::toArray()`: `id`, `symbol`, `position`, `name`, `scale`, `decimalPlaces` and
`type`. `value` is the stored integer and the shown amount is `value / 10^scale`, so 10000 in yen,
which Siren stores at scale 2 and shows with 0 decimal places, is ¥100.

| Call or type | What it is | File |
| --- | --- | --- |
| `siren.apps.shownAmount(value, currency)` | Answers `{ amount, decimal, text }`. Sends nothing. | src/resources/apps.ts, src/resources/app-amounts.ts |
| `AppCurrency` | The currency a tell carries, every field present. It extends `ProgramCurrency`, the same shape `programs.currencyTypes()` lists. | src/record-types.ts |
| `PostConversionActionTell`, `PostAllocationActionTell` | The data of the two tells. | src/record-types.ts |
| `ShownAmount` | What `shownAmount` answers. | src/record-types.ts |

`shownAmount` copies Siren's `CurrencyAmountService` (lib/Commerce/Services/CurrencyAmountService.php):
`amount` is `toFloat()`, `decimal` is `toDecimalString()`, and `text` is `format()` with `.` and
`,`, rounding halves up to `decimalPlaces` with integer arithmetic. It refuses a `value` that is
not a safe integer, a currency that is not an object, a `scale` outside 0 to 8
(`Currency::MAX_SCALE`) and `decimalPlaces` outside 0 to the scale, which `Currency`'s constructor
also refuses. `AppRequest.data` stays `Record<string, unknown>`, since its fields belong to the
feature's kind, and a caller narrows it by `feature.kind`. openapi.yaml documents the routes the SDK
calls, and a tell is a request Siren sends the app, so it gains no schema.

The example's handler logs each tell through `describeTell()`, which reads the amount with
`shownAmount` and logs the data as it came for a kind it does not know or a tell with no currency.
The asks the example answers carry a currency code, not a currency, and its pool split works in
stored units, which needs no scale. The tell fakes are `AppTells` and `AppCurrencies` in
test/apps-siren-answers.ts, each citing its Siren file and line, and the tell in
test/apps-verify-request.test.ts now has Siren's shape.

### 2. The edition during a follow run

A reviewer flipped a fake target from sandbox to live during `siren apps requests --follow`, and
the sandbox session was still sent four times in six seconds, because `CommandContext` kept the
edition it read at the start for the whole run. `appsRequests` now calls
`CommandContext.recheckEdition()` before each poll after the first. It reads
`GET /auth/signup-options` again and runs `assertSessionMatches` on the answer. `signedIn()`
already held `--live` to the session's edition, so any change of edition fails that check first.
So the run stops with exit code 1 and the line `signedIn()` gives, before the next
`GET /apps/requests`. The cost is one GET with no credential, a few dozen bytes, every 2 seconds
while following. The test that pinned one edition read per follow run now pins one read per poll.
test/cli-edition-check.test.ts covers both directions with the harness, and the built command
against the loopback Cloud flipped mid-run, where the old code kept polling until the test's
20-second limit killed it.

### 3. An edition read that hangs

The edition read went through the session client's ordinary read: a 30-second timeout and two
retries, so a target that took the connection and never answered held every command for 92
seconds (30 + 0.5 + 30 + 1 + 30) before the transport's line. `SessionAuthClient.edition()` now
sends with `EDITION_TIMEOUT_MS`, 3 seconds, and `EDITION_RETRIES`, 1, which gives up after 6.5
seconds. `CommandContext` turns the `ConnectionError` into one line: the address did not answer
when the tool asked which edition it is, so nothing was sent, and to check the address or try
again in a minute. The other session calls keep the 30-second timeout, since a sign-in waits on
Siren's password hashing and a refresh must not be cut short. test/cli-edition-check.test.ts pins
the timeout and the line with the harness, and runs the built command against the loopback Cloud
with its edition route hanging, where the old code ran into the test's 20-second limit.

### 5. Siren's messages, word for word

Siren's merged exchange words some refusals differently from the commits this slice first read.
The answer route's 404 now tells an admin "This organization has no request with this key." and
an app's key "No request with this key was sent to this app." with the same status and code. The
409 for a different answer reads "This request already has a different answer, and the first
answer stands." test/apps-siren-quotes.test.ts holds every message of the exchange this
repository quotes, each with its Siren file and line at 27169452a. It checks each fake against
the quoted text everywhere, and with `SIREN_CHECKOUT` set it reads each line from Siren with
`git show`. The fake for a different answer had cut Siren's message short to fit an assertion,
and both now carry Siren's whole sentence. The captures in test/fixtures/cloud-captures stay as
recorded at 1557b0030, so apps-answer-404-admin keeps the older wording, and its note says so.

### 6. An archived item

When a declaration leaves out an item a record still selects, Siren keeps the item with
`"status": "archived"`, never calls it, and deletes it once nothing selects it. Naming its kind
and key again makes the same row active, so its `app:{id}` stays (lib/Apps/Core/Models/AppItem.php
and AppService::redeclareItems() at 27169452a). The second Cloud run found that `apply` and
`show` printed such an item like any other (capture apps-declare-200-dropped-selected-item, step
22i). `appLines()` now adds "archived, so Siren no longer calls it" beside it, which `apply`,
`list` and `show` share. `apply` then says once what archiving means and that naming the item in
the file again, then running `apply`, brings it back. That hint carries the target flags and the
file as it was typed.

### 7. Reading one request

Siren's feat/apps at 27169452a answers `GET /apps/requests/{requestKey}` for an admin with
AppRequestSerializer::toDetail(): the list's fields plus `data` (`{}` when empty), `answer` or
null, and `answeredByUser`, `{ id, email }` or null (GetAppRequest.php, AppRequestSerializer.php
lines 87 to 97). An API key gets 401 `api_key_not_accepted`, and a request the organization does
not have gets 404 `app_request_not_found` with "App request not found." (captures
apps-request-one-200-needs-attention and apps-request-one-404 from the second run).

`siren.apps.requests.retrieve(id)` reads it through `readObject`, so it retries as a read. It
refuses a bad id with `SirenError` before sending, and raises `UnexpectedResponseError` for a 2xx
body whose `id` is another request's, whose `data` is not an object, or whose `answer` or
`answeredByUser` has the wrong shape. Its answer is `AppRequestDetail`.

`siren apps requests <id>` used to look for the request among the latest 50 and refuse an older
one with "not among the latest 50". It now reads the request by its id and prints its line, the
data Siren sent, and the answer with who gave it, then the sends from the app's webhook
deliveries as before. The data comes from the request, not from the last delivery's payload, so it
shows even when the deliveries have moved past it. The test that pinned the list read now pins the
one-request read.

### 8. How many requests need attention

Every app Siren answers now carries `needsAttention`, how many of its requests need a person, from
AppAttention::count() (AppSerializer.php line 57 at 27169452a, captures apps-list-200-count-1 and
apps-retrieve-200-with-count). The `App` type, the `appRecord` fake and openapi's `App` schema
carry it. The fakes held against the captures taken at 1557b0030 leave it out, since Siren did
not send it then. `siren apps list` and `siren apps show` print, under an app whose count is above
0, "1 request needs attention. See it with siren apps requests --app <key> --attention." or the
plural, with the target flags. A count of 0 prints nothing. The hint names `--app` beside
`--attention` so the list holds only that app's requests.

### 9. Three hints that sent a person the wrong way

The second Cloud run found three hints that named the wrong fix.

- A delete that records still hold said "Turn it off instead" even for an app already off (step
  22d, capture apps-delete-409-in-use). After that 409, `siren apps delete` reads the app with
  `GET /apps/{key}`. An app that is on gets the turn-off hint as before. One that is off is told
  that Siren no longer calls it and that the records selecting its items must change before
  `siren apps delete <key> --yes` can work. When the read fails, the line names both ways.
- A resend Siren refused because the app is off printed Siren's "it is applied, or its app is off"
  and nothing more (step 13a, capture apps-resend-409-app-off, whose `context.status` is the
  request's own, `needs_attention`). `siren apps resend` now says an `applied` request has
  nothing to send. For any other status it reads the request and the apps to name the app, and
  says to turn it on with `siren apps on <key>`, then to resend.
- The uncoded 401 on the answer route kept Siren's "Copy the key from Siren again, or make a new
  one under API keys" (step 24a). An org key made there gets 404 on the answer route, so that
  advice cannot work for an app. `requests.answer()` now gives that 401 a message that names
  `siren apps rotate <app key>`, and keeps Siren's error as `cause`. The SDK holds no target, so
  that message carries no flags. The command's own answer with an admin's session already ends in
  "Your session has ended. Run siren login to sign in again." with the target flags, and a test
  now pins that.

Every hint above that names a command carries the target flags (test/cli-hints.test.ts).
