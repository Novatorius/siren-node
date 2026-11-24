/*
 * The readable name of each feature kind, shown beside the word the code
 * and the app file use, as "Payout method (payoutMethod)". The founder's
 * rulings AP-R39 and AP-R40: the technical term sits beside the readable
 * name, and the names match the docs and the dashboard. The names are
 * `name` in Siren's AppItemKindCatalog::entries() and APP_KINDS (with
 * CUSTOM_EVENT_KIND_INFO) in frontend/src/platform/saas/apps/apps.ts, on
 * Siren's feat/apps at 6d2abd936a, the same catalog `GET /apps/kinds`
 * serves. The README's Feature kinds headings use the same names. The tool
 * reads no catalog in `show`, `list` or `apply`, so it holds this copy, and
 * test/cli-apps-container-review.test.ts pins it to Siren's.
 */

const KIND_NAMES: Readonly<Record<string, string>> = {
  postConversionAction: 'Post-conversion action',
  postAllocationAction: 'Post-allocation action',
  payoutMethod: 'Payout method',
  distributionResolver: 'Distribution resolver',
  customEvent: 'Custom event',
  metricCalculation: 'Metric calculation',
  metricFilter: 'Customer filter for distributors',
  incentiveResolver: 'Attribution model',
  incentiveType: 'Incentive structure',
  engagementCalculation: 'Engagement calculation',
  engagementFilter: 'Customer filter for programs',
  programGroupSorter: 'Program group structure',
  transactionFilter: 'Transaction filter',
  collaboratorGroupStructure: 'Collaborator group structure',
};

/**
 * `Payout method (payoutMethod)`, or the kind alone when Siren's catalog
 * names no such kind, since the tool never invents a name.
 */
export function kindLabel(kind: string): string {
  const name = Object.prototype.hasOwnProperty.call(KIND_NAMES, kind) ? KIND_NAMES[kind] : undefined;
  return name === undefined ? kind : `${name} (${kind})`;
}
