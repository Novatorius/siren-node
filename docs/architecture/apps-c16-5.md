# Slice C16-5 in the Node SDK: program group structures

Siren's slice C16-5 lets an app join the program group sorter registry. A
program group that picks the app's structure asks it the order to try the
group's programs in for each sale or lead, and the group's award waits for
the answer, 24 hours at most. The SDK learns the kind, its readable name and
the typed shape of its ask and answer. No call or route changes.

Read: Siren's server half on branch pkt/apps-c16-5 (AppGroupOrderQuestion.php,
AppGroupOrderAnswerHandler.php, AppItemKindCatalog.php and the feature
contracts fixture tests/Fixtures/apps-feature-contracts/requests.json, whose
`programGroupSorter` entry test/fixtures copies). The PHP and Python SDKs gain
the same kind on their own pkt/apps-c16-5 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `AppItemKind.ProgramGroupSorter` | src/taxonomy.ts | The value `programGroupSorter`. |
| Readable name | src/cli/app-kinds.ts | Program group structure. |
| Question and answer types | src/record-types.ts | `AppGroupOrderQuestion`, `AppGroupOrderProgram`, `AppGroupOrderEngagement`, `AppGroupOrderAnswer`. |
| Typed handler | src/record-types.ts | `AppFeatureFunctions.programGroupSorter`, so `on('programGroupSorter', ...)` types the request and the answer. |
| `AppItemDeclaration` | openapi.yaml | The kind `programGroupSorter`. |

## Rules

- The kind needs the app's url, as every kind but a custom event does. It
  takes the answer window and no other setting.
- `apps.verifyRequest()`, `apps.requestHandler()` and `apps.requests.answer()`
  serve every kind and do not change. Siren checks the answer and refuses
  with 422 an outcome other than `sorted`, a `programIds` that isn't a list,
  an id that isn't a whole number, an id the question didn't list, an id
  given twice, and an id left out.
- An answer after Siren stopped waiting gets the 409 `app_request_dropped`
  slice C16-2 added, as `ConflictError`, sent once.

## Tests

test/apps-program-group-sorter.test.ts covers the kind, its name, the app
file's declaration, a structure with no url, the sample's answer on Siren's
fixture question against the rules of Siren's validate(), a tie and a
program with no engagement, and the answer route. test/apps-answer-samples.test.ts
runs test/answer-samples/program-group-sorter.js, the feature page's sample,
and test/docs-apps-request-handler.test.ts holds the README's copy to it. The
kind-list tests in test/cli-app-file-container.test.ts and
test/cli-apps-container-review.test.ts name the kind.

## Left open

Siren's catalog fixtures for `GET /apps/kinds` are not generated, so the
name here is pinned by hand until the server half lands.
