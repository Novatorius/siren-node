import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURE_KIND_NAMES } from '../src/resources/app-feature-kinds';
import { FeatureKind } from '../src/index';

/*
 * Alex's ruling M104 (contract/feature-rename.md, section 7, in the apps run
 * folder): kinds keep their ids, and their names come from Siren's registry.
 * src/app-kinds.json is Siren's docs/api/app-kinds.json copied byte for byte
 * by scripts/siren-fixtures.mjs, and src/feature-kind.ts is generated from it
 * by scripts/feature-kind.mjs, so each FeatureKind member's hover docs carry
 * Siren's name for it.
 *
 * The byte test reads Siren's copy from the file SIREN_APP_KINDS names, and
 * skips without it, since CI has no Siren checkout. The rest always run.
 */

const SNAPSHOT_URL = new URL('../src/app-kinds.json', import.meta.url);
const SNAPSHOT = readFileSync(SNAPSHOT_URL, 'utf8');
const FIELDS = ['kind', 'term', 'name', 'description', 'mode', 'direction'];

interface KindEntry {
  kind: string;
  term: string;
  name: string;
  description: string;
  mode: string;
  direction: string;
}
const ENTRIES = JSON.parse(SNAPSHOT) as KindEntry[];
const SIREN_APP_KINDS = process.env.SIREN_APP_KINDS;

describe("feature rename: the kinds are Siren's registry snapshot", () => {
  it.skipIf(SIREN_APP_KINDS === undefined || SIREN_APP_KINDS === '')(
    "ships Siren's docs/api/app-kinds.json byte for byte (skipped unless SIREN_APP_KINDS names Siren's copy)",
    () => {
      expect(readFileSync(SNAPSHOT_URL).equals(readFileSync(SIREN_APP_KINDS!))).toBe(true);
    },
  );

  it('holds the snapshot in the form Siren writes it: 14 kinds, six fields in order, four-space indent and a trailing newline', () => {
    expect(ENTRIES).toHaveLength(14);
    for (const entry of ENTRIES) {
      expect(Object.keys(entry)).toEqual(FIELDS);
      expect(['tell', 'ask', 'receive']).toContain(entry.mode);
      expect(['out', 'in']).toContain(entry.direction);
    }
    expect(SNAPSHOT.endsWith('}\n]\n')).toBe(true);
    expect(SNAPSHOT).toBe(`${JSON.stringify(ENTRIES, null, 4)}\n`);
  });

  it('makes FeatureKind from the snapshot: every kind, in order, and no old name', () => {
    expect(Object.values(FeatureKind)).toEqual(ENTRIES.map((entry) => entry.kind));
    for (const [member, kind] of Object.entries(FeatureKind)) expect(member).toBe(kind.charAt(0).toUpperCase() + kind.slice(1));
    expect(Object.values(FeatureKind)).not.toContain('fulfillmentMethod');
  });

  it("puts each kind's name, and its term where the term differs, in the member's doc comment", () => {
    const source = readFileSync(new URL('../src/feature-kind.ts', import.meta.url), 'utf8');
    for (const entry of ENTRIES) {
      const member = `${entry.kind.charAt(0).toUpperCase()}${entry.kind.slice(1)}: '${entry.kind}',`;
      const end = source.indexOf(member);
      expect(end, entry.kind).toBeGreaterThan(0);
      const comment = source.slice(source.lastIndexOf('/**', end), end);
      const termDiffers = entry.term.toLowerCase() !== entry.name.toLowerCase();
      expect(comment, entry.kind).toContain(termDiffers ? `* ${entry.name}. Siren's code calls it the ${entry.term}.` : `* ${entry.name}.\n`);
    }
  });

  it('is what scripts/feature-kind.mjs writes from the snapshot, so a new snapshot fails until it runs again', () => {
    const run = () => execFileSync(process.execPath, ['scripts/feature-kind.mjs', '--check'], { encoding: 'utf8', stdio: 'pipe' });
    expect(run()).toContain('OK');
  });

  it('takes every kind Siren tells or asks in on(), with its name, and nothing else', () => {
    const sent = ENTRIES.filter((entry) => entry.mode === 'tell' || entry.mode === 'ask');
    expect(sent).toHaveLength(13);
    expect(FEATURE_KIND_NAMES).toEqual(Object.fromEntries(sent.map((entry) => [entry.kind, entry.name])));
  });
});
