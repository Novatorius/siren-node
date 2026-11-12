# Slice 4: SDK records, part two

Slice 4 of the Siren Node commerce connectors build. It gives the Node SDK
the rest of the record resources the Siren PHP SDK carries: opportunities,
engagements, distributors, custom currencies, store credit, mappings and the
shared settings, and the conversion and transaction writes slice 2 left out.
It closes gap 12 in
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182),
which slice 3 opened.

Read from: the Siren PHP SDK 0.3.0 at `59383e6` (`src/Resources`,
`src/Siren.php` and their tests) and Siren Cloud at `b6f7140` on
`feat/node-commerce-connectors` (the controllers under `lib/*/Rest/Service`,
`lib/Credits`, `lib/Mappings/Service/Rest`, `lib/Configs/Service/Rest`, the
capability middleware, the registry and list interceptors, and the site
rules in `saas/Auth/ConnectorRequestRules.php`).

This slice builds on slice 3's contract on `feat/ncc-s03-sdk-records-1`:
`RecordsResource`, the request helpers in `src/resources/record-requests.ts`
and `PropertyQualifier`. It follows the rules
[the slice 3 note](ncc-slice-3.md) sets for them and does not restate them.

## What changes

| Resource | Routes | Where |
|---|---|---|
| `OpportunitiesResource` | `/opportunities`, `/{id}` | `src/resources/opportunities.ts` |
| `EngagementsResource` | `/engagements`, `/{id}`, `/types`, `/calculations` | `src/resources/engagements.ts` |
| `DistributorsResource` | `/distributors`, `/{id}`, `/bulk`, `/credit-metric` | `src/resources/distributors.ts` |
| `CustomCurrenciesResource` | `/currencies/custom`, `/{code}` | `src/resources/custom-currencies.ts` |
| `CreditsResource` | `/credits/adjust`, `/credit-balances`, `/credit-entries`, `/credit-holds`, `/{id}`, and the collaborator's `creditBalances` field | `src/resources/credits.ts` |
| `MappingsResource` | `/mappings` | `src/resources/mappings.ts` |
| `SettingsResource` | `/configs` | `src/resources/settings.ts` |
| `ConversionsResource` writes | `POST /conversions`, `PUT` and `DELETE /{id}`, `/bulk`, `/types` | `src/resources/records.ts` |
| `TransactionsResource` writes | the `details` field, `POST /transactions`, `/bulk`, `/credit-collaborator`, `/sources` | `src/resources/records.ts` |
| `writeRecordOrNothing`, internal | none | `src/resources/record-writes.ts` |
| record types | none | `src/record-types.ts`, a new section below slice 3's |
| `ConversionBulkAction`, `TransactionBulkAction`, `DistributorBulkAction`, `CreditHoldStatus` | none | `src/taxonomy.ts` |

`src/index.ts` gains export lines only. The version stays 0.3.0, `engines`
stays `node >=18`, and nothing publishes.

Slice 5 owns `src/client.ts`, `src/http.ts`, `src/connect/`,
`src/resources/events.ts`, `README.md`, `CHANGELOG.md` and `openapi.yaml`,
and slice 3 owns `record-requests.ts`, `property-qualifier.ts` and
`test/record-fakes.ts`. This slice edits none of them. Cloud's slice 4
answers live in `test/record-fakes-2.ts` for that reason. Two late packets,
P10 (the seven client fields) and P11 (the docs and the parity table), start
after slice 5 and slice 3's P10 and P11 merge into
`feat/node-commerce-connectors`.

## Class roles

Every resource takes the `HttpTransport` and nothing else. The five keyed by
a numeric id or a code extend `RecordsResource`, so `list` keeps its
`SirenList` shape and `estimatedCount`. `CreditsResource` and
`SettingsResource` are plain classes, because their routes are not one
collection. Each method sends through one of slice 3's helpers
(`listRecords`, `readObject`, `writeRecord`, `deleteRecord`, `bulkRecords`)
or `retrieveRecord`, so the shape checks, the id checks and the send-once
rule come from one place.

`writeRecordOrNothing` is the one new helper. `PUT /conversions/{id}`
answers 200 with no body (`UpdateConversion.php` line 140), which
`writeRecord` refuses. The helper sends once and answers the JSON object,
`null` for no body, and `UnexpectedResponseError` with the 2xx status for
anything else, so a later Siren that sends the record still works.

Each list names its filters in a static `LIST_FILTERS` (`ENTRY_FILTERS`,
`HOLD_FILTERS` and `BALANCE_FILTERS` on credits, `FILTERS` on settings).
`listRecords` refuses any other key and any comma outside `fields` and `s`,
as slice 3 set out. Conversions and transactions keep slice 2's
`RecordsResource.list`, which sends any key, since changing a shipped
method is out of this slice's scope.

## Send-once and retries

Every write goes out once: the creates, updates, deletes and bulk actions,
`creditMetric`, `creditCollaborator`, `adjust`, `placeHold`, `releaseHold`
and the mapping create and deletes. Every read retries on a lost connection,
429 and 5xx. `adjust` and `creditMetric` would apply twice if sent twice,
and Siren takes no idempotency key for either. `placeHold` and
`releaseHold` are safe for the caller to repeat (a repeat placement for the
same token and currency replaces the hold, and a hold that already ended
comes back unchanged), but the caller's queue decides that, not the
transport.

## Errors

The transport maps every status, as slice 1 set out. Two resources narrow a
409:

- `placeHold` turns every 409 into `HoldConflictError.fromConflict`, whose
  `reason` reads `hold_no_credit` and `hold_token_in_use`, and is `null` for
  `hold_currency_not_at_store`. Siren retired the hold cap, so a 429 is the
  request rate limit and stays `RateLimitError`.
- `mappings.create` leaves `mapping_exists` as `ConflictError`. The link it
  names is the one the call asked for.

Siren answers `site_filter_required`, `user_type_not_allowed` and
`field_not_allowed` as 403s with those codes, raised as `PolicyError`.
The Essentials gate on distributor and custom currency writes answers 403
`plan_required`, raised as `PermissionError`.

## Connected sites

A site's token reads opportunities only by `collaboratorId` or by id, reads
engagements, distributors, custom currencies, store credit and settings, and
writes holds and collaborator mappings. Cloud files a site's mappings and
hold references under its Property. `MappingsResource` answers every link
through `PropertyQualifier.plainRecord`, and every type, token and platform
id a caller sends must pass `PropertyQualifier.assertName`, so a caller
cannot send another site's namespace. A hold reference must be
`hold:{platform}:{token}` with two plain names, which
`CreditsResource.holdReference` builds.

## Deliberate differences from PHP

Slice 3's differences hold here too: `SirenError` before sending, the
`SirenList` shape, `null` for a 204, `UnexpectedResponseError` for a 2xx of
the wrong shape, and the list key and comma checks. These are new.

| PHP | Node | Why |
|---|---|---|
| `conversions->update()` answers `[]` for Siren's empty 200 | `null`, or the object when Siren sends one | An empty object would look like a record |
| `transactions->details()` and `credits->balances()` answer `[]` for a missing or broken field | `UnexpectedResponseError` | Siren always sends a field it was asked for. "No lines" or "no credit" must never stand in for a broken answer ([Silent Failures — Fail Loud, No Exemptions (KB 592)](https://navigator.novatori.us/r/kb/592)) |
| `credits->checkoutBalances()` drops rows that are not arrays and documents a `held` field | `UnexpectedResponseError` for a body that is not a list, and no `held` | Cloud's `GetCreditBalances.php` sends no `held` |
| `transactions->create()` checks only that `details` is a non-empty array | 1 to 500 lines, each an object, one message | Cloud refuses more than 500 with a 400 after parsing |
| `transactions->creditCollaborator()` checks only that the ids are not empty | 1 to 500 positive whole numbers, a positive collaborator id, a non-empty `type` | Cloud reads the ids as `BulkIds` |
| `credits->placeHold()` raises `HoldLimitException` for a 429 with `hold_limit` | `RateLimitError` | Siren retired the cap, and PHP keeps the class only for older deployments |
| `credits->releaseHold()` retries | sent once | Every record write is sent once. A release is safe to repeat, so the caller's queue repeats it ([Retry Unification — The Durable Queue Owns Retries (KB 591)](https://navigator.novatori.us/r/kb/591)) |
| `customCurrencies->retrieve()` takes any list key and checks only for an empty code | takes only `fields`, and every code must be letters, digits, underscores and hyphens | The code is a path segment on update and delete. Cloud's route reads `[\w-]+` |
| `distributors->creditMetric()` sends only `collaboratorId` | also takes `points` | Cloud reads `points` (`CreditMetric.php`), and a distributor with no point value needs it |
| `opportunities->list()` sends `id` and `s` | refuses both | Cloud ignores them for an organization's token and answers every opportunity. A site reads one by id with `retrieve` |
| `engagements->list()` names four filters | also `from` and `to` | Cloud's list reads both as days |
| `settings->value()` refuses only an empty name | also a comma, with one message | Cloud reads a comma as "any of" |
| `credits->entries()` and `holds()` accept a `collaboratorId` of 0 as sent | a `collaboratorId` that is not a positive whole number counts as not sent | Id 0 names no collaborator, so it must not satisfy the check that a query names one |
| Cloud's `POST /conversions/reject` | not added | PHP has no method for it, and `bulk` with `reject` covers it |

Method names, parameters and answers otherwise follow PHP one for one. The
README's parity table (P11) lists every PHP method with its Node name, and
marks the one PHP-only method, `webhooks->constructEventFromHeaders()`, with
the reason Node leaves it out.

## Packets

| Packet | Class | Depends on | Mechanical |
|---|---|---|---|
| P1 | `OpportunitiesResource` | slice 3 P1 | yes |
| P2 | `EngagementsResource` | slice 3 P1 | yes |
| P3 | `DistributorsResource` | slice 3 P1 | no |
| P4 | `CustomCurrenciesResource` | slice 3 P1, P2 | no |
| P5 | `CreditsResource` | slice 3 P1, P2 | no |
| P6 | `MappingsResource` | slice 3 P1, P2 | no |
| P7 | `SettingsResource` | slice 3 P1 | yes |
| P8 | `ConversionsResource` writes, `writeRecordOrNothing` | slice 3 P1 | no |
| P9 | `TransactionsResource` writes | slice 3 P1 | no |
| P10 | seven client fields | P1 to P7, slice 5 and slice 3 P10 merged | yes |
| P11 | README section and parity table, CHANGELOG, openapi | P10, slice 3 P11 | no |

P1 to P9 touch separate files, apart from P8 and P9, which edit different
classes in `records.ts`.

## Tests

One acceptance file per packet, in the integration shape ([Integration Testing Standards — Introduction (KB 568)](https://navigator.novatori.us/r/kb/568)):
the real resource over the real `HttpTransport`, with `FakeHttpClient` at
the `HttpClient` seam, built with slice 3's helpers in
`test/record-fakes.ts`. Cloud's answers are in `test/record-fakes-2.ts`,
each with the Cloud file and line it came from. The base URL is the
reserved host `example.invalid`. P10's test builds `Siren` with a fake
`httpClient` and that base URL, and stubs the global fetch to fail.

| Packet | Test file |
|---|---|
| P1 | `test/opportunities.test.ts` |
| P2 | `test/engagements.test.ts` |
| P3 | `test/distributors.test.ts` |
| P4 | `test/custom-currencies.test.ts` |
| P5 | `test/credits.test.ts` |
| P6 | `test/mappings.test.ts` |
| P7 | `test/settings.test.ts` |
| P8 | `test/conversion-writes.test.ts` |
| P9 | `test/transaction-writes.test.ts` |
| P10 | `test/client-records-2.test.ts` |
| P11 | `test/docs-records-2.test.ts`, `test/docs-parity.test.ts` |

Each test is skipped until its packet lands. The surface tests (filter
lists, hold limits, bulk actions, hold statuses, the missing write methods
on read-only resources) run now. The architect's proof, kept outside the
repository, ran every test unskipped against the stubs, wrote a scratch
implementation that passes them all, and scored a mutation list against it,
per [Proving a Test Is a Contract (KB 730)](https://navigator.novatori.us/r/kb/730).
`scripts/mutations/ncc-slice-4-surface.json` proves the surface tests on
this branch.
