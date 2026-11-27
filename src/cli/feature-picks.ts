import type { AppFeature } from '../record-types';

/**
 * Where an organization picks each feature kind, and the recipe field that
 * picks it, so `apps apply` can say what makes a new feature fire (review
 * round 1, C3). Siren calls a feature only for a record that selects its
 * `app:{id}`: a post-conversion action does nothing until a program lists
 * it. `field` is the recipe's key on that record (lib/Recipes/Core/
 * recipe.schema.json) and `value` the shape it takes there, given only
 * where the schema says plainly how a ref goes in.
 */
const PICKS: Record<string, { on: string; field?: string; value?: (ref: string) => string }> = {
  postConversionAction: { on: 'a program', field: 'postConversionActions', value: (ref) => `[{"type":"${ref}"}]` },
  postAllocationAction: { on: 'a distributor', field: 'postAllocationActions', value: (ref) => `[{"type":"${ref}"}]` },
  payoutMethod: { on: 'an autofulfiller', field: 'method', value: (ref) => `"${ref}"` },
  distributionResolver: { on: 'a distributor', field: 'distributionResolver', value: (ref) => `"${ref}"` },
  incentiveResolver: { on: 'a program', field: 'incentiveResolverType', value: (ref) => `"${ref}"` },
  incentiveType: { on: 'a program', field: 'incentiveType', value: (ref) => `"${ref}"` },
  engagementFilter: { on: 'a program', field: 'engagementFilters', value: (ref) => `["${ref}"]` },
  metricFilter: { on: 'a distributor', field: 'metricFilters', value: (ref) => `["${ref}"]` },
  programGroupSorter: { on: 'a program group', field: 'sorter', value: (ref) => `"${ref}"` },
  collaboratorGroupStructure: { on: 'a collaborator group', field: 'structure', value: (ref) => `"${ref}"` },
  engagementCalculation: { on: "a program's engagement type" },
  metricCalculation: { on: "a distributor's metric type" },
  transactionFilter: { on: 'a program or a distributor' },
  customEvent: { on: 'a program or a distributor' },
};

/** How many records select `item`, from `usedBy` or `uses` as `GET /apps/{key}` answers them, and 0 for a feature Siren just made. */
export function recordsPicking(item: AppFeature | undefined): number {
  if (item === undefined) return 0;
  if (Array.isArray(item.usedBy)) return item.usedBy.length;
  const uses = typeof item.uses === 'number' ? item.uses : 0;
  const open = typeof item.openRequests === 'number' ? item.openRequests : 0;
  return Math.max(0, uses - open);
}

/**
 * The line that says an active feature no record picks yet never fires,
 * and how to pick it, or undefined for a kind the tool knows no picker for.
 * A custom event is sent by the app, so it waits on nothing Siren calls.
 */
export function unpickedLine(item: AppFeature): string | undefined {
  const pick = PICKS[item.kind];
  if (pick === undefined) return undefined;
  const who = pick.on.replace(/^(a|an) /, '');
  if (item.kind === 'customEvent') {
    return `No ${who} listens to ${item.key} yet, so its events earn nothing. Pick it on ${pick.on} in the dashboard.`;
  }
  // Compact, with no space, so a wrapped line never splits the snippet a person copies.
  const recipe = pick.field !== undefined && pick.value !== undefined ? `, or in a recipe with "${pick.field}":${pick.value(item.ref)}` : '';
  return `No ${who} picks ${item.key} yet, so Siren never sends it. Pick it on ${pick.on} in the dashboard${recipe}.`;
}
