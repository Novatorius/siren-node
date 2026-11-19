import { describe, expect, it } from 'vitest';
import { appChanges } from '../src/cli/app-changes';
import { MAX_CONTACTS, declarationFor, parseAppFile, storedContacts } from '../src/cli/app-file';
import { AppsResource } from '../src/resources/apps';
import type { App } from '../src/record-types';

/*
 * Slice C17 on Siren: an app's problem contacts, the email addresses Siren
 * tells when something is wrong with the app. The app file names them as
 * `contacts`, `siren apps apply` sends them with `PUT /apps/{key}`, and a
 * file that leaves them out keeps the contacts the app has.
 */

function file(app: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: 'Example.', apps: { acme: { name: 'Acme', ...app } } }, null, 2);
}

function held(contacts: string[] | undefined): App {
  return {
    id: 1,
    key: 'acme',
    name: 'Acme',
    description: '',
    status: 'active',
    source: 'code',
    url: null,
    events: [],
    scopes: [],
    ...(contacts === undefined ? {} : { contacts }),
    apiKeyPrefix: null,
    apiKey: null,
    address: null,
    items: [],
    eventsAccess: { entitled: true, requiredCapability: null, requiredPlan: null },
    needsAttention: 0,
  };
}

describe('apps-cli: problem contacts in the app file', () => {
  it('reads contacts and sends them as Siren stores them, each once and lowercased', () => {
    const parsed = parseAppFile(file({ contacts: ['Ops@Example.com', ' ops@example.com', 'dev@example.com'] }), {});
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.contacts).toEqual(['ops@example.com', 'dev@example.com']);
  });

  it('leaves contacts out of the declaration when the file names none, so Siren keeps the app\'s own', () => {
    const parsed = parseAppFile(file({}), {});
    expect(declarationFor(parsed.file!).params).not.toHaveProperty('contacts');
  });

  it('refuses contacts that are not a list of email addresses, at their key', () => {
    const notList = parseAppFile(file({ contacts: 'ops@example.com' }), {});
    expect(notList.problems.map((problem) => problem.path)).toEqual(['apps.acme.contacts']);

    const bad = parseAppFile(file({ contacts: ['ops@example.com', 'not an address'] }), {});
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toMatchObject({ path: 'apps.acme.contacts.1', message: 'apps.acme.contacts.1 is not an email address.' });
  });

  it('refuses more than ten contacts, counting a repeat once', () => {
    const ten = Array.from({ length: MAX_CONTACTS }, (_, n) => `person${n}@example.com`);
    expect(parseAppFile(file({ contacts: [...ten, 'PERSON0@example.com'] }), {}).problems).toEqual([]);
    const tooMany = parseAppFile(file({ contacts: [...ten, 'one-more@example.com'] }), {});
    expect(tooMany.problems.map((problem) => problem.path)).toEqual(['apps.acme.contacts']);
  });

  it('shows a change to the contacts only when the file names them', () => {
    expect(appChanges(held(['ops@example.com']), { name: 'Acme' }).lines).toEqual([]);
    expect(appChanges(held(['ops@example.com']), { name: 'Acme', contacts: ['OPS@example.com'] }).lines).toEqual([]);
    expect(appChanges(held(['ops@example.com']), { name: 'Acme', contacts: ['dev@example.com'] }).lines).toEqual([
      'problem contacts: adds dev@example.com, removes ops@example.com',
    ]);
    expect(appChanges(held(undefined), { name: 'Acme', contacts: ['dev@example.com'] }).lines).toEqual(['problem contacts: adds dev@example.com']);
  });

  it('lets apps.declare(), create() and update() send contacts', () => {
    expect(AppsResource.DECLARE_FIELDS).toContain('contacts');
    expect(AppsResource.CREATE_FIELDS).toContain('contacts');
    expect(AppsResource.UPDATE_FIELDS).toContain('contacts');
    expect(storedContacts([' A@B.co ', '', 'a@b.co'])).toEqual(['a@b.co']);
  });
});
