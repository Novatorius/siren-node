import { describe, expect, it } from 'vitest';
import { appFileSchema } from '../src/cli/app-file-schema';
import { appFileTemplate, parseAppFile } from '../src/cli/app-file';
import { harness } from './cli-fakes';

/*
 * Alex's ruling M104, "item" becomes "feature" in every public name.
 * Contract: contract/feature-rename.md in the run folder, section 4, for
 * siren.app.json and its schema.
 */

const ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const file = (app: Record<string, unknown>) => JSON.stringify({ version: 1, apps: { 'acme-payouts': { name: 'Acme', url: '${SIREN_APP_URL}', ...app } } });
const paths = (text: string) => parseAppFile(text, ENV).problems.map((problem) => problem.path);
const messages = (text: string) => parseAppFile(text, ENV).problems.map((problem) => problem.message);

describe('feature rename: siren.app.json says features', () => {
  it('reads an app\'s features under features, with problem paths that say features', () => {
    expect(parseAppFile(file({ features: { notify: { kind: 'postConversionAction', name: 'N' } } }), ENV).problems).toEqual([]);
    expect(paths(file({ features: { notify: { kind: 'webhook', name: 'N' } } }))).toContain('apps.acme-payouts.features.notify.kind');
    expect(messages(file({ features: [] }))).toContain('apps.acme-payouts.features must be an object that holds each feature under its feature key.');
  });

  it('refuses items with a line that says to write features, so an old file never declares an app with none', () => {
    expect(messages(file({ items: { notify: { kind: 'postConversionAction', name: 'N' } } }))).toContain(
      'apps.acme-payouts.items: Siren calls an app\'s features "features" now. Write them under features.',
    );
  });

  it('refuses more than 50 features, as Siren does', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, { kind: 'postConversionAction', name: `F${i}` }]));
    expect(messages(file({ features: many }))).toContain('apps.acme-payouts.features holds 51 features, and an app may hold at most 50.');
  });

  it('writes features in the init template and says so', async () => {
    expect(Object.keys(JSON.parse(appFileTemplate('acme-payouts', 'Acme')).apps['acme-payouts'])).toContain('features');
    expect(appFileTemplate('acme-payouts', 'Acme')).not.toContain('"items"');
    const h = harness([]);
    await h.run(['apps', 'init', '--key', 'acme-payouts']);
    expect(h.out()).toContain('Add features in siren.app.json.');
  });

  it('names features, never items, in the schema', () => {
    const app = (appFileSchema() as any).properties.apps.additionalProperties;
    expect(Object.keys(app.properties)).toContain('features');
    expect(Object.keys(app.properties)).not.toContain('items');
    expect(app.properties.features.maxProperties).toBe(50);
  });
});
