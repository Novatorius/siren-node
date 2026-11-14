# Slice 3: SDK records, part one

This note describes slice 3 of the Siren Node commerce connectors build.
Slice 3 gives the Node SDK the record resources a connector needs first: collaborators with their codes and
program enrollments, collaborator groups with their members, programs and
program groups. It closes part of gap 12 in
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).
Slice 4 adds the rest of gap 12.

This note draws on the Siren PHP SDK 0.3.0 at `59383e6` (`src/Resources`,
`src/PropertyQualifier.php`, `src/ProgramGroupSorter.php`, `src/Siren.php` and
their tests) and Siren Cloud at `b6f7140` on `feat/node-commerce-connectors`
(the controllers under `lib/*/Service/Rest`, `saas/Rest`, the list
interceptor, the site rules for connected sites, and their PHPUnit tests).

## What changes

| Resource | Routes | Where |
|---|---|---|
| `CollaboratorsResource` | `/collaborators`, `/{id}`, `/bulk`, `/status-types`, `/generate-referral-code` | `src/resources/collaborators.ts` |
| `CollaboratorAliasesResource`, at `collaborators.aliases` | `/collaborator-aliases`, and the record's own `aliases`, `referralCode` and `trackingId` fields | `src/resources/collaborator-aliases.ts` |
| `ProgramEnrollmentsResource`, at `collaborators.enrollments` | `/collaborator-programs`, the record's `programs` field, and the two bulk actions | `src/resources/program-enrollments.ts` |
| `CollaboratorGroupsResource` | `/collaborator-groups`, `/{id}`, `/structures` | `src/resources/collaborator-groups.ts` |
| `CollaboratorGroupMembersResource`, at `collaboratorGroups.members` | `/collaborator-groups/{id}/members`, `/{collaboratorId}` | `src/resources/collaborator-group-members.ts` |
| `ProgramsResource` | `/programs`, `/{id}`, `/bulk`, `/status-types`, `/incentive-types`, `/currency-types` | `src/resources/programs.ts` |
| `ProgramGroupsResource` | `/program-groups`, `/{id}`, `/bulk` | `src/resources/program-groups.ts` |
| `PropertyQualifier` | none | `src/property-qualifier.ts` |
| request helpers, internal | none | `src/resources/record-requests.ts` |
| record types | none | `src/record-types.ts` |
| the `Siren` client's `collaborators`, `collaboratorGroups`, `programs` and `programGroups` fields | none | `src/client.ts` |
| bulk actions, alias types, group sorters | none | `src/taxonomy.ts`, beside Siren's other vocabularies |

`src/index.ts` gains export lines only. The `Siren` client builds the four
top-level resources over its own transport. `README.md` gains a
"Collaborators and programs" section, `CHANGELOG.md` lists the new
resources, and `openapi.yaml` describes their routes. The version stays
0.3.0, `engines` stays `node >=18`, and nothing publishes.

## Class roles

Every resource takes the `HttpTransport` and nothing else, as the existing
resources do. The four top-level ones extend `RecordsResource`, so `list`
keeps its `SirenList` shape and `estimatedCount`. The three nested ones are
plain classes their parent builds over the same transport, the way PHP nests
`$siren->collaborators->aliases`.

The four top-level resources override `RecordsResource.list` with
`listRecords` and add writes, so their own docs govern.

`record-requests.ts` holds the code that calls `http.request` for these
resources. Each helper fixes one rule, so a resource cannot get it wrong.
Every `retrieve` goes through the existing `retrieveRecord` instead and takes
its `RetrieveParams` (`fields`, `include`, `propertyId`), as every other
resource with a `retrieve` does.

| Helper | Sends | Retries | Answer it requires |
|---|---|---|---|
| `listRecords` | GET with `recordListQuery` and the route's filter keys | yes | the list envelope or a bare array, every row a JSON object |
| `readObject` | GET | yes | a JSON object that passes the caller's `check` |
| `readList` | GET | yes | a JSON array |
| `writeRecord` | POST or PUT | no | a JSON object |
| `writeList` | POST or PUT | no | a JSON array |
| `deleteRecord` | DELETE, no body | no | a JSON object, or a 204 for `null` |
| `bulkRecords` | POST `{collection}/bulk` | no | a JSON object |

A 2xx answer of the wrong shape raises `UnexpectedResponseError` with the
status Siren sent, as `retrieveRecord` does. A list answer that is neither
an `items` array nor a bare array is one of them, an empty body included,
where `RecordsResource.list` would answer an empty page, and so is a list
row that is not a JSON object. A delete answers `null` only for a 204, so an
empty 200 throws. A field read on the collaborator record (`aliases.list`,
`aliases.trackingCode`, `enrollments.programsFor`) passes `readObject` a
`check`, and throws `UnexpectedResponseError` with the status and a message
naming the field and the collaborator when the field is missing or holds the
wrong shape, since Siren always sends a field it was asked for. A code row
whose `type` is not a string throws the same way. "No codes" must never stand in for a broken answer
([Silent Failures — Fail Loud, No Exemptions (KB 592)](https://navigator.novatori.us/r/kb/592)). Every helper leaves error mapping to the transport.

`recordId` checks every id before anything is sent. It takes a positive safe
integer and refuses anything else with `SirenError`, worded as
`retrieveRecord` words it and naming the field (`programId`,
`collaboratorId`). `collaborators.bulk` checks `extra.programId` and
`extra.distributorId` the same way, since Cloud casts them to whole numbers,
and refuses any extra the action does not take, since Cloud hands every
parameter to the action.

`recordListQuery` pages the way `toListQuery` does, joins a list with commas
and leaves out `undefined` and an empty `fields` list. It refuses, with `SirenError`
naming the key, anything Siren would read differently from what the caller
meant, instead of dropping it (D7 in [Recurring Defect Classes (Design Against These) (KB 589)](https://navigator.novatori.us/r/kb/589)):

- a key outside the route's filters and the paging, sorting and `fields`
  keys. Each resource names its filters in a static `LIST_FILTERS`
  (`QUERY_FILTERS` on aliases). Cloud ignores a list parameter it does not
  read, so a misspelt filter or a `propertyId` would answer every record.
- a comma in a filter string or a list member. Cloud's FilterMiddleware
  splits a comma into "any of", so `code: 'SAVE10,VIP'` would match two
  codes. Only `fields` and the search text `s` may hold commas.
- an object, `null`, a function, or a list member that is not a string or
  finite number.
- an empty list on a filter. Left out, it would answer every record, where
  the caller asked for none.
- an id filter that is not a positive safe integer. Each resource names its
  id filters in a static `ID_FILTERS`. Keys in `one` take a single id, since
  Cloud casts `programId`, `distributorId` and `programGroupId` to one whole
  number, and keys in `many` take an id or a list of ids.

## Send-once

Every record write goes out once, apart from the single resend after a 401
that slice 2 makes for every request: create, update, delete, bulk, enroll,
unenroll, replace, add, remove, set, free and the alias create. A write's
answer is lost when it throws `ConnectionError` or a 5xx `ApiError`, since
Siren may have written first. Each write's doc says how to find out before
sending it again, and the caller decides, as PHP leaves it to the caller.
Reads retry on a lost connection, 429 and 5xx. A caller that runs these
calls from its own durable queue builds the client with `maxRetries: 0`, so
the queue owns every retry ([Retry Unification — The Durable Queue Owns Retries (KB 591)](https://navigator.novatori.us/r/kb/591)). The 401 resend from slice 2 still applies to
every request, since Siren answers 401 before it writes.

## Connected sites

A connected site's token reaches a narrower set of fields. Two methods exist
for it, as in PHP:

- `createPending` sends `fullName`, `nickname`, `email` and an optional
  `trackingId` with `status: 'pending'` (`SITE_CREATABLE_COLLABORATOR_FIELDS`),
  the fields Cloud's create route reads that a site may set. It refuses
  `programs`, `distributors`, `groups` and `status` before sending, whatever
  their value, and every other key with a second message.
- `updateDetails` sends `fullName` and `nickname` only and refuses any other
  key, `fields` included.

Cloud files a site's codes under its Property (`coupon@property:5`).
`PropertyQualifier` strips that suffix and reports the Property. The reads
on `/collaborator-aliases` (`query`, `findByCode` and `forCollaborator`) and
the answer to `create` go through `plainRecord`, so the caller sees the
plain type and a `propertyId`. `aliases.list` reads the collaborator
record's own `aliases` field and answers each type as Cloud stores it,
`coupon@property:5` included, as PHP 0.3.0's `list` does. Every code type a caller sends must pass
`assertCodeType`: a plain name, or one integration's coupons such as
`coupon@source:wc`, which Cloud's connector rule accepts on the alias
routes. A caller cannot send a Property qualifier or a list in one string.
Every code is trimmed and refused when empty or holding a comma.

`aliases.create` turns the 409 Siren answers for a held code into
`CodeConflictError.fromConflict(conflict, trimmedCode, type)`. Every other
error passes through unchanged. Siren's 409 does not name the holder, so
after a lost answer or a conflict the caller reads `findByCode` and compares
its `collaboratorId` before treating the code as someone else's.

Deleting an `invited` collaborator removes them for good on the first call,
which answers `null`. A partial bulk result answers 200 with a lower
`affected`, and the `sendSignupEmail` 502 raises `ApiError` with the `sent`
and `failed` counts in `data`.

## Deliberate differences from PHP

| PHP | Node | Why |
|---|---|---|
| `InvalidArgumentException` before sending | `SirenError` | The Node SDK refuses bad input with `SirenError` everywhere |
| `list` answers `ListResult` with page counts | `SirenList`, an array with `estimatedCount` | The existing Node list shape |
| A 2xx write answer that is not an object passes through | `UnexpectedResponseError` | Matches `retrieve` and slice 5 |
| `updateDetails` passes `fields` and `id` | refuses every key but `fullName` and `nickname` | Cloud reads `fields` on update as the custom-field map, while the site rule checks it as a list of read fields |
| `createPending` and `updateDetails` refuse a binding key that is present, `null` included (`array_key_exists`) | the same, and a key set to `undefined` too | A key check refuses the key whatever its value, even one JSON would drop |
| `createPending` sends every key but the bindings and `status` | sends only `fullName`, `nickname`, `email` and `trackingId`, and refuses any other key | Cloud's create route reads no other key, so a stray `id` or `propertyId` would go out unread |
| Any list key is sent | a key outside the route's filters throws `SirenError` | Cloud ignores an unknown key and answers every record |
| A comma in a filter string is sent | throws `SirenError`, except in `fields` and `s` | Cloud reads a comma as "any of" |
| An empty filter list is sent as an empty string | throws `SirenError` | Cloud would answer every record |
| Id filters are sent as given | must be positive whole numbers, and `programId`, `distributorId` and `programGroupId` take one | Cloud casts them to one whole number, so `'3abc'` reads as 3 and a list keeps one id |
| `delete` answers `[]` for any empty body | `null` for a 204, and an empty 200 throws | An empty object would look like a record, and Siren answers 204 for every bodiless delete in this slice |
| A list answer or a record field of the wrong shape reads as empty | `UnexpectedResponseError` | An empty answer would hide a Cloud change |
| Bulk extras are sent as given | each action takes only its own extra, `programId` or `distributorId`, as a positive whole number, and the rest take none | Cloud hands every parameter to the action and casts the ids, so a stray key can steer it and a bad id reaches record 0 |
| `Collaborators::BULK_*` has no reject action | `CollaboratorBulkAction.Reject` | Cloud's bulk route accepts `reject` (`CollaboratorBulkAction.php` line 261), and the Node SDK follows Cloud |
| Code types are plain names | also `coupon@source:{integration}` | Cloud's connector rule allows it on the alias routes |
| `findByCode` and `forCollaborator` send `number: 1` | also `orderBy: 'dateIssued'` and `order: 'DESC'` | D6 in [Recurring Defect Classes (Design Against These) (KB 589)](https://navigator.novatori.us/r/kb/589). Cloud at `b6f7140` defaults to that order |
| `setTrackingCode` refuses only `''` and sends the code as given | trims it, and refuses a code that is empty once trimmed or holds a comma | Every other code method trims |
| `members.add` and `members.set` send the members as given | both check that each member is an object with a positive whole `collaboratorId`, and `add` refuses an empty list | A bad id would reach Siren, and an empty add asks for nothing |
| Bulk actions check only that there are 1 to 500 ids | also check that each id is a positive whole number | Every other id the SDK sends is checked the same way |
| `collaboratorsIn` drops a `programId` in `params`, since the first argument wins | throws `SirenError` | A second program id is a caller's mistake, and dropping it would hide that ([Silent Failures — Fail Loud, No Exemptions (KB 592)](https://navigator.novatori.us/r/kb/592)) |
| `aliases.free` and `enrollments.remove` answer Siren's body | answer `{ deleted: true }` once Siren answers a JSON object or a 204 | Cloud answers `{ deleted: true }` on both routes, and the constant says the request succeeded, never that a code or enrollment existed |
| `programs.list` names no `engagementType` filter | `engagementType` is one of its `LIST_FILTERS` | Cloud's program list reads it (`GetPrograms.php` line 156), and the Node SDK refuses any filter it does not name |

Method names, parameters and answers follow PHP otherwise.

## Tests

Each resource and the request helpers have their own acceptance file, in the integration shape ([Integration Testing Standards — Introduction (KB 568)](https://navigator.novatori.us/r/kb/568)): the real
resource over the real `HttpTransport`, with `FakeHttpClient` at the
`HttpClient` seam. `test/record-fakes.ts` holds the transport builder, the
send-once and retry checks, and Cloud's answers, hand-read from Cloud's
source, each with the file it came from, and not captured from a running
Cloud. The transport's base URL is the reserved host `example.invalid`.
No test builds a client over the global fetch. The client test
(`test/client-records.test.ts`) builds `Siren` with a fake `httpClient` and that base URL, and stubs the global fetch to
fail.

Mutation lists under `scripts/mutations` prove the tests can fail, per
[Proving a Test Is a Contract (KB 730)](https://navigator.novatori.us/r/kb/730):
`ncc-slice-3-p1.json` to `ncc-slice-3-p11.json`, one for each part of the
slice, and `ncc-slice-3-surface.json` for the vocabularies, filter lists,
routes and nested resources. Run each with `node scripts/mutation-proof.mjs`
inside `unshare -rn`, with only loopback up, so a mutation that lets a
request through cannot reach the network.
