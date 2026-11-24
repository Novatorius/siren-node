# Slice C16-6 in the Node SDK: incentive types

Siren's slice C16-6 lets an app join the incentive type registry. A program
that picks the app's incentive structure as its incentive type asks the app,
for each sale, lead or renewal, which engagements convert and the pool the
program's resolver divides among them. The award waits for the answer, 24
hours at most. A partial refund of an award already made asks again, and the
rewards stay until that answer. The SDK learns the kind, its readable name,
its `conversionTypes` setting and the typed shape of its ask and answer.

Read: Siren's server half on branch pkt/apps-c16-6 (AppIncentiveTypeQuestion.php,
AppIncentiveTypeAnswerHandler.php, AppIncentiveType.php, AppItemKindCatalog.php,
AddAppItem.php and the feature contracts fixture
tests/Fixtures/apps-feature-contracts/requests.json, whose `incentiveType`
entry test/fixtures copies). The PHP SDK at 41f8124 and the Python SDK at
d0b74ff gain the same kind on their own pkt/apps-c16-6 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `FeatureKind.IncentiveType` | src/taxonomy.ts | The value `incentiveType`. |
| Readable name | src/cli/app-kinds.ts | Incentive structure. |
| Question and answer types | src/record-types.ts | `AppIncentiveTypeQuestion`, `AppIncentiveTypeEngagement`, `AppIncentiveTypeLine`, `AppIncentiveTypeAnswer`. |
| Typed handler | src/record-types.ts | `AppFeatureFunctions.incentiveType`, so `on('incentiveType', ...)` types the request and the answer. |
| Setting | src/record-types.ts, src/resources/apps.ts | `conversionTypes` (`AppConversionType[]`) on a declaration, an item's settings and an update, sent by `apps.declare()`, `apps.features.create()` and `apps.features.update()`. |
| App file | src/cli/app-file.ts, src/cli/app-changes.ts | Reads `conversionTypes`, declares it in the catalog's order, and shows a change as "conversions it pays". |
| `AppFeatureDeclaration` | openapi.yaml | The kind `incentiveType` and the property `conversionTypes`. |

## Rules

- The kind needs the app's url, as every kind but a custom event does. It
  takes `conversionTypes` and the answer window. Siren's default window for
  it is 60 minutes.
- `conversionTypes` is required for an incentive type: a non-empty list of
  `sale`, `lead` and `renewal`, each once. The app file refuses any other,
  and refuses the field on every other kind, before anything is sent. Siren
  checks the same through the catalog's `choiceList` type.
- `apps.verifyRequest()`, `apps.requestHandler()` and `apps.requests.answer()`
  serve every kind and do not change. Siren checks the answer and refuses
  with 422 an outcome other than `award` or `none`, other fields beside
  `none`, units other than the program's, a pool that is not a whole number
  of 0 or more, an empty `engagementIds`, an id the question did not list,
  an id given twice, and any field it does not read.
- An answer after Siren stopped waiting gets the 409 `app_request_dropped`
  slice C16-2 added, as `ConflictError`, sent once.

## Tests

test/apps-incentive-type.test.ts covers the kind, its name, the typed
function on Siren's fixture question, the app file's declaration in the
catalog's order, each refusal of `conversionTypes`, the three item routes
sending it, apply's "conversions it pays" line, and both answers through the
answer route. test/apps-answer-samples.test.ts runs
test/answer-samples/incentive-type.js, the feature page's sample, and
test/docs-apps-request-handler.test.ts holds the README's copy to it. The
kind-list tests in test/cli-app-file-container.test.ts and
test/cli-apps-container-review.test.ts name the kind.

## Left open

Siren's catalog fixtures for `GET /apps/kinds` are not generated, so the
name here is pinned by hand until the server half lands. The question's
lines carry no product id, since Siren's transaction lines hold none
(AP-A3702).
