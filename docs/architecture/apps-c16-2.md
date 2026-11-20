# Slice C16-2 in the Node SDK: incentive resolvers

Siren's slice C16-2 lets an app join the incentive resolver registry. A
program that picks the app's resolver asks it how to split each sale's
reward, and the rewards wait for the answer, 24 hours at most. The SDK learns
the kind, the typed shape of its ask and answer, and the 409 Siren answers
once it stopped waiting. No call or route changes.

Read: Siren's server half on branch pkt/apps-c16-2 (AppRewardQuestion.php,
AppItemKindCatalog.php, AppRequestService::dropped() and the feature
contracts fixture tests/Fixtures/apps-feature-contracts/requests.json). The
PHP and Python SDKs gain the same kind on their own pkt/apps-c16-2 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `AppItemKind.IncentiveResolver` | src/taxonomy.ts | The value `incentiveResolver`. |
| Readable name | src/cli/app-kinds.ts | Incentive resolver. |
| Question and answer types | src/record-types.ts | `AppRewardQuestion`, `AppRewardConversion`, `AppRewardAnswer`. |
| `AppErrorCode.Dropped` | src/errors.ts | `app_request_dropped`, the answer route's 409 after Siren stopped waiting. |
| `AppItemDeclaration` | openapi.yaml | The kind `incentiveResolver`. |

## Rules

- The kind needs the app's url, as every kind but a custom event does. It
  takes the answer window and no other setting.
- `apps.verifyRequest()` and `apps.requests.answer()` serve every kind and do
  not change. The SDK checks only what it checks for any answer: an object
  with a text `outcome`, at most 16384 bytes. Siren checks the rest and
  refuses a bad answer with 422: units that are not the pool's, a missing or
  extra conversion, or a reward that is not null or a whole number of 0 or
  more.
- A dropped ask's 409 is a `ConflictError` with the code
  `app_request_dropped`, sent once like every write. Sending it again gets
  the same 409.

## Tests

test/apps-incentive-resolver.test.ts covers the kind, its name, the app
file's declaration, a resolver with no url, both answer shapes through the
answer route, and the dropped 409. The kind-list tests in
test/cli-app-file-container.test.ts and test/cli-apps-container-review.test.ts
name the kind.

## Left open

Siren's catalog fixtures for `GET /apps/kinds` are not generated, so the
name here is pinned by hand until the server half lands.
