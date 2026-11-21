/*
 * The readable name of each feature kind, shown beside the word the code
 * and the app file use, as "Payout method (payoutMethod)". The founder's
 * rulings AP-R39 and AP-R40: the technical term sits beside the readable
 * name, and the names match the docs. The names are `name` in Siren's
 * AppItemKindCatalog::entries() (lib/Apps/Core/Enums/AppItemKindCatalog.php
 * lines 189, 199, 209 and 228 on Siren's feat/apps at c8dbb1ab3), the same
 * catalog `GET /apps/kinds` serves. The two metric kinds' names are the ones
 * Siren's catalog gains in slice C16-1, and the incentive resolver's name the
 * one it gains in slice C16-2, the two engagement kinds' the ones it
 * gains in slice C16-4, and the program group structure's the one it
 * gains in slice C16-5. The tool reads no catalog in `show`,
 * `list` or `apply`, so it holds this copy, and a test pins it to Siren's.
 */

const KIND_NAMES: Readonly<Record<string, string>> = {
  postConversionAction: 'Action after a conversion',
  postAllocationAction: 'Action after an allocation',
  payoutMethod: 'Payout method',
  distributionResolver: 'Distribution resolver',
  customEvent: 'Custom event',
  metricCalculation: 'Metric calculation',
  metricFilter: 'Customer filter for distributors',
  incentiveResolver: 'Incentive resolver',
  engagementCalculation: 'Engagement calculation',
  engagementFilter: 'Customer filter for programs',
  programGroupSorter: 'Program group structure',
};

/**
 * `Payout method (payoutMethod)`, or the kind alone when Siren's catalog
 * names no such kind, since the tool never invents a name.
 */
export function kindLabel(kind: string): string {
  const name = Object.prototype.hasOwnProperty.call(KIND_NAMES, kind) ? KIND_NAMES[kind] : undefined;
  return name === undefined ? kind : `${name} (${kind})`;
}
