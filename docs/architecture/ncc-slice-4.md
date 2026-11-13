# Slice 4: SDK records, part two

This is slice 4 of the Siren Node commerce connectors build. It gives the Node SDK
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

This slice builds on slice 3: `RecordsResource`, the request helpers in
`src/resources/record-requests.ts` and `PropertyQualifier`. It follows the
rules [the slice 3 note](ncc-slice-3.md) sets for them and does not restate
them.

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
| `ConversionsResource` writes | `POST /conversions`, `PUT` and `DELETE /{id}`, `/bulk`, `/types`, and `recoverCreate`, which reads `GET /conversions` first | `src/resources/records.ts` |
| `TransactionsResource` writes | the `details` field, `POST /transactions`, `/bulk`, `/credit-collaborator`, `/sources`, and `recoverCreditCollaborator`, which reads `GET /conversions` first | `src/resources/records.ts` |
| `writeRecordOrNothing`, internal | none | `src/resources/record-writes.ts` |
| `pickFields`, internal, the allow list check the four creates share | none | `src/resources/create-fields.ts` |
| record types | none | `src/record-types.ts`, a new section below slice 3's |
| `ConversionBulkAction`, `TransactionBulkAction`, `DistributorBulkAction`, `CreditHoldStatus` | none | `src/taxonomy.ts` |

`src/index.ts` gains export lines only. `src/client.ts` gains the seven
read-only fields (`opportunities`, `engagements`, `distributors`,
`customCurrencies`, `credits`, `mappings` and `settings`), built over the
client's one transport. The README carries a section for these resources and
the PHP parity table, the CHANGELOG names them under Unreleased, and
`openapi.yaml` describes their 27 paths. Cloud's slice 4 answers live in
`test/record-fakes-2.ts`, beside slice 3's `test/record-fakes.ts`. The
version is 0.3.0, `engines` is `node >=18`, and the slice publishes nothing.

## Class roles

Every resource takes the `HttpTransport` and nothing else. The five keyed by
a numeric id or a code extend `RecordsResource`, so `list` keeps its
`SirenList` shape and `estimatedCount`. `CreditsResource` and
`SettingsResource` are plain classes, because their routes are not one
collection. Each method sends through one of slice 3's helpers
(`listRecords`, `readObject`, `writeRecord`, `deleteRecord`, `bulkRecords`)
or `retrieveRecord`, so the shape checks, the id checks and the send-once
rule come from one place.

`writeRecordOrNothing` is the one new helper. Siren answers
`PUT /conversions/{id}` with an empty 200 (`UpdateConversion.php` line
140), and `writeRecord` refuses that. The helper sends once. It answers the
JSON object, or `null` for no body, so a later Siren that sends the record
still works. Any other body raises `UnexpectedResponseError` with the 2xx
status. `null` means Siren took the write and sent nothing back.

Each list names its filters in a static `LIST_FILTERS`. A class whose
routes are not one collection names each read's filters after that read
instead: `ENTRY_FILTERS`, `HOLD_FILTERS` and `BALANCE_FILTERS` on credits,
and `FILTERS` for `settings.list`.
`listRecords` refuses any other key, any comma outside `fields` and `s`,
and an empty filter list, and it checks every row is an object, as slice 3
set out. The id filters sit in a static `ID_FILTERS`, by how Cloud reads
them:

| Resource | `one` | `many` | Evidence |
|---|---|---|---|
| `OpportunitiesResource` | `collaboratorId` | none | GetOpportunities.php line 138 casts it to one number |
| `EngagementsResource` | none | `collaboratorId`, `programId`, `opportunityId` | GetEngagements.php line 85, column filters |
| `MappingsResource` | none | `localId` | GetMappings.php line 78, a column filter |
| `CreditsResource` | `collaboratorId` | none | GetCreditBalances.php line 55 reads one. A ledger or hold query names one collaborator |

The two field reads, `credits.balances` and `transactions.details`, go
through `readObject` with a `check`. A broken field raises
`UnexpectedResponseError` with the status Siren sent.

Conversions and transactions list through slice 2's `RecordsResource.list`,
which sends any key, so a misspelt filter there widens the query, and reads
a body it cannot parse as an empty page. Never decide a resend from it. The
two recovery methods read conversions through `listRecords` with their own
filters (see [Recovering a lost write](#recovering-a-lost-write)).

`engagements.list` sends `from` and `to` only when each is a real calendar
day written `YYYY-MM-DD`. Cloud's `DayRangeFilterMiddleware.php` (lines 83
to 101) leaves out any other value and answers every engagement, so a bad
day throws `SirenError` before sending, naming the key and the value.
`distributors.list` refuses a `metricType` of `""` for the same reason:
`GetDistributors.php` reads it as no filter and answers every distributor.

`credits.entries` and `credits.holds` read the caller's own keys once, as
the creates do, so the check that a query names a collaborator, reference
or key reads the values the query sends. `credits.checkoutBalances` refuses
a missing `collaboratorId`, which Siren answers with a 400.

## What a create sends

Four creates take a caller's object: `conversions.create`,
`transactions.create`, `customCurrencies.create` and `distributors.create`.
Each sends a new object holding only the fields its Cloud create route
reads, named in the class's static `CREATE_FIELDS`, and throws `SirenError`
before sending for any other key, whatever its value, naming it. Siren
ignores a key it does not read, so a misspelt field would be sent and
dropped without a word, and an id the caller set would be sent with the
write. `collaborators.createPending` follows the same rule. Because the body
is a new object, a `toJSON` method on the caller's object, or on its
prototype, cannot change what is sent.

The lists are static members, as `LIST_FILTERS` and `ID_FILTERS` are on the
same classes, so a caller can read them from the class it calls. Slice 3's
`SITE_CREATABLE_COLLABORATOR_FIELDS` is a named export because no resource
class owns that create. Each refusal names every field the route reads,
except the distributor one, which points at `DistributorsResource.CREATE_FIELDS`
since fifteen names would hide the refused key. The allow lists cover the
four creates.

| Create | Fields | Cloud source | Against PHP |
|---|---|---|---|
| `conversions.create` | `engagementId`, `type`, `status`, `transactionId`, `obligationId` | `CreateNewConversion.php`, `ConversionFromRequestService.php` | the five PHP documents |
| `transactions.create` | `details`, `bindingId`, `bindingDataType`, and on each line `name`, `description`, `type`, `value`, `quantity`, `units`, `attributes` | `CreateTransaction.php`, `TransactionDetailChecks.php` | the three PHP documents, and the seven line keys |
| `customCurrencies.create` | `code`, `name`, `symbol`, `symbolPosition`, `type`, `exchangeRate`, `scale`, `propertyIds` | `CreateCustomCurrency.php` | PHP documents six. Cloud also reads `scale`, and Siren Cloud requires `propertyIds`, so both are allowed |
| `distributors.create` | `name`, `description`, `distributionResolver`, `distributionPoolResolver`, `status`, `units`, `revenuePercentage`, `schedule`, `engagementTypes`, `collaboratorIds`, `collaboratorGroupId`, `transactionCompilers`, `lineItemFilters`, `postAllocationActions`, `metricFilters` | `CreateNewDistributor.php`, `ValidatesDistributorFields.php` and the listeners of `DistributorActionEvent` | the fifteen PHP documents |

A transaction line is checked too, because a misspelt `quantity` would
record one unit. `propertyId` is refused on all four, as on `createPending`:
the auth middleware reads it as a read filter, and no create route reads it.

`transactions.create` also needs `bindingId` and `bindingDataType`
together. Cloud finds a resent transaction, and answers it with a 409, only
when PHP reads both as set (`TransactionCreateService.php` line 107,
`$bindingId && $bindingDataType`). Each field is nullable on its own, so
half a binding, or a field of `""`, `"0"` or `0`, passes Cloud's validation
and is then dropped, and a resend records a second transaction. The SDK
refuses all of these before sending. It refuses a binding field of `NaN`,
`Infinity` or `-Infinity` too, with its own message, since JSON writes each
as `null` and Siren then reads no binding. A field that is `undefined` or
`null` counts as not given, so neither field, or both `null`, means no
binding.

The three new `bulk` methods take no `extra`, since Cloud's conversion,
transaction and distributor bulk routes read only `action` and `ids`.
Siren answers `{ success, affected }`. It skips an id it cannot find or
change and still answers 200, so an `affected` lower than the number of
ids sent is the only sign of a skipped id. An action outside Cloud's list
is a 400, raised as `BadRequestError`.

## Send-once and retries

Every write goes out once. The one exception is the resend after a 401
that slice 2 makes for every request. It sends the same request with a
refreshed token, and it is safe because Siren answers 401 before it writes.

Every read retries on a lost connection, 429 and 5xx, inside the client's
`maxRetries`. Slice 1's transport does this, and the SDK does not log
those attempts. A caller that runs SDK calls from its own durable queue
builds the client with `maxRetries: 0`. Then the queue's attempts are not
multiplied, and each attempt reaches the caller's log
([Retry Unification — The Durable Queue Owns Retries (KB 591)](https://navigator.novatori.us/r/kb/591)).
A default above 0 differs from KB 591. The default lives in the client,
which slice 5 owns, so this slice keeps it. Changing it breaks every caller
that relies on read retries, so the next breaking release decides it, and
until then the connector core builds its client with `maxRetries: 0`.

A write's answer is lost when it throws `ConnectionError` or a 5xx
`ApiError`, since Siren may have written first. The caller's queue decides
whether to send it again, and each write's doc says how to find out first.
The table sums up what a second send does, from Cloud's source at
`b6f7140`. A check before sending again narrows duplicates but cannot rule
them out: two workers that recover the same write at once can both find
nothing. So the caller's queue runs one recovery per record at a time.
Siren takes no key on these writes, which this build records as a Cloud
follow-up.

| Write | A second send | Before sending again |
|---|---|---|
| `conversions.create` | makes a second conversion | send it through `recoverCreate`. Without a `transactionId`, nothing can tell whether it landed, so do not resend it |
| `distributors.create` | makes a second distributor | search by name |
| `transactions.create` with both binding fields | 409, `ConflictError` | nothing. The 409 means the first worked |
| `transactions.create` without a binding | makes a second transaction | list the transactions |
| `transactions.creditCollaborator` | makes a second conversion per transaction | send it through `recoverCreditCollaborator` |
| `credits.adjust` | applies the amount again | `entries` by `sourceType: 'adjustment'` and a `description` unique to the attempt, with no comma, since `entries` refuses one. Without one, nothing can tell whether it landed, so do not resend it |
| `distributors.creditMetric` | adds the credit again (`MetricTriggerService.php` `upsertMetric`) | no SDK read. Set it aside for a person to check in Siren's dashboard |
| `customCurrencies.create` | 400 for a code Siren holds | `retrieve` the code |
| the updates, the distributor status actions, conversion `delete` and `markPending`, `placeHold`, `releaseHold`, the mapping deletes | the same result, or `affected` may differ | nothing |
| conversion `approve` and `reject`, transaction `cancel` and `refund` | may run Siren's approval or reversal work again | `retrieve` each record's status |
| `conversions.delete`, `distributors.delete` | removes for good what the first only marked deleted | `retrieve`: `deleted` means the first worked |
| `customCurrencies.delete`, the `permanent_delete` and transaction `delete` bulk actions | 404, or skips the ids already gone | nothing |
| `mappings.create` | 409 `mapping_exists`, `ConflictError` | nothing. The link is the one asked for |

### Recovering a lost write

`conversions.recoverCreate` and `transactions.recoverCreditCollaborator`
are what a caller's queue runs after `conversions.create` or
`transactions.creditCollaborator` loses its answer. Each runs the write's own
checks, reads the conversions Siren holds, and sends the write again only
for what a well-formed answer shows is missing.

- `recoverCreate` reads `GET /conversions` with the create's
  `transactionId`, `engagementId` and `type`, oldest first, one row. A row
  means the first send landed, and the method answers it with
  `created: false`. Siren makes one conversion per transaction, engagement
  and type for a create, so that is the match. A row whose `status` or
  `obligationId` differs still counts, since an approval changes the status
  after the first send. An empty list with a `total` of 0, or none, sends
  `create` once, and the method answers the new conversion with
  `created: true`. A create with no
  `transactionId` cannot be checked, so the method refuses it.
- `recoverCreditCollaborator` reads `GET /conversions` with the asked
  `transactionId` list, the `collaboratorId` and the `type` (`sale` when
  none is given, as Cloud defaults it), 200 rows a page, each page's
  `offset` the number of rows read so far, until a page holds no rows.
  Siren lowers a larger `number` to 200 (`PageSizeMiddleware.php`), and a
  short page is not taken as the end, so a lower cap later cannot hide a
  credited transaction. A row whose `id` an earlier page held means Siren
  did not read `offset`, and raises before the loop can run on. An empty
  page ends the read only when its `total` is no more than the rows read so
  far. A transaction that a row names is credited already.
  Filtering by the collaborator matters: another collaborator's conversion
  on the same transaction does not count. The method sends
  `creditCollaborator` once with the rest, in the order asked, or nothing,
  and answers `{ alreadyCredited, credited, result }`. `result` is Siren's
  `{ success, affected }`, and an `affected` below `credited.length` means
  Siren skipped ids it could not find.

Both read through `listRecords` with `ConversionsResource.RECOVERY_FILTERS`
and `RECOVERY_ID_FILTERS`, so a body that is not a record list (not JSON,
no `items` key, an `items` that is not a list) or a row that is not an
object raises `UnexpectedResponseError` with Siren's status. A row naming
another transaction, engagement, collaborator or type means Siren did not
read a filter, and raises with the row as its `data` and no status. An
empty page whose `total`, or `x-siren-estimated-count` header, is above the
rows read so far raises with Siren's status too. `GetConversions.php` reads
the rows with `where` and the total with `countWhere`, two queries, and
`where` answers no rows when one fails to load. A write that lands between
the two queries, such as a first send still in flight, or a row that fails
to load, gives that page, and it does not show the write is missing. Any
error from a read passes through, after the transport's own retries of the
GET inside `maxRetries`, as every read in this slice has. Those retries stack
with the queue's own, so a queue that owns retries builds the client with
`maxRetries: 0`. In every one of these cases
nothing is sent, because a broken answer must never count as proof that the
first send failed. Only a well-formed empty answer sends again, once. An
error from that send passes through, and the write is never sent a third
time. Running the recovery again after any error is safe, since it reads
before it sends. Neither `create` nor `creditCollaborator` falls back to
recovery on its own.

What each outcome means for the caller's queue:

| Outcome | For the queue |
|---|---|
| an answer, `created`, or `credited` with `result.affected` equal to `credited.length` | done |
| a credit answer whose `result.affected` is below `credited.length` | Siren skipped ids it could not find. Hold the job for a person |
| `SirenError` before any request | permanent. The job is wrong, so hold it for a person |
| `UnexpectedResponseError` with a status: an unreadable body, or an empty page whose total says rows match | transient. Run the recovery again later. It sends nothing until an answer is readable and agrees with its total |
| `UnexpectedResponseError` with no status: a row naming another record, or a row repeated across pages | permanent. Siren ignored a filter or the offset, and every later run will see the same |
| an `ApiError` from the read | transient for a 429 or 5xx, permanent otherwise |
| an `ApiError` from the send | as for the write on its own. Run the recovery again, which reads first |

Transient means the queue's own backoff and attempt cap, and a job that runs
out of attempts is held for a person, as is a permanent one.

The read and the send are two requests, so two workers that recover the
same write at once can both find nothing. The SDK holds no lock and sends no
key, so the caller's queue runs one recovery per record at a time, with a
dedupe key at insert: the create's `transactionId`, `engagementId` and
`type`, or the collaborator, the type and the sorted transaction ids. A
bound `transactions.create` answers a resend with a 409 `ConflictError`,
which means the first send landed, and the queue counts it as done. An
unbound `transactions.create`, `distributors.create` and `credits.adjust`
have only the checks in the table above, and a job the table says not to
resend is held for a person.

Siren sets every `idempotencyKey` itself: `place:{collaborator}:{currency}:{token}`
on a hold (`HoldService.php` line 550), and a `redeem:` key on the entries it
writes when it settles or reverses a redemption. A caller cannot send one,
and `adjust` writes none (`AdjustCreditBalance.php` line 81).

## Errors

The transport maps every status, as slice 1 set out. Two resources narrow a
409:

- `placeHold` turns every 409 into `HoldConflictError.fromConflict`, whose
  `reason` reads `hold_no_credit` and `hold_token_in_use`, and is `null` for
  `hold_currency_not_at_store`. A 429 is the request rate limit and stays
  `RateLimitError`.
- `mappings.create` leaves `mapping_exists` as `ConflictError`. The link it
  names is the one the call asked for.

Siren answers `site_filter_required`, `user_type_not_allowed` and
`field_not_allowed` as 403s with those codes, raised as `PolicyError`.
The Essentials gate on distributor and custom currency writes answers 403
`plan_required`, raised as `PermissionError`.

A caller's queue needs to know which errors to try again and which to set
aside. The SDK throws typed errors and logs nothing, so the caller logs
them through its own logger. When it sets a write aside, it logs the
method, the record ids it sent and the error's `statusCode` and `code`.
The bulk methods hand back Siren's `{ success, affected }` as it is, so
the caller compares `affected` with the ids it sent and logs a shortfall.
A logger or retry hook on the client, so a caller can see the transport's
own read retries, is a follow-up for the client, which slice 5 owns.

| Error | What the caller does |
|---|---|
| `SirenError` thrown before sending | Fix the call. Sending it again fails the same way |
| `BadRequestError`, `ValidationError`, `PermissionError`, `PolicyError`, `NotFoundError`, an `ApiError` with another 4xx status | Set it aside. Siren answers the same until the data or the plan changes |
| `AuthenticationError` | Set it aside and fix the credential. The transport already sent once more with a refreshed token |
| `ConflictError` | Read the record it names. For a create, it often means the first send worked |
| `HoldConflictError` with `reason` `no_credit` | Read `checkoutBalances` again. It clears only when the balance changes |
| `HoldConflictError` with `reason` `token_in_use` or `null` | Set it aside. Another checkout holds the token, or the currency is not spendable at this store |
| `RateLimitError`, `ConnectionError`, a 5xx `ApiError`, an `ApiError` with status 408 or 425 | Try again later, after `RateLimitError.retryAfter` seconds when Siren sent one. For a write, check first whether it landed, as the table above says |
| `UnexpectedResponseError` | Set it aside and report it. Siren answered in a shape the SDK does not know, and for a write with a 2xx status, the write landed |

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
| `conversions->create()` sends the array as given | sends only the five fields Cloud reads and refuses any other key, naming it, and checks `engagementId`, `transactionId` and `obligationId` are positive whole numbers | Cloud ignores a key it does not read |
| no lost-answer check | `conversions.recoverCreate()` and `transactions.recoverCreditCollaborator()` | A blind resend makes a second conversion, and Siren takes no key on these writes |
| `transactions->create()` checks only that `details` is a non-empty array | 1 to 500 lines, each an object, one message | Cloud refuses more than 500 with a 400 after parsing |
| `transactions->create()` sends the array and its lines as given | sends only `details`, `bindingId` and `bindingDataType`, and only the seven line keys Cloud reads, refusing any other key | Cloud ignores a key it does not read, and a misspelt `quantity` would record one unit |
| `transactions->create()` sends half a binding, or a binding of `""`, `"0"` or `0` | refuses both before sending | Cloud finds a resent transaction only when both fields are set and read as true, so the resend would record a second transaction |
| `transactions->create()` throws `JsonException` for a binding of `NAN` or `INF`, since its transport encodes with `JSON_THROW_ON_ERROR` | `transactions.create()` refuses a binding field of `NaN`, `Infinity` or `-Infinity` before sending, with its own message | `JSON.stringify` writes each as `null`, which Siren reads as no binding |
| `conversions->update()` sends the array as given | checks `engagementId`, `transactionId` and `obligationId` as `create` does | Cloud's update route reads each as a whole number from 1 |
| `distributors->list()` sends a `metricType` of `""` | refuses it before sending | `GetDistributors.php` reads `""` as no filter and answers every distributor |
| `credits->checkoutBalances()` sends a missing collaborator | refuses it before sending | Siren answers 400 for a balance read that names no collaborator |
| `transactions->creditCollaborator()` sends a `type` of `null`, which Siren reads as `sale` | refuses it before sending, as it refuses any `type` that is not a non-empty string | Leave `type` out for a sale. The acceptance test pins the refusal |
| `credits->holds()` filters by any reference | takes only `hold:{platform}:{token}`, so an API key cannot filter by the reference Siren stores for a site's hold, with the site's Property in it | `holdReference` builds the one form a site sends. Filter such a hold by `collaboratorId` and `status` and match its `reference` in the answer |
| `mappings->create()` and `forExternal()` both take an external id with a comma | `create` and `deleteForExternal` send one as given, and `forExternal` and `list` refuse one | Siren reads a comma in a filter as "any of". `forLocal` reads such a link |
| `customCurrencies->create()` sends the array as given | sends only the eight fields Cloud reads, `scale` and `propertyIds` included, which PHP does not document, and refuses any other key | Cloud ignores a key it does not read, and requires `propertyIds` |
| `distributors->create()` sends the array as given | sends only the fifteen fields PHP documents, which Cloud reads, and refuses any other key | Cloud ignores a key it does not read |
| `transactions->creditCollaborator()` checks only that the ids are not empty | 1 to 500 positive whole numbers, a positive collaborator id, a non-empty `type` | Cloud reads the ids as `BulkIds` |
| `credits->placeHold()` raises `HoldLimitException` for a 429 with `hold_limit` | `RateLimitError` | Siren Cloud has no hold cap, so a 429 is the rate limit |
| `credits->releaseHold()` retries | sent once | Every record write is sent once. A release is safe to repeat, so the caller's queue repeats it ([Retry Unification — The Durable Queue Owns Retries (KB 591)](https://navigator.novatori.us/r/kb/591)) |
| `customCurrencies->retrieve()` takes any list key and checks only for an empty code | takes only `fields`, and every code, on `retrieve`, `create`, `update` and `delete`, must be letters, digits, underscores and hyphens, or one message is thrown | The code is a path segment on update and delete. Cloud's route reads `[\w-]+` |
| `credits` checks only that a currency is not empty | every currency, on `adjust`, `checkoutBalances`, `checkoutBalance`, `placeHold` and the `currency` filter of `entries` and `holds`, must be letters, digits, underscores and hyphens, with one message | A currency is a code Siren stores. Anything else names none |
| `conversions->delete()`, `distributors->delete()` answer `[]` for Siren's 204 | `null` for the 204, and `UnexpectedResponseError` for an empty 200 | Slice 3's rule for a two-stage delete |
| `customCurrencies->delete()` and the two `mappings` deletes answer `[]` for an empty body | `UnexpectedResponseError` when a 2xx carries no object | Siren always answers these with an object. An empty one is a cut-off answer |
| every `retrieve()` passes any key as a query | sends only `fields`, `include` and `propertyId`, and leaves out any other key | `retrieveRecord` builds the query Siren's read routes take |
| `ListResource::listQuery()`, `query()`, `toListResult()`, public statics | none | Helpers of PHP's list base class. Node's `listRecords` and `recordListQuery` do that work and are internal |
| `distributors->creditMetric()` sends only `collaboratorId` | also takes `points` | Cloud reads `points` (`CreditMetric.php`), and a distributor with no point value needs it |
| `opportunities->list()` sends `id` and `s` | refuses both | Cloud ignores them for an organization's token and answers every opportunity. A site reads one by id with `retrieve` |
| `engagements->list()` names four filters | also `from` and `to`, each refused before sending unless it is a real day as `YYYY-MM-DD` | Cloud's list reads both as days, and leaves out one it cannot read, which answers every engagement |
| `settings->value()` refuses only an empty name | also a comma, with one message | Cloud reads a comma as "any of" |
| `credits->entries()` and `holds()` accept a `collaboratorId` of 0 as sent | a `collaboratorId` that is not a positive whole number does not satisfy the check that a query names one, and `listRecords` then refuses it | Id 0 names no collaborator |
| Cloud's `POST /conversions/reject` | not added | PHP has no method for it, and `bulk` with `reject` covers it |

Method names, parameters and answers otherwise follow PHP one for one. The
README's parity table lists every PHP resource method with its Node name,
and marks the one PHP-only method, `webhooks->constructEventFromHeaders()`,
with the reason Node leaves it out. `ListResource`'s three public statics
sit outside the table, for the reason above.

## Packets

The work is cut one class or module per packet. A mechanical packet copies a
pattern already in the repository, with no rule of its own to work out.

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
| P10 | seven client fields | P1 to P7, slice 5 and slice 3 P10 | yes |
| P11 | README section and parity table, CHANGELOG, openapi | P10, slice 3 P11 | no |
| F1 | `recoverCreate` and `recoverCreditCollaborator` | P8, P9 | no |
| F2 | the binding pair on `transactions.create` | P9 | no |
| F3 | the four create allow lists | P3, P4, P8, P9 | no |
| F4 | the day filters on `engagements.list` | P2 | no |

F1, F2 and F3 all edit `records.ts`, and F2 and F3 both edit
`transactions.create`, so each brings the others' work in with a merge
commit.

## Tests

One acceptance file per packet, in the integration shape ([Integration Testing Standards — Introduction (KB 568)](https://navigator.novatori.us/r/kb/568)):
the real resource over the real `HttpTransport`, with `FakeHttpClient` at
the `HttpClient` seam, built with slice 3's helpers in
`test/record-fakes.ts`. Cloud's answers are in `test/record-fakes-2.ts`,
each with the Cloud file and line it came from. They are written from
Cloud's source at `b6f7140`, not captured from a live answer, since no test
or probe in this build calls a running Siren. When Cloud's branch moves,
whoever merges it into this work checks the cited lines again. The SDK's
proof against a real Siren is the ship pipeline's integration phase on UAT.
The base URL is the reserved host `example.invalid`. These rules rest on a
reading of Cloud's source, so the UAT phase checks each against a running
Siren: a `transactions.create` with a binding of `"0"` sent twice makes two
transactions, an `engagements.list` with `from` of `2026-02-29` answers every
engagement, `GET /conversions` with `number=500` answers 200 rows, a
collaborator with no engagement answers a bare `[]`, and each create drops a
key it does not read.

KB 568's database, state reset and logger parts do not apply here. The SDK
has no database, keeps no state between calls and has no logger, so the
fake `HttpClient` is the one seam, and each test builds its own. Every
failure reaches the caller as a typed error carrying Siren's status and
body, and the caller logs it through its own logger. P10's test
builds `Siren` with a fake `httpClient` and that base URL, and stubs the
global fetch to fail.

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
| F1 | `test/conversion-recovery.test.ts` |
| F2 | `test/transaction-binding.test.ts` |
| F3 | `test/create-fields.test.ts` |
| F4 | `test/engagement-days.test.ts` |

The F1 cases start where a caller's queue meets them: the first write was
sent once and lost its answer, and the recovery runs on the same transport.
Each unreadable answer must end with one write sent and an error raised,
and each well-formed empty answer with the write sent once more.

Four error answers in `test/record-fakes-2.ts` carry wording written for
the test, not read from Cloud: `CustomCurrencyAnswers.deleteBlocked`,
`CreditAnswers.fieldNotAllowed`, `SettingAnswers.typeRefused` and
`ConversionAnswers.deleteBlocked`. Their tests check the error class, not
the text. The UAT phase replaces each with the answer a running Siren
sends.

The polish after the slice's re-review adds `test/slice-4-polish.test.ts`,
whose cases each failed on the slice branch before its fix, and its
mutation list `scripts/mutations/ncc-slice-4-polish.json`.

Every acceptance test was proven runnable and falsifiable per
[Proving a Test Is a Contract (KB 730)](https://navigator.novatori.us/r/kb/730):
each packet committed its mutation list under `scripts/mutations`
(`ncc-slice-4-pN.json`, and `ncc-slice-4-fix-fN.json` for F1 to F4), and
`scripts/mutations/ncc-slice-4-surface.json` and
`scripts/mutations/ncc-slice-4-fix.json` prove the surface tests.
