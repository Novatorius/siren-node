import type { AppFeatureFunctions } from '../record-types';

/*
 * The kinds of feature Siren sends an app a request for, and the check
 * `answers.on()` runs on a kind when the function is registered, so a typo
 * fails at once rather than as a 404 on every request for hours.
 */

/**
 * Each kind Siren sends a request for, with the name the dashboard shows:
 * every kind of APP_KINDS on Siren's feat/apps at 6d2abd936a
 * (frontend/src/platform/saas/apps/apps.ts) except `customEvent`, which
 * Siren never sends. Siren's contract file,
 * test/fixtures/apps-feature-contracts/requests.json, holds one request of
 * each, and test/apps-dx-kinds.test.ts holds this list equal to it and to
 * the CLI's names. The PHP and Python SDKs hold the same list.
 */
export const FEATURE_KIND_NAMES: Readonly<Record<keyof AppFeatureFunctions, string>> = {
  postConversionAction: 'Post-conversion action',
  postAllocationAction: 'Post-allocation action',
  payoutMethod: 'Payout method',
  distributionResolver: 'Distribution resolver',
  incentiveResolver: 'Attribution model',
  incentiveType: 'Incentive structure',
  metricCalculation: 'Metric calculation',
  metricFilter: 'Customer filter for distributors',
  transactionFilter: 'Transaction filter',
  engagementCalculation: 'Engagement calculation',
  engagementFilter: 'Customer filter for programs',
  programGroupSorter: 'Program group structure',
  collaboratorGroupStructure: 'Collaborator group structure',
};

const KINDS: readonly string[] = Object.keys(FEATURE_KIND_NAMES);

/** The payout kind's old name, which Siren refuses. */
const OLD_PAYOUT_KIND = 'fulfillmentMethod';

/**
 * Why `on()` refuses `kind`, in words that say what to write instead, or
 * undefined when it is a kind Siren sends or one `extra` names. The first
 * rule that fits gives the words.
 */
export function featureKindProblem(kind: string, extra: ReadonlySet<string>): string | undefined {
  if (KINDS.includes(kind) || extra.has(kind)) return undefined;
  if (kind === OLD_PAYOUT_KIND) return `${OLD_PAYOUT_KIND} is the old name. Use payoutMethod.`;
  if (kind === 'customEvent') return 'Siren never sends a custom event. Your app sends one with events.ingest().';
  if (kind.includes('.')) return `${kind} is a webhook event. Register it with onEvent().`;

  if (kind.includes('_')) {
    const camel = kind.toLowerCase().replace(/_+([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
    if (KINDS.includes(camel)) return `Kinds are camelCase, as Siren sends them: ${camel}.`;
  }

  const loose = squash(kind);
  const sameLetters = KINDS.find((known) => squash(known) === loose);
  if (sameLetters !== undefined) return `${kind} is not a feature kind. Did you mean ${sameLetters}?`;

  const named = (Object.entries(FEATURE_KIND_NAMES) as Array<[string, string]>).find(([, name]) => squash(name) === loose);
  if (named !== undefined) {
    const [known, name] = named;
    return name.endsWith('s') ? `The kind for ${name} is ${known}.` : `${name}'s kind is ${known}.`;
  }

  const near = KINDS.map((known) => [known, distance(kind, known)] as const)
    .filter(([, steps]) => steps <= 2)
    .sort((a, b) => a[1] - b[1])[0];
  if (near !== undefined) return `${kind} is not a feature kind. Did you mean ${near[0]}?`;

  return `${kind} is not a feature kind. The kinds are: ${KINDS.join(', ')}. Pass a kind newer than this SDK in the extraKinds option.`;
}

/** The name in lower case without spaces, `_` or `-`, so `Attribution model` and `attributionModel` match. */
function squash(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/** The Levenshtein distance between two names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
