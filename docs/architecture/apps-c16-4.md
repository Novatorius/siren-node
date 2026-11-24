# Slice C16-4 in the Node SDK: engagement calculations and engagement filters

Siren's slice C16-4 lets an app join the engagement calculation and
engagement filter registries. A program whose engagement type picks the
app's calculation asks the app who earns each engagement, and a program that
picks the app's filter asks whether each engagement may be made. Siren makes
no engagement until the answer, and sales on that program and opportunity
wait for it, 24 hours at most. The SDK learns the two kinds, their readable
names and the typed shapes of their asks and answers. No call or route
changes.

Read: Siren's server half on branch pkt/apps-c16-4 (AppEngagementQuestion.php,
AppEngagementCalculationAnswerHandler.php, AppEngagementFilterAnswerHandler.php,
AppItemKindCatalog.php and the feature contracts fixture
tests/Fixtures/apps-feature-contracts/requests.json). The PHP and Python SDKs
gain the same kinds on their own pkt/apps-c16-4 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `FeatureKind.EngagementCalculation`, `FeatureKind.EngagementFilter` | src/taxonomy.ts | The values `engagementCalculation` and `engagementFilter`. |
| Readable names | src/cli/app-kinds.ts | Engagement calculation, Customer filter for programs. |
| Question and answer types | src/record-types.ts | `AppEngagementCalculationQuestion`, `AppEngagementCalculationAnswer`, `AppEngagementFilterQuestion`, `AppEngagementFilterAnswer`, `AppEngagementCause`, `AppEngagementOpportunity`. |
| Typed handler | src/record-types.ts | `AppFeatureFunctions.engagementCalculation` and `.engagementFilter`, so `on(kind, ...)` types the request and the answer. |
| `AppFeatureDeclaration` | openapi.yaml | The two kinds. |

## Rules

- Both kinds need the app's url, as every kind but a custom event does. They
  take the answer window and no other setting.
- `apps.verifyRequest()`, `apps.requestHandler()` and `apps.requests.answer()`
  serve every kind and do not change. Siren checks the answer and refuses
  with 422 a calculation outcome other than `engagements`, more than 50
  results, a collaborator named twice or gone, and a score that isn't a
  whole number of 0 or more. A filter's outcome must be `allow` or
  `suppress`, and a suppress needs a plain text reason of 1 to 200
  characters.
- An answer after Siren stopped waiting gets the 409 `app_request_dropped`
  slice C16-2 added, as `ConflictError`, sent once.

## Tests

test/apps-engagement-kinds.test.ts covers the kinds, their names, the app
file's declaration, a kind with no url, `scoresMoney` refused on an
engagement calculation, functions typed by `AppFeatureFunctions` run on
Siren's fixture questions, and the answer route. The kind-list tests in
test/cli-app-file-container.test.ts and test/cli-apps-container-review.test.ts
name the kinds.

## Left open

The feature page's samples for these kinds use a helper the developer
writes, so they are not added to test/answer-samples, as the metric kinds'
were not. Siren's catalog fixtures for `GET /apps/kinds` are not generated,
so the names here are pinned by hand until the server half lands.
