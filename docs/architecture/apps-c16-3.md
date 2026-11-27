# Slice C16-3 in the Node SDK: transaction filters

Siren's slice C16-3 lets an app filter a sale's lines. A program or a
distributor that picks the app's feature gets asked once per sale, and the
app answers which of the sale's own lines count. Siren's catalog calls the
feature a transaction compiler. The SDK learns the kind, its readable name,
the typed shape of its ask and answer, and the typing of
`apps.requestHandler().on()` for it. No call or route changes.

Read: the slice's contract for the question and the answer rules, and the
Node commit for slice C16-7 (9dd763b on pkt/apps-c16-7), which this slice
copies file for file. The PHP and Python SDKs gain the same kind on their
own pkt/apps-c16-3 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `FeatureKind.TransactionFilter` | src/taxonomy.ts | The value `transactionFilter`. |
| Readable name | src/cli/app-kinds.ts | Transaction filter. |
| Question types | src/record-types.ts | `TransactionFilterQuestion`, `AppTransactionLine`. |
| Answer type | src/record-types.ts | `TransactionFilterAnswer`. |
| `AppFeatureFunctions` | src/record-types.ts | `on('transactionFilter', ...)` gets `AppAsk<TransactionFilterQuestion>` and returns the answer. |
| `AppFeatureDeclaration` | openapi.yaml | The kind `transactionFilter`. |

## The question

Siren asks once per sale for each program or distributor that picks the
filter. The subject id is `{opportunityId}:{programId}:t{transactionId}` for a
program's lines (`programLines`) and `{distributorId}:t{transactionId}` for a
distributor's (`distributorLines`). The SDK types the data only.

The data carries `for` (`program` or `distributor`, an id and a name),
`transaction` (its id, `units`, and the same `AppCurrency` the incentive
resolver's question carries), the sale's own `lines`, `distribution` and
`refundDistribution`. Each line has an `id`, a `type` (`lineItem`, `discount`,
`fee`, `shipping` or `tax`), a `name`, a whole `quantity`, a unit `value` as a
stored whole number in the transaction's units, and a `productId` or null.
`distribution` is null for a program and the period the sale's value lands
in for a distributor. `refundDistribution` is null, or the later period a
refund came in while the ask was open.

## Rules

- The kind needs the app's url, as every kind but a custom event does. It
  takes the answer window and no other setting.
- `apps.verifyRequest()`, `apps.requestHandler()` and
  `apps.requests.answer()` serve every kind and do not change. The SDK
  checks only what it checks for any answer: an object with a text
  `outcome`, at most 16384 bytes. Siren checks the rest and refuses an id
  the question lacks with 422 `app_answer_invalid`.
- `include` lists each line id at most once. An empty list includes
  nothing. When a record picks more than one filter, a line counts when any
  of them includes it.
- A refund reuses the stored answer, so Siren never sends refund lines.

## Tests

test/apps-transaction-filter.test.ts covers the kind, its name, the app
file's declaration, a feature with no url, a program's and a distributor's
ask sent through `apps.requestHandler()` with the typed `on()`, two
`@ts-expect-error` lines for answers of the wrong shape, and both answers
through the answer route by hand. The question's transaction is the
incentive resolver ask's from Siren's feature fixture. The kind-list tests in
test/cli-app-file-container.test.ts and test/cli-apps-container-review.test.ts
name the kind.

## Left open

Siren's catalog fixtures for `GET /apps/kinds` are not generated, so the
name here is pinned by hand until the server half lands. `AppTransactionLine`
holds the five line types the contract names, so a sixth type Siren adds
later needs a change here.
