import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { declarationFor, parseAppFile } from '../src/cli/app-file';

/*
 * Slice C6 item 3: the app file follows the app as a container. Contract:
 * docs/architecture/apps-sdk-container.md, "The app file". A `url` is
 * optional, so a file may declare a key-only app. A file with features and
 * no `url` is refused before anything is sent, since Siren asks the app at
 * its address (AppService's `app_items_need_key_and_address` on Siren's
 * int/preview-apps). The payout kind is `payoutMethod`, and a feature's key
 * locks once Siren makes it.
 */

function file(app: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: 'Example.', apps: { 'acme-reports': app } }, null, 2);
}

describe('apps-sdk-container: the app file', () => {
  it('reads a key-only app with no url, and declares it with no url', () => {
    const parsed = parseAppFile(file({ name: 'Reports', scopes: ['records:programs:read'] }), {});
    expect(parsed.problems).toEqual([]);
    const { key, params } = declarationFor(parsed.file!);
    expect(key).toBe('acme-reports');
    expect(params).toEqual({ name: 'Reports', scopes: ['records:programs:read'] });
    expect(params).not.toHaveProperty('url');
  });

  it('refuses features with no url, in plain words at the features', () => {
    const text = file({ name: 'Reports', items: { notify: { kind: 'postConversionAction', name: 'Tell me' } } });
    const parsed = parseAppFile(text, {});
    expect(parsed.file).toBeNull();
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.path).toBe('apps.acme-reports.items');
    expect(parsed.problems[0]?.message).toBe(
      'apps.acme-reports has features and no url. Siren sends a feature its requests at the app\'s address, so add a url, or keep only custom events for a key-only app.',
    );
  });

  it('reads an empty features object with no url as a key-only app', () => {
    const parsed = parseAppFile(file({ name: 'Reports', items: {} }), {});
    expect(parsed.problems).toEqual([]);
  });

  it('accepts payoutMethod, and refuses fulfillmentMethod with a message that names the new word', () => {
    const pay = { kind: 'payoutMethod', name: 'Pay', currencies: ['USD'] };
    expect(parseAppFile(file({ name: 'Pay', url: 'https://acme.example', items: { pay } }), {}).problems).toEqual([]);

    const old = parseAppFile(file({ name: 'Pay', url: 'https://acme.example', items: { pay: { ...pay, kind: 'fulfillmentMethod' } } }), {});
    expect(old.problems.map((problem) => problem.path)).toEqual(['apps.acme-reports.items.pay.kind']);
    expect(old.problems[0]?.message).toBe(
      'apps.acme-reports.items.pay.kind fulfillmentMethod is the old name of this kind. Write payoutMethod, the word Siren and its documentation use.',
    );
  });

  it('lists each kind once when a kind is unknown, and calls them features', () => {
    const parsed = parseAppFile(file({ name: 'Pay', url: 'https://acme.example', items: { pay: { kind: 'other', name: 'Pay' } } }), {});
    expect(parsed.problems[0]?.message).toBe(
      'apps.acme-reports.items.pay.kind must be one of Action after a conversion (postConversionAction), Action after an allocation (postAllocationAction), ' +
        'Payout method (payoutMethod), Distribution resolver (distributionResolver), Custom event (customEvent), ' +
        'Metric calculation (metricCalculation), Customer filter for distributors (metricFilter), Incentive resolver (incentiveResolver), ' +
        'Collaborator group structure (collaboratorGroupStructure).',
    );
  });

  it("refuses the app keys Siren keeps for its own routes", () => {
    for (const reserved of ['requests', 'events', 'scopes', 'kinds']) {
      const text = JSON.stringify({ version: 1, name: 'A', description: '', apps: { [reserved]: { name: 'A' } } });
      const parsed = parseAppFile(text, {});
      expect(parsed.problems.map((problem) => problem.path), reserved).toContain(`apps.${reserved}`);
      expect(parsed.problems[0]?.message).toContain('never requests, events, scopes or kinds');
    }
  });

  it('says feature, never item, in its messages about features', () => {
    const text = file({ name: 'A', url: 'https://acme.example', items: { Bad_Key: { kind: 'postConversionAction', name: 'A', colour: 'red' } } });
    const messages = parseAppFile(text, {}).problems.map((problem) => problem.message.replace(/\bapps\.[^\s]+/g, ''));
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message).not.toMatch(/\bitems?\b/);
    expect(messages.join(' ')).toMatch(/a feature key is lowercase/);
    expect(messages.join(' ')).toMatch(/is not a feature field/);
  });

  it('the file format notes say a feature key locks once Siren makes it', () => {
    const note = readFileSync(new URL('../docs/architecture/apps-cli.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const section = note.slice(note.indexOf('## The app file'), note.indexOf('## The example app'));
    expect(section).toMatch(/A feature's kind and key lock once Siren makes it/);
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const tool = readme.slice(readme.indexOf('## Command-line tool'));
    expect(tool).toMatch(/A feature's kind and key lock once Siren makes it/);
  });
});
