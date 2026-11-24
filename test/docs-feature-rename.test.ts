import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Alex's ruling M104 (contract/feature-rename.md in the apps run folder):
 * Siren calls a feature a feature everywhere a developer looks. The README,
 * openapi.yaml and the CHANGELOG follow the SDK's names, and no old name is
 * left for a reader to copy.
 */

function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

const OLD_NAMES = ['AppItem', 'apps.items', 'request.item', 'item.kind', 'item.key', '/items', 'app_items_need_key_and_address', 'ItemsNeedKeyAndAddress', 'appItemId'];

describe('feature rename: the docs use the new names', () => {
  it('leaves no old name in the README', () => {
    const readme = raw('README.md');
    for (const old of OLD_NAMES) expect(readme, old).not.toContain(old);
    expect(readme).not.toContain('The code calls a feature an item');
  });

  it('names the new calls, the envelope field and the error code in the README', () => {
    const readme = flat(raw('README.md'));
    for (const name of ['`FeatureKind`', 'siren.apps.features.create()', 'request.feature.kind', '`app_features_need_key_and_address`']) {
      expect(readme, name).toContain(name);
    }
  });

  it('gives openapi.yaml the feature routes, the features field and the renamed code', () => {
    const spec = raw('openapi.yaml');
    for (const old of OLD_NAMES) expect(spec, old).not.toContain(old);
    for (const path of ['/apps/{key}/features:', '/apps/{key}/features/{id}:']) expect(spec, path).toContain(path);
    expect(spec).toContain('app_features_need_key_and_address');
    expect(spec).toMatch(/\n {8}features:\n/);
  });

  it('records the rename under Breaking in the CHANGELOG', () => {
    const changelog = flat(raw('CHANGELOG.md'));
    const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('## [', changelog.indexOf('## [Unreleased]') + 5));
    const breaking = unreleased.slice(unreleased.indexOf('### Breaking'));
    for (const words of ['`FeatureKind`', '`siren.apps.features`', '`request.feature`', '`/apps/{app}/features`', '`app_features_need_key_and_address`', '`AppFeature', 'src/app-kinds.json']) {
      expect(breaking, words).toContain(words);
    }
  });
});
