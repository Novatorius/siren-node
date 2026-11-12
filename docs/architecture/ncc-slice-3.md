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

`src/index.ts` gains export lines only. The version stays 0.3.0, `engines`
stays `node >=18`, and nothing publishes.

Slice 5 is in review and edits `src/client.ts`, `README.md`, `CHANGELOG.md`
and `openapi.yaml`. This slice leaves all four alone. Two late packets, P10
(the four client fields) and P11 (the docs), start after slice 5 merges into
`feat/node-commerce-connectors`. `git merge-tree` shows this branch and
`feat/ncc-s05-connected-site` merge cleanly today.

## Class roles

Every resource takes the `HttpTransport` and nothing else, as the existing
resources do. The four top-level ones extend `RecordsResource`, so `list`
keeps its `SirenList` shape and `estimatedCount`. The three nested ones are
plain classes their parent builds over the same transport, the way PHP nests
`$siren->collaborators->aliases`.

`record-requests.ts` holds the only code that calls `http.request` for these
resources. Each helper fixes one rule, so a resource cannot get it wrong:

| Helper | Sends | Retries | Answer it requires |
|---|---|---|---|
| `listRecords` | GET with `recordListQuery` | yes | the list envelope or a bare array |
| `readObject` | GET | yes | a JSON object |
| `readList` | GET | yes | a JSON array |
| `writeRecord` | POST or PUT | no | a JSON object |
| `writeList` | POST or PUT | no | a JSON array |
| `deleteRecord` | DELETE, no body | no | a JSON object, or no body for `null` |
| `bulkRecords` | POST `{collection}/bulk` | no | a JSON object |

A 2xx answer of the wrong shape raises `UnexpectedResponseError` with the
status Siren sent, as `retrieveRecord` does. Every helper leaves error
mapping to the transport.

`recordId` checks every id before anything is sent. It takes a positive safe
integer and refuses anything else with `SirenError`, worded as
`retrieveRecord` words it and naming the field (`programId`,
`collaboratorId`). `recordListQuery` pages the way `toListQuery` does, joins a
list with commas, leaves out an empty list and `undefined`, and refuses a
value it cannot send (an object, `null`, a list member that is not a string
or finite number, or one that holds a comma) instead of dropping it (D7 in
KB 589).

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
the plain type and a `propertyId`. Every type a caller sends must pass
`assertName`, so a caller cannot send a qualified name or a list in one
string.

`aliases.create` turns the 409 Siren answers for a held code into
`CodeConflictError.fromConflict(conflict, trimmedCode, type)` (A106). Every
other error passes through unchanged.

## Deliberate differences from PHP

| PHP | Node | Why |
|---|---|---|
| `InvalidArgumentException` before sending | `SirenError` | The Node SDK refuses bad input with `SirenError` everywhere |
| `list` answers `ListResult` with page counts | `SirenList`, an array with `estimatedCount` | The existing Node list shape |
| `delete` answers `[]` for a 204 | `null` | An empty object would look like a record |
| A 2xx write answer that is not an object passes through | `UnexpectedResponseError` | Matches `retrieve` and slice 5 |
| `updateDetails` passes `fields` | refused | Cloud reads `fields` on update as the custom-field map, while the site rule checks it as a list of read fields |
| `findByCode` and `forCollaborator` send `number: 1` | also `orderBy: 'dateIssued'` and `order: 'DESC'` | D6 in KB 589. Cloud defaults to that order today |
| `setTrackingCode` refuses only `''` and sends the code as given | trims it, and refuses a code that is empty once trimmed | Every other code method trims |

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
| P10 | four client fields | P3, P6, P8, P9, slice 5 merged | yes |
| P11 | README, CHANGELOG, openapi | P10 | no |

## Tests

One acceptance file per packet, in the integration shape (KB 568): the real
resource over the real `HttpTransport`, with `FakeHttpClient` at the
`HttpClient` seam. `test/record-fakes.ts` holds the transport builder, the
send-once and retry checks, and Cloud's answers, each with the Cloud file it
came from. No test builds a client over the global fetch. P10's test builds
`Siren` with a fake `httpClient` and stubs the global fetch to fail.

Each test is skipped until its packet lands. The surface tests (constant
vocabularies, routes and nested resources) run now. The run folder's
`slices/slice-3-proof` holds the proof: every test unskipped against the
stubs, a scratch implementation that passes them all, and the mutation run.
`scripts/mutations/ncc-slice-3-surface.json` proves the surface tests on this
branch.
