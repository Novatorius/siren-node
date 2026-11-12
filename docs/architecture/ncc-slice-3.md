# Slice 3: SDK records, part one

Slice 3 of the Siren Node commerce connectors build. It gives the Node SDK the
record resources a connector needs first: collaborators with their codes and
program enrollments, collaborator groups with their members, programs and
program groups. It closes part of gap 12 in
[Design: Siren Node commerce connectors (Source 16182)](https://navigator.novatori.us/r/source/16182).
Slice 4 adds the rest of gap 12.

Read from: the Siren PHP SDK 0.3.0 at `59383e6` (`src/Resources`,
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
| bulk actions, alias types, group sorters | none | `src/taxonomy.ts`, beside Siren's other vocabularies |

`src/index.ts` gains export lines only. The version stays 0.3.0, `engines`
stays `node >=18`, and nothing publishes.

Slice 5 edits `src/client.ts`, `README.md`, `CHANGELOG.md` and
`openapi.yaml`, so this slice leaves all four alone. Two late packets, P10
(the four client fields) and P11 (the docs), start after slice 5 merges into
`feat/node-commerce-connectors`. `git merge-tree` shows this branch and
`feat/ncc-s05-connected-site` merge cleanly.

## Class roles

Every resource takes the `HttpTransport` and nothing else, as the existing
resources do. The four top-level ones extend `RecordsResource`, so `list`
keeps its `SirenList` shape and `estimatedCount`. The three nested ones are
plain classes their parent builds over the same transport, the way PHP nests
`$siren->collaborators->aliases`.

`record-requests.ts` holds the code that calls `http.request` for these
resources. Each helper fixes one rule, so a resource cannot get it wrong.
Every `retrieve` goes through the existing `retrieveRecord` instead and takes
its `RetrieveParams` (`fields`, `include`, `propertyId`), as every other
resource with a `retrieve` does.

| Helper | Sends | Retries | Answer it requires |
|---|---|---|---|
| `listRecords` | GET with `recordListQuery` and the route's filter keys | yes | the list envelope or a bare array |
| `readObject` | GET | yes | a JSON object |
| `readList` | GET | yes | a JSON array |
| `writeRecord` | POST or PUT | no | a JSON object |
| `writeList` | POST or PUT | no | a JSON array |
| `deleteRecord` | DELETE, no body | no | a JSON object, or no body for `null` |
| `bulkRecords` | POST `{collection}/bulk` | no | a JSON object |

A 2xx answer of the wrong shape raises `UnexpectedResponseError` with the
status Siren sent, as `retrieveRecord` does. A list answer that is neither
an `items` array nor a bare array is one of them, an empty body included,
where `RecordsResource.list` would answer an empty page. A field read on the
collaborator record (`aliases.list`, `aliases.trackingCode`,
`enrollments.programsFor`) throws `UnexpectedResponseError` too when the
field is missing or holds the wrong shape, since Siren always sends a field
it was asked for. "No codes" must never stand in for a broken answer
([Silent Failures — Fail Loud, No Exemptions (KB 592)](https://navigator.novatori.us/r/kb/592)). Every helper leaves error mapping to the transport.

`recordId` checks every id before anything is sent. It takes a positive safe
integer and refuses anything else with `SirenError`, worded as
`retrieveRecord` words it and naming the field (`programId`,
`collaboratorId`). `collaborators.bulk` checks `extra.programId` and
`extra.distributorId` the same way, since Cloud casts them to whole numbers.

`recordListQuery` pages the way `toListQuery` does, joins a list with commas
and leaves out an empty list and `undefined`. It refuses, with `SirenError`
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

## Send-once

Every record write goes out once: create, update, delete, bulk, enroll,
unenroll, replace, add, remove, set, free and the alias create. A lost answer
leaves the caller to read the record and decide, as PHP does. Reads retry on
a lost connection, 429 and 5xx. The 401 resend from slice 2 still applies to
every request, since Siren answers 401 before it writes.

## Connected sites

A connected site's token reaches a narrower set of fields. Two methods exist
for it, as in PHP:

- `createPending` posts `status: 'pending'` and refuses `programs`,
  `distributors`, `groups` and `status` before sending, whatever their value.
- `updateDetails` sends `fullName` and `nickname` only and refuses any other
  key, `fields` included.

Cloud files a site's codes under its Property (`coupon@property:5`).
`PropertyQualifier` strips that suffix and reports the Property, and the
alias resource answers every code through `plainRecord`, so the caller sees
the plain type and a `propertyId`. Every code type a caller sends must pass
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
| `delete` answers `[]` for a 204 | `null` | An empty object would look like a record |
| A 2xx write answer that is not an object passes through | `UnexpectedResponseError` | Matches `retrieve` and slice 5 |
| `updateDetails` passes `fields` and `id` | refuses every key but `fullName` and `nickname` | Cloud reads `fields` on update as the custom-field map, while the site rule checks it as a list of read fields |
| `createPending` and `updateDetails` skip a `null` binding | refuse the key whatever its value | A key check cannot be fooled by a harmless-looking value |
| Any list key is sent | a key outside the route's filters throws `SirenError` | Cloud ignores an unknown key and answers every record |
| A comma in a filter string is sent | throws `SirenError`, except in `fields` and `s` | Cloud reads a comma as "any of" |
| A list answer or a record field of the wrong shape reads as empty | `UnexpectedResponseError` | An empty answer would hide a Cloud change |
| Bulk extras are sent as given | `programId` and `distributorId` must be positive whole numbers | Cloud casts them, so a bad value reaches record 0 |
| Code types are plain names | also `coupon@source:{integration}` | Cloud's connector rule allows it on the alias routes |
| `findByCode` and `forCollaborator` send `number: 1` | also `orderBy: 'dateIssued'` and `order: 'DESC'` | D6 in [Recurring Defect Classes (Design Against These) (KB 589)](https://navigator.novatori.us/r/kb/589). Cloud defaults to that order today |
| `setTrackingCode` refuses only `''` and sends the code as given | trims it, and refuses a code that is empty once trimmed or holds a comma | Every other code method trims |

Method names, parameters and answers otherwise follow PHP one for one.

## Packets

| Packet | Class | Depends on | Mechanical |
|---|---|---|---|
| P1 | request helpers | none | no |
| P2 | `PropertyQualifier` | none | yes |
| P3 | `CollaboratorsResource` | P1 | no |
| P4 | `CollaboratorAliasesResource` | P1, P2 | no |
| P5 | `ProgramEnrollmentsResource` | P1 | no |
| P6 | `CollaboratorGroupsResource` | P1 | yes |
| P7 | `CollaboratorGroupMembersResource` | P1 | no |
| P8 | `ProgramsResource` | P1 | yes |
| P9 | `ProgramGroupsResource` | P1 | yes |
| P10 | four client fields | P1 to P9, slice 5 merged | yes |
| P11 | README, CHANGELOG, openapi | P10 | no |

## Tests

One acceptance file per packet, in the integration shape ([Integration Testing Standards — Introduction (KB 568)](https://navigator.novatori.us/r/kb/568)): the real
resource over the real `HttpTransport`, with `FakeHttpClient` at the
`HttpClient` seam. `test/record-fakes.ts` holds the transport builder, the
send-once and retry checks, and Cloud's answers, each with the Cloud file it
came from. The transport's base URL is the reserved host `example.invalid`.
No test builds a client over the global fetch. P10's test builds `Siren`
with a fake `httpClient` and that base URL, and stubs the global fetch to
fail.

Each test is skipped until its packet lands. The surface tests (constant
vocabularies, filter lists, routes and nested resources) run now. The
architect's proof, kept outside the repository, ran every test unskipped
against the stubs, wrote a scratch implementation that passes them all, and
scored a mutation list against it, per [Proving a Test Is a Contract (KB 730)](https://navigator.novatori.us/r/kb/730).
`scripts/mutations/ncc-slice-3-surface.json` proves the surface tests on this
branch.
