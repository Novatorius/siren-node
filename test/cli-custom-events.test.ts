import { describe, expect, it } from 'vitest';
import { appChanges } from '../src/cli/app-changes';
import { declarationFor, domainProblem, parseAppFile } from '../src/cli/app-file';
import { kindLabel } from '../src/cli/app-kinds';
import type { App, AppItem } from '../src/record-types';

/*
 * Slice C13 (apps-event-tokens): the app file and `siren apps apply` carry a
 * custom event's fields and allowed domains, and a custom event needs no
 * url. Siren's rules for a domain are AllowedDomains::problemWith().
 */

function file(app: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Signups', description: 'Example.', apps: { signups: app } }, null, 2);
}

const signup = { kind: 'customEvent', name: 'Newsletter signup', fields: { list: { type: 'string', required: true } }, domains: ['example.com', '*.example.com'] };

describe('the app file and a custom event', () => {
  it('reads a key-only app with a custom event, and declares its fields and domains', () => {
    const parsed = parseAppFile(file({ name: 'Signups', items: { 'newsletter-signup': signup } }), {});

    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.items).toEqual([{ key: 'newsletter-signup', ...signup }]);
  });

  it('still needs a url for any feature Siren calls', () => {
    const parsed = parseAppFile(file({ name: 'Signups', items: { 'newsletter-signup': signup, notify: { kind: 'postConversionAction', name: 'Tell' } } }), {});

    expect(parsed.problems.map((problem) => problem.path)).toEqual(['apps.signups.items']);
  });

  it('refuses each domain Siren refuses, at its place, without quoting it', () => {
    const domains = ['*', 'https://example.com', 'example.com:8080', '*.com', 'a*.example.com', 'exa_mple.com', 'fine.example.com'];
    const parsed = parseAppFile(file({ name: 'Signups', items: { 'newsletter-signup': { ...signup, domains } } }), {});

    expect(parsed.problems.map((problem) => problem.path)).toEqual([0, 1, 2, 3, 4, 5].map((index) => `apps.signups.items.newsletter-signup.domains.${index}`));
    for (const problem of parsed.problems) expect(problem.message).not.toMatch(/https:|8080|exa_mple/);
  });

  it('refuses fields and domains on any other kind, and more than 20 domains', () => {
    const other = parseAppFile(file({ name: 'S', url: 'https://s.example', items: { notify: { kind: 'postConversionAction', name: 'Tell', domains: ['example.com'], fields: {} } } }), {});
    expect(other.problems.map((problem) => problem.path)).toEqual(['apps.signups.items.notify.fields', 'apps.signups.items.notify.domains']);

    const many = Array.from({ length: 21 }, (_, index) => `s${index}.example.com`);
    const tooMany = parseAppFile(file({ name: 'S', items: { 'newsletter-signup': { ...signup, domains: many } } }), {});
    expect(tooMany.problems.map((problem) => problem.message)).toEqual([expect.stringContaining('at most 20')]);
  });

  it('matches Siren on what a domain may be', () => {
    expect(domainProblem('Shop.Example.com')).toBeNull();
    expect(domainProblem('*.example.co.uk')).toBeNull();
    expect(domainProblem('localhost')).toBeNull();
    expect(domainProblem('*')).not.toBeNull();
    expect(domainProblem('*.example')).not.toBeNull();
  });

  it('names the kind', () => {
    expect(kindLabel('customEvent')).toBe('Custom event (customEvent)');
  });
});

describe('siren apps apply and a custom event', () => {
  function held(domains: string[]): App {
    const item = {
      id: 1,
      ref: 'app:1',
      appId: 1,
      kind: 'customEvent',
      key: 'newsletter-signup',
      name: 'Newsletter signup',
      description: '',
      settings: { fields: { list: { type: 'string', required: true } }, domains },
      status: 'active',
    } as unknown as AppItem;
    return { key: 'signups', name: 'Signups', description: '', url: null, address: null, events: [], scopes: [], apiKey: null, items: [item] } as unknown as App;
  }
  const want = (domains: string[]) => ({
    name: 'Signups',
    items: [{ kind: 'customEvent' as const, key: 'newsletter-signup', name: 'Newsletter signup', fields: { list: { type: 'string', required: true } }, domains }],
  });

  it('lists the domains a new event allows, or that only the server sends it', () => {
    expect(appChanges(undefined, want(['example.com'])).lines).toContain(
      'adds feature newsletter-signup, Custom event (customEvent), named Newsletter signup, allowing example.com',
    );
    expect(appChanges(undefined, want([])).lines).toContain(
      "adds feature newsletter-signup, Custom event (customEvent), named Newsletter signup, from the app's server only",
    );
  });

  it('lists the domains a change adds and removes, and nothing when they match as Siren stores them', () => {
    expect(appChanges(held(['example.com', 'old.example.com']), want(['example.com', '*.example.com'])).lines).toEqual([
      'changes feature newsletter-signup, Custom event (customEvent): allowed domains (adds *.example.com, removes old.example.com)',
    ]);
    expect(appChanges(held(['example.com']), want([' Example.com '])).lines).toEqual([]);
  });
});
