# The payout method ask in the Node SDK

A currency's autofulfiller can name an app's payout method. Siren then asks
the app to pay one payout, and the app answers. The SDK already knew the kind
`payoutMethod`. It now types the ask and its answer. No call or route changes.

## What changes

| Part | File | Change |
|---|---|---|
| `AppPayoutQuestion` | src/record-types.ts | The ask's `data`: `payout`, `amount` and `collaborator`. |
| `AppPayoutAnswer` | src/record-types.ts | `AppPayoutPaid` (`reference`, 1 to 191 characters) or `AppPayoutFailed` (`reason`, 1 to 500 characters). |
| `AppFeatureFunctions.payoutMethod` | src/record-types.ts | Takes `AppAsk<AppPayoutQuestion>` and returns an `AppPayoutAnswer`, as `incentiveResolver` does. |

## Rules

- `payout.attempt` starts at 1 and rises when Siren asks again about the same
  payout.
- The app pays each payout id at most once. When Siren asks again about a
  payout the app already paid, the app answers `paid` with the first
  reference.
- Siren drops an ask after 24 hours with no answer and marks the payout
  failed. A later answer gets 409 `app_request_dropped`, a `ConflictError`
  with `AppErrorCode.Dropped`.
- Siren checks the answer. The SDK checks only that it is an object with a
  text `outcome`, at most 16384 bytes.

## Tests

test/apps-payout-method.test.ts reads a question from Siren's JSON, checks
both answer shapes through the answer route and posts a paid answer from a
typed `payoutMethod` function.
