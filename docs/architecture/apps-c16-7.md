# Slice C16-7 in the Node SDK: collaborator group structures

Siren's slice C16-7 lets an app give a collaborator group its structure. A
group that picks the app's feature gets asked once per cascade trigger on the
group, for a program (an engagement cascade) or a distributor (a metric
cascade). The app answers the group's shape among the members in the
question, as a chain or a tree. The SDK learns the kind, its readable name,
the typed shape of its ask and answer, and the typing of
`apps.requestHandler().on()` for it. No call or route changes.

Read: the slice's contract for the question and the answer rules, and the
Node commits for slices C16-1 (2dc9a86) and C16-2 (e8cadc2), which this
slice copies file for file. The PHP and Python SDKs gain the same kind on
their own pkt/apps-c16-7 branches.

## What changes

| Part | File | Change |
|---|---|---|
| `FeatureKind.CollaboratorGroupStructure` | src/taxonomy.ts | The value `collaboratorGroupStructure`. |
| Readable name | src/cli/app-kinds.ts | Collaborator group structure. |
| Question types | src/record-types.ts | `AppCollaboratorGroupStructureQuestion`, `AppCollaboratorGroupStructureDistributorQuestion`, `AppCollaboratorGroupStructureProgramQuestion`, `AppCollaboratorGroupMember`. |
| Answer types | src/record-types.ts | `AppCollaboratorGroupChain`, `AppCollaboratorGroupTree` and their union `AppCollaboratorGroupStructureAnswer`. |
| `AppFeatureFunctions` | src/record-types.ts | `on('collaboratorGroupStructure', ...)` gets `AppAsk<AppCollaboratorGroupStructureQuestion>` and returns the answer. |
| `AppFeatureDeclaration` | openapi.yaml | The kind `collaboratorGroupStructure`. |

## The question

Every ask carries `group`, `members` (each with `collaboratorId`, `name` and
`metadata`), `for` (`program` or `distributor` and an id),
`triggeringCollaborator` and `cause`, whose `id` is 16 hex characters, the
trigger's own random id. The ask also carries the fields of the trigger it
interrupts, which differ by side, so the question type keeps an open index
signature. A distributor's ask carries a metric calculation's fields
(`distributor`, `distribution`, `metricType`, `distributorMetricTypeId`,
`opportunityId`, `points`, `sale`) and a metric's `cause`, which
`AppCollaboratorGroupStructureDistributorQuestion` types. A program's ask
carries an engagement calculation's fields (`program`, `engagementType`,
`programEngagementTypeId`, `args`, `opportunity`) and an engagement's `cause`,
which `AppCollaboratorGroupStructureProgramQuestion` types.

## Rules

- The kind needs the app's url, as every kind but a custom event does. It
  takes the answer window and no other setting.
- `apps.verifyRequest()`, `apps.requestHandler()` and
  `apps.requests.answer()` serve every kind and do not change. The SDK
  checks only what it checks for any answer: an object with a text
  `outcome`, at most 16384 bytes. Siren checks the rest and refuses a bad
  answer with 422 `app_answer_invalid`: a chain whose `order` does not list
  every member once, or a tree whose `parents` does not hold every member
  once as a key, names a parent outside the group, or makes a cycle.

## Tests

test/apps-collaborator-group-structure.test.ts covers the kind, its name,
the app file's declaration, a feature with no url, a chain and a tree sent
through `apps.requestHandler()` with the typed `on()`, two `@ts-expect-error`
lines for answers of the wrong shape, and both answers through the answer
route by hand. The kind-list tests in test/cli-app-file-container.test.ts and
test/cli-apps-container-review.test.ts name the kind.

## Left open

Siren's catalog fixtures for `GET /apps/kinds` are not generated, so the
name here is pinned by hand until the server half lands.
