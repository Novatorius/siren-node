import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_KINDS, kindLabel } from '../src/cli/app-kinds';
import { KINDS } from '../src/cli/app-file';

/*
 * Alex's ruling M104: the tool's kind names come from Siren's registry
 * snapshot, docs/api/app-kinds.json, which Siren writes from
 * AppItemKindCatalog::catalog() (contract/feature-rename.md, section 7).
 * src/cli/app-kinds.json is that file copied byte for byte.
 *
 * The first describe runs everywhere. The last test reads Siren's copy from
 * the checkout named by SIREN_CHECKOUT with `git show`, at SIREN_KINDS_REF
 * or else Siren's pkt/apps-feature-rename, and is skipped when
 * SIREN_CHECKOUT is unset, since this repository holds no copy of Siren.
 */

const SNAPSHOT = readFileSync(new URL('../src/cli/app-kinds.json', import.meta.url), 'utf8');
const FIELDS = ['kind', 'term', 'name', 'description', 'mode', 'direction'];

describe("feature rename: the kind names are Siren's registry snapshot", () => {
  it('holds the snapshot in the form Siren writes it: 14 kinds, six fields in order, four-space indent and a trailing newline', () => {
    const parsed = JSON.parse(SNAPSHOT) as Record<string, string>[];
    expect(parsed).toHaveLength(14);
    for (const entry of parsed) expect(Object.keys(entry)).toEqual(FIELDS);
    expect(SNAPSHOT).toBe(`${JSON.stringify(parsed, null, 4)}\n`);
  });

  it('serves the snapshot unchanged to the code that names kinds', () => {
    expect(APP_KINDS).toEqual(JSON.parse(SNAPSHOT));
  });

  it("labels each kind {name} ({kind}) from the snapshot, and a kind the snapshot lacks with its id alone", () => {
    expect(kindLabel('incentiveResolver')).toBe('Attribution model (incentiveResolver)');
    for (const entry of APP_KINDS) expect(kindLabel(entry.kind)).toBe(`${entry.name} (${entry.kind})`);
    expect(kindLabel('futureKind')).toBe('futureKind');
  });

  it('knows the same kinds the app file accepts', () => {
    expect([...KINDS].sort()).toEqual(APP_KINDS.map((entry) => entry.kind).sort());
  });

  it.skipIf(process.env.SIREN_CHECKOUT === undefined)("matches Siren's docs/api/app-kinds.json byte for byte", () => {
    const ref = process.env.SIREN_KINDS_REF ?? 'pkt/apps-feature-rename';
    const siren = execFileSync('git', ['-C', process.env.SIREN_CHECKOUT ?? '', 'show', `${ref}:docs/api/app-kinds.json`]);
    expect(Buffer.compare(siren, readFileSync(new URL('../src/cli/app-kinds.json', import.meta.url)))).toBe(0);
  });
});
