import { describe, expect, it } from 'vitest';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * CLI review round 1, findings C13, C25 and C26: the default columns of a
 * record list, its headers in words with the zone of its times, and the
 * same order for a generated list and a raw get of its route.
 */

const envelope = (items: unknown[]) => ({ items, total: items.length, page: 1, perPage: 10, totalPages: 1 });
const asked = (h: ReturnType<typeof harness>, at = 0) => new URL(h.http.requests[at]!.url).searchParams;
const signedIn = (replies: Parameters<typeof harness>[0]) => {
  const h = harness(replies, { env: { TZ: 'UTC' } });
  h.signedIn();
  return h;
};
const AT = '2025-03-02T09:20:41+00:00';

describe('default columns (C13)', () => {
  it('asks Siren for a transaction total and currency and shows them', async () => {
    const h = signedIn([reply(200, envelope([{ id: 9, status: 'complete', totalValue: 4200, currency: 'USD', dateCreated: AT }])), reply(404, { message: 'Not found.' })]);
    expect(await h.run(['transactions', 'list']), h.err()).toBe(0);
    expect(asked(h).get('fields')?.split(',')).toEqual(expect.arrayContaining(['totalValue', 'currency']));
    expect(h.out().split('\n')[0]).toBe('ID  STATUS    AMOUNT  CURRENCY  CREATED (UTC)');
    expect(h.out()).toMatch(/^9 +complete +4200 +USD +Mar 2, 2025$/m);
  });

  it('asks for a conversion program id, so --json carries it', async () => {
    const h = signedIn([reply(200, envelope([{ id: 5, status: 'pending', programId: 3, programName: 'Referral' }]))]);
    expect(await h.run(['conversions', 'list', '--json']), h.err()).toBe(0);
    expect(asked(h).get('fields')?.split(',')).toEqual(expect.arrayContaining(['programId', 'programName', 'collaboratorName', 'amount']));
    expect(JSON.parse(h.out()).items[0].programId).toBe(3);
  });

  it("shows an obligation's collaborator by name", async () => {
    const h = signedIn([reply(200, envelope([{ id: 7, collaboratorId: 2, collaboratorName: 'Ana Ruiz', status: 'approved', dateCreated: AT }]))]);
    expect(await h.run(['obligations', 'list']), h.err()).toBe(0);
    expect(asked(h).get('fields')?.split(',')).toContain('collaboratorName');
    expect(h.out().split('\n')[0]).toBe('ID  STATUS    COLLABORATOR  CREATED (UTC)');
    expect(h.out()).toContain('Ana Ruiz');
  });

  it("shows a collaborator's email beside the name", async () => {
    const h = signedIn([reply(200, envelope([{ id: 1, status: 'active', fullName: 'Ana Ruiz', nickname: 'ana', email: 'ana@example.com', createdDate: AT }]))]);
    expect(await h.run(['collaborators', 'list']), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe('ID  NAME      EMAIL            STATUS  CREATED (UTC)');
    expect(h.out()).toMatch(/^1 +Ana Ruiz +ana@example\.com +active +Mar 2, 2025$/m);
  });

  it('asks for the defaults and the --fields named, and keeps the table to the named ones', async () => {
    const h = signedIn([reply(200, envelope([{ id: 1, status: 'active', fullName: 'Ana Ruiz', email: 'ana@example.com', referralCode: 'ANA' }]))]);
    expect(await h.run(['collaborators', 'list', '--fields', 'email,referralCode']), h.err()).toBe(0);
    expect(asked(h).get('fields')?.split(',')).toEqual(expect.arrayContaining(['id', 'email', 'referralCode']));
    expect(h.out()).toBe('EMAIL            REFERRAL CODE\nana@example.com  ANA\n');
  });
});

describe('--fields with a typo (C10)', () => {
  it('names the real fields and suggests the near one', async () => {
    const h = signedIn([reply(200, envelope([{ id: 1, status: 'active', fullName: 'Ana Ruiz', nickname: 'ana', email: 'ana@example.com', createdDate: AT, modifiedDate: AT }]))]);
    expect(await h.run(['collaborators', 'list', '--fields', 'id,emial'])).toBe(2);
    const said = h.err().replace(/\s+/g, ' ');
    expect(said).toContain("emial isn't a field of these records. They have id, status, fullName, nickname, email, createdDate, modifiedDate.");
    expect(said).toContain('Did you mean --fields id,email?');
  });
});

describe('headers and zones (C25)', () => {
  it('names a column in words and a time column with its zone', async () => {
    const h = harness([reply(200, envelope([{ id: 1, status: 'active', fullName: 'Ana', createdDate: AT }]))], { env: { TZ: 'America/New_York' } });
    h.signedIn();
    expect(await h.run(['collaborators', 'list']), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe('ID  NAME  STATUS  CREATED (EST)');
    expect(h.out()).toContain('Mar 2, 2025');
  });

  it('names the zone after a time in a record view', async () => {
    const h = harness([reply(200, { id: 1, fullName: 'Ana', status: 'active', createdDate: '2026-07-01T12:00:00+00:00' })], { env: { TZ: 'America/New_York' } });
    h.signedIn();
    expect(await h.run(['collaborators', 'get', '1']), h.err()).toBe(0);
    expect(h.out()).toMatch(/created +Jul 1, 2026 08:00 EDT/);
  });
});

describe('a list and a raw get of its route ask the same way (C26)', () => {
  it('sends programs list and get /programs with the same query', async () => {
    const h = signedIn([reply(200, envelope([])), reply(200, envelope([]))]);
    expect(await h.run(['programs', 'list'])).toBe(0);
    expect(await h.run(['get', '/programs'])).toBe(0);
    expect(Object.fromEntries(asked(h, 1))).toEqual(Object.fromEntries(asked(h, 0)));
    expect(asked(h, 1).get('order')).toBe('desc');
  });

  it('keeps an order the raw get names itself', async () => {
    const h = signedIn([reply(200, envelope([]))]);
    expect(await h.run(['get', '/programs?order=asc'])).toBe(0);
    expect(asked(h).get('order')).toBe('asc');
    expect(asked(h).get('orderBy')).toBeNull();
  });
});

describe('list headers and paging (C28)', () => {
  it('pages applications by perPage and page, with its status and form filters', async () => {
    const h = signedIn([reply(200, { items: [{ id: 4, status: 'waiting' }], total: 1, waiting: 1 })]);
    expect(await h.run(['applications', 'list', '--limit', '5', '--offset', '10', '--status', 'approved', '--form-id', '2']), h.err()).toBe(0);
    expect(Object.fromEntries(asked(h))).toEqual({ perPage: '5', page: '3', status: 'approved', formId: '2' });
  });

  it('refuses an application status Siren does not take, and a page larger than Siren sends', async () => {
    const h = signedIn([]);
    expect(await h.run(['applications', 'list', '--status', 'pending'])).toBe(2);
    expect(h.err()).toContain('--status takes waiting, approved, declined or all');
    expect(await h.run(['applications', 'list', '--limit', '500'])).toBe(2);
    expect(h.err()).toContain('--limit takes 100 or fewer here');
    expect(h.http.requests).toHaveLength(0);
  });

  it('prints a header row over the condition sets', async () => {
    const h = signedIn([reply(200, [{ id: 1, name: 'New this month', conditions: [{}, {}], lastCheckedAt: AT }])]);
    expect(await h.run(['condition-sets', 'list']), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe('ID  NAME            CONDITIONS    LAST CHECKED (UTC)');
    expect(h.out()).toContain('2 conditions');
  });
});
