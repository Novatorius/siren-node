import { describe, expect, it } from 'vitest';
import { RESOURCE_COMMANDS } from '../src/cli/resources.generated';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * CLI review round 1, finding C12: through a pipe, standard output holds
 * data and standard error holds the rest, in every record command, and
 * sibling lists print one JSON shape.
 */

const envelope = (items: unknown[]) => ({ items, total: items.length, page: 1, perPage: 10, totalPages: 1 });
const signedIn = (replies: Parameters<typeof harness>[0]) => {
  const h = harness(replies, { env: { TZ: 'UTC' } });
  h.signedIn();
  return h;
};

describe('standard output holds data (C12)', () => {
  const lists = RESOURCE_COMMANDS.filter((resource) => resource.ops.list !== undefined).map((resource) => resource.name);

  it.each(lists)('siren %s list prints a header and rows on standard output, and its count on standard error', async (name) => {
    const h = signedIn([reply(200, envelope([{ id: 1, name: 'One', status: 'active' }])), reply(404, { message: 'Not found.' })]);
    expect(await h.run([name, 'list']), h.err()).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID +NAME +STATUS$/);
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^1 +One +active$/)]);
    expect(h.err()).toMatch(/^1 /);
  });

  it('puts a get record on standard output and Next on standard error', async () => {
    const h = signedIn([reply(200, { id: 1, fullName: 'Ana', status: 'active', programs: [{ id: 4, name: 'Referral' }] })]);
    expect(await h.run(['collaborators', 'get', '1'])).toBe(0);
    expect(h.out()).toContain('collaborator 1 · Ana');
    expect(h.out()).not.toContain('Next');
    expect(h.err()).toContain('Next');
  });

  it('keeps a dry run note and a bulk dry run note off standard output', async () => {
    const h = signedIn([]);
    expect(await h.run(['programs', 'create', '-d', 'name=X', '--dry-run'])).toBe(0);
    expect(h.out()).not.toContain('Nothing was sent');
    expect(await h.run(['conversions', 'bulk', 'approve', '4', '5', '--dry-run'])).toBe(0);
    expect(h.out()).not.toContain('Nothing was sent');
    expect(h.err()).toContain('Nothing was sent.');
  });

  it('prints an empty list as nothing on standard output', async () => {
    const h = signedIn([reply(200, envelope([]))]);
    expect(await h.run(['programs', 'list'])).toBe(0);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('0 programs');
  });
});

describe('sibling lists print one JSON shape (C12)', () => {
  it('prints condition sets in the page envelope enrollers and the record lists print', async () => {
    const h = signedIn([reply(200, [{ id: 1, name: 'New', conditions: [] }]), reply(200, envelope([{ id: 2, name: 'Grow' }]))]);
    expect(await h.run(['condition-sets', 'list', '--json'])).toBe(0);
    const sets = JSON.parse(h.out());
    expect(Object.keys(sets).sort()).toEqual(['items', 'page', 'perPage', 'total', 'totalPages']);
    expect(sets.items[0].id).toBe(1);
  });
});
