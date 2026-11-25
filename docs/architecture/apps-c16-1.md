# Slice C16-1 in the Node SDK: metric calculations and metric filters

Siren's slice C16-1 lets an app join two registries: the calculation
strategies a distributor's metric type selects, and the metric filters a
distributor selects. The SDK learns the two kinds, their one new setting and
the typed shape of each ask and answer. No call or route changes.

Read: Siren's server half on branch pkt/apps-c16-1 at a886be8b3, which had not
yet added the two catalog entries, so the names, settings and contracts come
from the slice's brief and the design note c16-nine-registries.md, sections
10, 12 and 16. The PHP and Python SDKs gain the same kinds on their own
pkt/apps-c16-1 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `FeatureKind.MetricCalculation`, `FeatureKind.MetricFilter` | src/taxonomy.ts | The values `metricCalculation` and `metricFilter`. |
| Readable names | src/cli/app-kinds.ts | Metric calculation, and Customer filter for distributors. |
| `scoresMoney` | src/cli/app-file.ts, src/resources/apps.ts, src/record-types.ts | A boolean on a metric calculation, sent by `apps.declare()`, `apps.features.create()` and `apps.features.update()`. |
| Apply's change lines | src/cli/app-changes.ts | A changed `scoresMoney` reads "scores money". Left out counts as false. |
| Question and answer types | src/record-types.ts | `MetricCalculationQuestion`, `MetricCalculationAnswer`, `MetricFilterQuestion`, `MetricFilterAnswer`. |
| `AppFeatureDeclaration` | openapi.yaml | The kinds `customEvent`, `metricCalculation` and `metricFilter`, and `scoresMoney`. |

## Rules

- The app file refuses a `scoresMoney` that is not true or false, and refuses
  it on any other kind, naming the key and its line, before anything is sent.
- Both kinds need the app's url, as every kind but a custom event does.
- `apps.verifyRequest()` and `apps.requests.answer()` serve every kind and do
  not change. The SDK checks only what it checks for any answer: an object
  with a text `outcome`, at most 16384 bytes. Siren checks the rest of each
  answer and refuses a bad one with 422: more than 50 results, a
  collaborator twice or outside the organization, a score that is not a
  whole number of 0 or more, or a suppress reason outside 1 to 200
  characters.

## Tests

test/apps-metric-kinds.test.ts covers the kinds, the names, the app file's
`scoresMoney` rules, the declaration, apply's change line and an answer of
each shape through the answer route. The kind-list tests in
test/cli-app-file-container.test.ts and test/cli-apps-container-review.test.ts
name the two new kinds.

## Left open

Siren's catalog fixtures for `GET /apps/kinds` are not generated, so the
names here are pinned by hand until the server half lands.
