import APP_KINDS from '../app-kinds.json';
import type { AppFeatureFunctions } from '../record-types';

/** One kind as Siren's registry snapshot holds it. */
interface SnapshotKind {
  kind: string;
  term: string;
  name: string;
  description: string;
  mode: 'tell' | 'ask' | 'receive';
  direction: 'out' | 'in';
}

/*
 * The kinds of feature Siren sends an app a request for, and the check
 * `answers.on()` runs on a kind when the function is registered, so a typo
 * fails at once rather than as a 404 on every request for hours.
 */

/**
 * Each kind Siren sends a request for, with the name Siren's screens show:
 * every kind Siren's registry snapshot (src/app-kinds.json, Siren's
 * docs/api/app-kinds.json copied byte for byte) marks `tell` or `ask`. That
 * leaves out `customEvent`, which Siren receives and never sends. Siren's
 * contract file, test/fixtures/apps-feature-contracts/requests.json, holds
 * one request of each, and test/apps-dx-kinds.test.ts holds this list equal
 * to it. The PHP and Python SDKs read the same snapshot.
 */
export const FEATURE_KIND_NAMES: Readonly<Record<keyof AppFeatureFunctions, string>> = Object.fromEntries(
  (APP_KINDS as readonly SnapshotKind[]).filter((entry) => entry.mode === 'tell' || entry.mode === 'ask').map((entry) => [entry.kind, entry.name]),
) as Record<keyof AppFeatureFunctions, string>;

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
    return `The kind for ${name} is ${known}.`;
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
