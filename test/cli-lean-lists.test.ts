import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * Lean output for generated lists (review/cli-dx/lean-output.md in the run
 * folder, section 5): standard output holds the data alone through a pipe,
 * --ids and --fields shape it, lists come newest first where the route
 * takes an order, dates read as dates, and help opens with a sentence.
 */
const programs = [
  { id: 2, name: 'Partner program', status: 'draft', units: 'usd', createdDate: '2026-11-17T09:58:00+00:00' },
  { id: 1, name: 'Referral program', status: 'active', units: 'usd', createdDate: '2025-03-02T09:00:00+00:00' },
];
const envelope = (items: unknown[], page = 1, totalPages = 1, total = items.length, perPage = 10) => ({ items, total, page, perPage, totalPages });
const queryOf = (h: ReturnType<typeof harness>, at = 0) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { env: { TZ: 'UTC' }, ...options });
  h.signedIn();
  return h;
};

describe('a generated list through a pipe', () => {
  it('prints the table alone on standard output, with dates as dates, and the count and Next on standard error', async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await h.run(['programs', 'list']), h.err()).toBe(0);
    expect(h.out()).toBe(['id  name              status  units  createdDate', '2   Partner program   draft   usd    Today 09:58', '1   Referral program  active  usd    Mar 2, 2025', ''].join('\n'));
    expect(h.err()).toContain('2 programs');
    expect(h.err()).toContain('siren programs get 2');
  });

  it('asks for newest first where the route takes an order, unless the line names one', async () => {
    const h = signedIn([reply(200, envelope(programs)), reply(200, envelope(programs)), reply(200, envelope([]))]);
    expect(await h.run(['programs', 'list'])).toBe(0);
    expect(queryOf(h, 0)).toMatchObject({ orderBy: 'id', order: 'desc' });
    expect(await h.run(['programs', 'list', '-d', 'order=asc'])).toBe(0);
    expect(queryOf(h, 1)).toEqual({ order: 'asc' });
    expect(await h.run(['conversions', 'list'])).toBe(0);
    expect(queryOf(h, 2)).toEqual({});
  });
});

describe('--ids and --fields', () => {
  it('prints one id a line and nothing else with --ids, across every page with --all', async () => {
    const h = signedIn([reply(200, envelope(programs.slice(0, 1), 1, 2, 2, 1)), reply(200, envelope(programs.slice(1), 2, 2, 2, 1))]);
    expect(await h.run(['programs', 'list', '--ids', '--all']), h.err()).toBe(0);
    expect(h.out()).toBe('2\n1\n');
    expect(h.err()).toBe('');
  });

  it('shows only the fields named, asks Siren for them where the route takes fields, and cuts --json to them', async () => {
    const h = signedIn([reply(200, envelope(programs)), reply(200, envelope(programs))]);
    expect(await h.run(['programs', 'list', '--fields', 'id,name']), h.err()).toBe(0);
    expect(queryOf(h, 0)).toMatchObject({ fields: 'id,name' });
    expect(h.out()).toBe('id  name\n2   Partner program\n1   Referral program\n');
    expect(await h.run(['programs', 'list', '--fields', 'name', '--json'])).toBe(0);
    expect(JSON.parse(h.out().slice(h.out().indexOf('{')))).toEqual({ items: [{ name: 'Partner program' }, { name: 'Referral program' }], total: 2, page: 1, perPage: 10, totalPages: 1 });
  });

  it("refuses a field the records don't have, naming the ones they do", async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await h.run(['programs', 'list', '--fields', 'id,colour'])).toBe(2);
    expect(h.err()).toContain('colour');
    expect(h.err()).toContain('id, name, status, units, createdDate');
  });
});

describe('a generated list in a terminal', () => {
  it('keeps the headline, Next and tip on standard output, inside 80 columns', async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await runCli(['programs', 'list'], { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color', TZ: 'UTC' } })).toBe(0);
    const plain = h.out().replace(/\u001b\[[\d;]*m/g, '');
    expect(plain).toContain('2 programs');
    expect(plain).toContain('Today 09:58');
    expect(plain).toContain('siren programs get 2');
    for (const line of plain.split('\n')) expect([...line].length).toBeLessThanOrEqual(80);
  });
});

describe('generated help', () => {
  it('opens with a sentence that says what the command does, then the route', async () => {
    const h = harness([]);
    expect(await h.run(['conversions', 'list', '--help'])).toBe(0);
    expect(h.out()).toMatch(/^List conversions\. Sends GET \/conversions\./);
    expect(await h.run(['programs', 'list', '--help'])).toBe(0);
    expect(h.out()).toContain('List programs, newest first. Sends GET /programs.');
    expect(await h.run(['programs', 'get', '--help'])).toBe(0);
    expect(h.out()).toContain('Show one program. Sends GET /programs/{id}.');
    expect(await h.run(['programs', 'create', '--help'])).toBe(0);
    expect(h.out()).toContain('Create a program. Sends POST /programs.');
  });
});
