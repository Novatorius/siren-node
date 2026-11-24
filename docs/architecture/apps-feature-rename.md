# Apps: "feature" in every public name, and kind names from Siren's registry

Alex's ruling M104 (briefs/feature-rename.md and contract/feature-rename.md in
the apps run folder) settles two things before launch. Siren calls the thing an
app adds to a picker a feature, on the wire and in every SDK. And a kind keeps
its id, while its readable name comes from Siren's registry,
`AppItemKindCatalog::catalog()`, never from a list typed by hand. Siren's side
lands on Novatorius/siren pkt/apps-feature-rename. This note says how the Node
SDK follows it. The CLI's app file and output follow it on pkt/apps-cli-dx.

## The wire

| What | Name |
|---|---|
| The envelope's feature | `feature`, holding `kind`, `key` and `id` |
| The feature routes | `/apps/{app}/features` and `/apps/{app}/features/{id}` |
| An app's features, read and declared | `features` |
| DELETE on a feature | `{ archived, feature }` |
| An app request row's feature | `feature` (`"app:12"`) |
| The error code | `app_features_need_key_and_address`, with field paths `features`, `features.{i}.{field}` and `feature` |

The handler reads `feature.kind` and `feature.key`. A body with `item` and no
`feature` is not a version 1 request, and the 400 names `feature`.
`apps.declare()` sends `features`, and `apps.create()` and `apps.update()`
refuse `features` before sending, as Siren does.

## The public names

| Concept | Name |
|---|---|
| The kinds | `FeatureKind`, a const object and its union type |
| The feature calls | `siren.apps.features`, an `AppFeaturesResource` |
| A feature and its shapes | `AppFeature`, `AppFeatureDeclaration`, `AppFeaturePage`, `AppFeatureUse`, `RemovedAppFeature`, `CreateAppFeatureParams`, `UpdateAppFeatureParams`, `AppFeatureKindEntry`, `AppFeatureKindSetting` |
| A request's feature | `request.feature` |
| The error code constant | `AppErrorCode.FeaturesNeedKeyAndAddress` |

## The kinds snapshot

`src/app-kinds.json` is Siren's docs/api/app-kinds.json copied byte for byte.
`scripts/siren-fixtures.mjs <siren>` copies it, along with Siren's request
fixtures, and `--check` reports a stale copy. The file is imported, so it lands
in the build.

`src/feature-kind.ts` is generated from the snapshot by
`scripts/feature-kind.mjs`. Each `FeatureKind` member carries a doc comment
with the kind's name, the term Siren's code uses where it differs, Siren's
description, and whether Siren tells, asks or receives it. Hovering
`FeatureKind.IncentiveResolver` shows "Attribution model. Siren's code calls it
the incentive resolver."

`answers.on()` takes the kinds the snapshot marks `tell` or `ask`, which leaves
out `customEvent`. A screen name gets "The kind for Attribution model is
incentiveResolver.", with the name read from the snapshot.

## Tests

- test/feature-kind.test.ts holds the snapshot's form (14 kinds, six fields in
  order, four-space indent, a trailing newline), `FeatureKind` equal to it in
  order, each member's doc comment, and the generator's `--check`. Its byte test
  compares the shipped copy with the file `SIREN_APP_KINDS` names, and skips
  without it, since CI has no Siren checkout.
- test/apps-dx-kinds.test.ts holds the kinds `on()` takes and its messages.
- test/docs-feature-rename.test.ts holds the README, openapi.yaml and the
  CHANGELOG to the new names.

The CLI keeps its own copy at src/cli/app-kinds.json, which
test/cli-app-kinds.test.ts holds to Siren's. The two copies are the same bytes.
The CLI's calls into the SDK switch to the new names on the CLI's branch.
