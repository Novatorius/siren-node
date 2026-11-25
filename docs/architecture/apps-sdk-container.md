# Siren apps: the app as a container

This note covers the apps-sdk-container slice of the Siren apps work, slice
C6 of Siren's `docs/architecture/apps-own-parts.md`. On Siren an app now owns
its parts: an API key, an address that receives events and requests, and its
features. Either part may be missing. A key-only app has no address, and an
app may lose its key and keep its address. The slice moves the Node SDK, the
`siren` command-line tool and the example app to that shape. It follows the
[apps-cli](apps-cli.md) and [apps-sdk-gaps](apps-sdk-gaps.md) notes and does
not restate them.

Read from: Siren's `int/preview-apps` at `a22547327` (`lib/Apps`,
`AppService`, `AppItemKinds`, `AppItemKindCatalog`,
`CurrencyAmountService` at `2d104f289`, and the tests
`AppsOwnPartsFlowTest.php` and `AppsOutIsProFlowTest.php`).

## What changes

| Call | Siren route | Where |
|---|---|---|
| `apps.create(params)` | `POST /apps` | `src/resources/apps.ts` |
| `apps.update(key, params)` | `PATCH /apps/{key}` | `src/resources/apps.ts` |
| `apps.createKey(key, {scopes})` | `POST /apps/{key}/key` | `src/resources/apps.ts` |
| `apps.rotateKey(key)` | `POST /apps/{key}/key/rotate` | `src/resources/apps.ts` |
| `apps.revokeKey(key)` | `DELETE /apps/{key}/key` | `src/resources/apps.ts` |
| `apps.rotateSecret(key)` | `POST /apps/{key}/secret/rotate` | `src/resources/apps.ts` |
| `apps.test(key)` | `POST /apps/{key}/test` | `src/resources/apps.ts` |
| `apps.deliveries(key)` | `GET /apps/{key}/deliveries` | `src/resources/apps.ts` |
| `apps.events()`, `apps.scopes()`, `apps.kinds()` | `GET /apps/events`, `/apps/scopes`, `/apps/kinds` | `src/resources/apps.ts` |
| `apps.features.create`, `retrieve`, `update`, `delete` | `/apps/{app}/features` and `/apps/{app}/features/{id}` | `src/resources/apps.ts` |

`apps.declare()` still sends the whole app with `PUT /apps/{key}`. Its `url`
is optional now. It answers `created: true` with `rawKey` when Siren made
the key, and `signingSecret` whenever Siren made an address, so a later
declaration that adds a url hands back the new secret with
`created: false`. It refuses features with no url, the old kind name and a
reserved key before sending.

An `App` carries `source`, `apiKey`, `address` and `eventsAccess`. Each
feature carries `entitled`, `requiredCapability` and `requiredPlan`.
`webhookSubscriptionId` and `apiKeyId` stay on the type as optional and
deprecated, since Siren no longer sends them.

`AppSource` and `AppFeaturesResource` are new exports. No export was removed.
`apps.rotate()`, which called Siren's removed `POST /apps/{key}/rotate`,
is gone. It was never released, and `RotatedApp` stays as a deprecated type.

## The old key and webhook calls

Slice C5 removed `/api-keys` and `POST /webhooks` from Siren, so
`siren.apiKeys` and `siren.webhooks.subscriptions.create()` are gone, and
openapi.yaml drops their operations. Every other method on
`siren.webhooks.subscriptions` carries an `@deprecated` line naming the app
call that replaces it. `webhooks.constructEvent()` and
`webhooks.verifySignature()` stay as they are, because an app's address
receives events signed the same way. openapi.yaml marks each remaining
`/webhooks` operation `deprecated: true`, with a first description line naming
the app route that replaces it.

A malformed answer to a call that made a secret throws
`UnexpectedResponseError` with the body as `data`, less `rawKey` and
`signingSecret`, so a caller that logs the error never logs a secret.

## The app file

A `url` is optional, so a file may declare a key-only app. A file with
features and no `url` is refused at `apps.X.features`, since Siren sends a
feature its requests at the app's address. The payout kind is
`payoutMethod`. The file refuses `fulfillmentMethod` and names the new
word. App keys never take `requests`, `events`, `scopes` or `kinds`, which
Siren keeps for its own routes, and every command that takes an app key
refuses them in the tool's own words.

## Kind names

Wherever a person reads a feature's kind, the tool prints its readable name
beside the term, as Payout method (payoutMethod): `show`, `list`, apply's
changes, the request lines and the app file's messages. The README's feature
table does the same. The names are `name` in Siren's
`AppItemKindCatalog::entries()` (lines 189, 199, 209 and 228 on feat/apps at
`c8dbb1ab3`), held in `src/cli/app-kinds.ts` and pinned to Siren's by a test,
since those commands read no catalog. A kind the copy lacks prints its term
alone.

## Apply shows what it will change

`siren apps apply` reads the app with `GET /apps/{key}` first and compares
it with the file the way Siren does when it applies a declaration: names
trimmed, a description as written, events and scopes as sets, currencies
upper-cased in order, and a feature matched by its kind and key
(`src/cli/app-changes.ts`). Scopes are first reduced as Siren stores them:
each once, and with `*` present, `*` and the record scopes only
(`ApiKeyService::normalizeScopes()`, lib/ApiKeys/Service/Services/ApiKeyService.php
line 51, applied by lib/Apps/Service/Services/AppService.php line 1764, both
on feat/apps at `c8dbb1ab3`). So a file that names `*` beside `event:*`
matches on the next run. It prints a header that says what applying the
file changes, then each change marked `+`, `~` or `-`, then asks
"Apply to <org> (<slug>), sandbox? [y/N]". `--yes` skips the question. With no terminal and no
`--yes` it sends nothing. With nothing to change it says so and writes
nothing.

A feature the file leaves out is read with `apps.features.retrieve()`, so the
line says whether records still select it and Siren archives it, or nothing
does and Siren deletes it. The question says the last write wins. A
difference may be a change someone made in the dashboard, and the tool
cannot tell that from an edit to the file, so neither the header nor the
lines say who made it.

When the file names scopes and the app holds no key, apply warns that the
scopes reach nothing and names `siren apps add-key`. When this machine's env
file holds no key, apply names `add-key` for an app that holds none and
`rotate-key` for one that holds a key, never both, since Siren refuses to
rotate a key the app lacks (409 `app_key_missing`).

## The commands

| Command | Does |
|---|---|
| `siren apps rotate-key <key>` | Asks, rotates the key, writes only `SIREN_API_KEY` |
| `siren apps rotate-secret <key>` | Asks, rotates the signing secret, writes only `SIREN_SIGNING_SECRET` |
| `siren apps add-key <key>` | Makes a key with no scopes for an app that holds none |
| `siren apps rotate [<key>]` | Sends nothing, explains the split and exits non-zero, with or without a key |

Apply saves only the secrets Siren sent, so a key-only app gets no empty
signing secret line. `rotate-key`, `rotate-secret` and `add-key` turn
Siren's 409 for a missing key, a missing address or an existing key into the
one command that fits. Apply and the three key commands refuse, before they
send, an env file that holds one of the tool's three names on more than one
line, and name the lines, so a rotation never leaves the revoked key on a
line a loader reads.

## Plans in the output

`show`, `list` and apply print `requires Pro` beside a feature Siren marks
`entitled: false`, using the plan Siren names in `requiredPlan`. When Siren
names no plan the line says the plan cannot use it, and it never guesses.
The events line reads the same mark from `eventsAccess` and adds that Siren
does not send them. An older Siren that sends no `entitled` gets no mark.

## Feature, never item

Everything a person reads says feature. The code keeps Siren's word,
`items`, in field names and types.

## The amount edge

`ShownAmount.decimal` takes its sign from the stored value, as Siren's
`CurrencyAmountService::format()` does for `text`. Siren's
`toDecimalString()` drops the sign when the shown value is 0, so for a
negative amount that rounds to zero the two Siren functions disagree. The
SDK keeps `decimal` and `text` in step with `format()`.

## Tests and proof

| File | Covers |
|---|---|
| `test/apps-container.test.ts` | Items 1 and 6: the calls, the answers and the plan fields |
| `test/apps-container-deprecations.test.ts` | Item 2 |
| `test/cli-app-file-container.test.ts` | Item 3: the file rules |
| `test/cli-apps-container.test.ts` | Items 3 to 7 in the tool |
| `test/apps-amounts.test.ts` | Item 8 |
| `test/apps-example.test.ts` | Item 9 |
| `test/cli-apps-container-review.test.ts` | The review's fixes 1 to 6 and 8 |
| `test/docs-apps-sdk-container.test.ts` | This note, the mutation list and the review's fix 7 |

The fixtures in `test/apps-siren-answers.ts` copy Siren's tests, and each
names the file and lines it copies. `test/fixtures/apps-exchange/signed-request.json`
is Siren's copy.

`scripts/mutations/apps-sdk-container.json` holds 24 breaks, at least one per
item and per review fix, and the four controls. Run it with the slice's test
files:

```sh
MUTATION_VITEST_ARGS="--maxWorkers=4 --minWorkers=1 test/apps-container.test.ts \
  test/apps-container-deprecations.test.ts test/cli-app-file-container.test.ts \
  test/cli-apps-container.test.ts test/apps-amounts.test.ts test/apps-example.test.ts \
  test/cli-apps-container-review.test.ts test/docs-apps-sdk-container.test.ts" \
  node scripts/mutation-proof.mjs scripts/mutations/apps-sdk-container.json
```

It scored 28 of 28 as expected: every break caught for the reason named, the
harmless change survived, the malformed entry was refused, and the
wrong-reason control scored wrong-reason.

## Claims closed in Siren's apps-own-parts.md

- Section 10: apply compares the file with the GET answer, stores no key a
  later declaration never returns, and names `POST /apps/{key}/key` through
  `add-key` when the file names scopes and the app holds no key.
- Section 14: `payoutMethod` in the SDK and the example,
  `signed-request.json` replaced, and the tool calls the two rotations in
  place of `/rotate`.
- Section 15: the feature plan fields, `eventsAccess` and the kinds'
  `direction` are typed and read, and show, list and apply print the plan a
  feature needs.

Left open: the optional line that says when the app last changed, from
`dateModified`. The plan marks rest on the answer Siren's
`AppsOutIsProFlowTest.php` builds, not a recorded Cloud capture.

## Where Siren overruled the brief

- Siren keeps `AppItemKinds::FulfillmentMethod` as an alias with the value
  `payoutMethod`, so the SDK keeps `FeatureKind.FulfillmentMethod` the same
  way and marks it deprecated.
- `format()` and `toDecimalString()` disagree on the sign, so the SDK
  follows `format()`.
- The 401 hint names `siren apps rotate-key` for a lost key and
  `siren apps add-key` for an app that holds none, since a 401 points at the
  key and the SDK cannot tell which case it is.

## What the PHP SDK needs

The same calls and the items resource, `payoutMethod` with the old name as a
deprecated alias, optional `url`, the new `App` fields and the feature plan
fields, `@deprecated` on the old key and webhook methods, and `decimal`
taking its sign from the stored value. Its errors should keep no secret in
their data, and any comparison of scope lists should reduce them as
`normalizeScopes()` does.
