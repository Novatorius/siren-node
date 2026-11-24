import snapshot from './app-kinds.json';

/*
 * Each feature kind as Siren registers it, from app-kinds.json beside this
 * file: Siren's docs/api/app-kinds.json copied byte for byte, which Siren
 * writes from AppItemKindCatalog::catalog() with `composer
 * app-kinds-snapshot` and `GET /apps/kinds` serves (Alex's ruling M104,
 * contract/feature-rename.md, section 7). Copy it again when Siren's
 * changes:
 *
 *     git -C <siren> show <ref>:docs/api/app-kinds.json > src/cli/app-kinds.json
 *
 * test/cli-app-kinds.test.ts holds the copy to Siren's. No name here is
 * typed by hand.
 */

/** One kind: its id, the docs' word for it, its readable name, and whether Siren tells, asks or receives. */
export interface AppKindEntry {
  kind: string;
  term: string;
  name: string;
  description: string;
  mode: 'tell' | 'ask' | 'receive';
  direction: 'out' | 'in';
}

/** Every kind, in the order Siren's "New feature" chooser lists them. */
export const APP_KINDS: readonly AppKindEntry[] = snapshot as AppKindEntry[];

const NAMES: ReadonlyMap<string, string> = new Map(APP_KINDS.map((entry) => [entry.kind, entry.name]));

/**
 * `Attribution model (incentiveResolver)`, or the kind alone when Siren's
 * registry names no such kind, since the tool never invents a name.
 */
export function kindLabel(kind: string): string {
  const name = NAMES.get(kind);
  return name === undefined ? kind : `${name} (${kind})`;
}
