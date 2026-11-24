import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { specServes } from './spec-routes';

/*
 * Alex's ruling M104 (contract/feature-rename.md in the apps run folder):
 * Siren calls a feature a feature everywhere a developer looks. The README
 * and the CHANGELOG follow the SDK's names, and no old name is
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

  // Siren serves /apps/{app}/items until its own rename (pkt/apps-feature-rename)
  // merges. openapi.json is a copy of Siren's spec, so it names the route
  // Siren has. test/openapi-sdk-routes.test.ts lists the SDK's /features
  // calls as unserved until then, and fails once they are served.
  it("has openapi.json name the feature routes under one name, the one Siren serves", () => {
    const features = specServes('post', '/apps/{key}/features') && specServes('get', '/apps/{key}/features/{id}');
    const items = specServes('post', '/apps/{key}/items') && specServes('get', '/apps/{key}/items/{id}');
    expect(features !== items).toBe(true);
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
