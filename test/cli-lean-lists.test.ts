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
    expect(h.out()).toBe(['id\tname\tstatus\tcreatedDate', '2\tPartner program\tdraft\tToday 09:58', '1\tReferral program\tactive\tMar 2, 2025', ''].join('\n'));
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
    expect(h.out()).toBe('id\tname\n2\tPartner program\n1\tReferral program\n');
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

describe('review of PR 94', () => {
  it('stops --all when a route ignores offset and sends the same page again', async () => {
    const page = { items: programs, page: 1, perPage: 2 };
    const h = signedIn([reply(200, page), reply(200, page), reply(200, page)]);
    expect(await h.run(['get', '/programs', '--all', '--ids']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /programs', 'GET /programs']);
    expect(h.out()).toBe('2\n1\n');
  });

  it('passes --ids and --fields through a raw get', async () => {
    const h = signedIn([reply(200, envelope(programs)), reply(200, envelope(programs))]);
    expect(await h.run(['get', '/programs', '--ids']), h.err()).toBe(0);
    expect(h.out()).toBe('2\n1\n');
    expect(await h.run(['get', '/programs', '--fields', 'name'])).toBe(0);
    expect(h.out()).toContain('name\nPartner program\nReferral program\n');
  });

  it('leaves no generated record command on a word a hand-written command owns', async () => {
    const { RESOURCE_COMMANDS } = await import('../src/cli/resources.generated');
    const { COMMANDS } = await import('../src/cli/run');
    const owned = new Set([...COMMANDS.map((command) => command.split(' ')[0]), 'resources']);
    expect(RESOURCE_COMMANDS.map((resource) => resource.name).filter((name) => owned.has(name))).toEqual([]);
  });

  it('refuses -d keys that would reach the object prototype', async () => {
    const h = signedIn([]);
    expect(await h.run(['post', '/programs', '-d', '__proto__[polluted]=1', '--dry-run'])).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('default columns (lean output, section 5)', () => {
  const conversions = [
    { id: 5632, engagementId: 41186, transactionId: 7502, obligationId: null, collaboratorName: 'Shay Okonkwo', amount: 500, obligationAwardType: 'USD', isTest: false, status: 'pending', type: 'sale', dateCreated: '2026-11-17T09:20:41+00:00', dateModified: '2026-11-17T09:20:41+00:00' },
  ];
  const registry = [{ code: 'USD', symbol: '$', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: true }];

  it('shows the id, status, money, the related name and the date, and leaves relation ids out, in a pipe as in a terminal', async () => {
    const h = signedIn([reply(200, envelope(conversions)), reply(200, registry)]);
    expect(await h.run(['conversions', 'list']), h.err()).toBe(0);
    expect(h.out()).toBe(['id\tstatus\tamount\tcollaboratorName\tdateCreated', '5632\tpending\t$5.00 USD\tShay Okonkwo\tToday 09:20', ''].join('\n'));
  });

  it('shows the email when a record has no name', async () => {
    const h = signedIn([reply(200, envelope([{ id: 3, nickname: 'ana', email: 'ana@example.com', status: 'active', referralCode: 'ANA', dateCreated: '2026-11-17T09:20:41+00:00' }]))]);
    expect(await h.run(['collaborators', 'list']), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe('id\temail\tstatus\tdateCreated');
  });

  it('keeps every column a record has when none of them is a known kind', async () => {
    const h = signedIn([reply(200, envelope([{ id: 'x', alpha: 1, beta: 2 }]))]);
    expect(await h.run(['get', '/odd']), h.err()).toBe(0);
    expect(h.out().split('\n')[0]).toBe('id\talpha\tbeta');
  });
});

describe('query filters as flags (lean output, section 5)', () => {
  it("sends each route's query parameter from its own flag, in kebab case", async () => {
    const h = signedIn([reply(200, envelope([]))]);
    expect(await h.run(['conversions', 'list', '--status', 'pending', '--collaborator-id', '12']), h.err()).toBe(0);
    expect(queryOf(h)).toEqual({ status: 'pending', collaboratorId: '12' });
  });

  it('refuses a value the parameter does not take, naming what it takes, and sends nothing', async () => {
    const h = signedIn([]);
    expect(await h.run(['conversions', 'list', '--collaborator-id', 'ana'])).toBe(2);
    expect(h.err()).toContain('--collaborator-id takes a whole number');
    expect(await h.run(['conversions', 'list', '--order-by', 'name'])).toBe(2);
    expect(h.err()).toContain('--order-by takes id, engagementId, type, status or dateCreated');
    expect(h.http.requests).toHaveLength(0);
  });

  it('lists the filters in help, with the values an enum takes', async () => {
    const h = signedIn([]);
    expect(await h.run(['conversions', 'list', '--help'])).toBe(0);
    expect(h.out()).toContain('--collaborator-id <n>');
    expect(h.out()).toContain('--order-by <id|engagementId|type|status|dateCreated>');
  });

  it('asks for no order of its own when --order-by or --order names one', async () => {
    const h = signedIn([reply(200, envelope([]))]);
    expect(await h.run(['programs', 'list', '--order', 'asc'])).toBe(0);
    expect(queryOf(h)).toEqual({ order: 'asc' });
  });
});
