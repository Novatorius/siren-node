import { describe, expect, it } from 'vitest';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';
import { SANDBOX_BASE_URL } from '../src/http';

/*
 * Pipes, both ends (lean output, section 5): --ids prints ids, and --stdin
 * reads them. A resource with a bulk route, POST /<name>/bulk {action, ids},
 * takes `siren <name> bulk <action>`, one request for up to 1000 ids.
 * `siren collaborator-groups add <id>` adds people to a group in one
 * request. Siren's answers are the shapes its controllers document:
 * {success, affected} for a bulk action, and the new member rows for add.
 */
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, options);
  h.signedIn();
  return h;
};
const bodyAt = (h: ReturnType<typeof harness>, at = 0) => JSON.parse(h.http.requests[at]!.body!) as Record<string, unknown>;

describe('siren <resource> bulk <action>', () => {
  it('runs one action on the ids given, in one request, and says how many changed', async () => {
    const h = signedIn([reply(200, { success: true, affected: 2 })]);
    expect(await h.run(['conversions', 'bulk', 'approve', '5632', '5633', '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /conversions/bulk']);
    expect(bodyAt(h)).toEqual({ action: 'approve', ids: [5632, 5633] });
    expect(h.out()).toBe('Siren ran approve on 2 conversions, and 2 changed.\n');
  });

  it('reads the ids from standard input with --stdin, one a line, as --ids prints them', async () => {
    const h = signedIn([reply(200, { success: true, affected: 3 })], { stdin: '39\n177\n\n195\n' });
    expect(await h.run(['collaborators', 'bulk', 'addToProgram', '--stdin', '-d', 'programId=4', '--yes']), h.err()).toBe(0);
    expect(bodyAt(h)).toEqual({ action: 'addToProgram', ids: [39, 177, 195], programId: 4 });
  });

  it('sends 1000 ids a request, and says so', async () => {
    const ids = Array.from({ length: 1001 }, (_, at) => String(at + 1)).join('\n');
    const h = signedIn([reply(200, { success: true, affected: 1000 }), reply(200, { success: true, affected: 1 })], { stdin: ids });
    expect(await h.run(['conversions', 'bulk', 'reject', '--stdin', '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /conversions/bulk', 'POST /conversions/bulk']);
    expect((bodyAt(h, 1).ids as number[]).length).toBe(1);
    expect(h.out()).toBe('Siren ran reject on 1001 conversions, in 2 requests, and 1001 changed.\n');
  });

  it('needs --yes with no terminal to ask in, and sends nothing without it', async () => {
    const h = signedIn([], { stdin: '1\n' });
    expect(await h.run(['conversions', 'bulk', 'approve', '--stdin'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('siren conversions bulk approve --stdin --yes');
  });

  it('refuses an action the route does not take, naming the ones it does, and an id that is not one', async () => {
    const h = signedIn([]);
    expect(await h.run(['conversions', 'bulk', 'pay', '1', '--yes'])).toBe(2);
    expect(h.err()).toContain('conversions bulk takes approve, reject, markPending, delete or permanent_delete');
    expect(await h.run(['conversions', 'bulk', 'approve', 'abc', '--yes'])).toBe(2);
    expect(h.err()).toContain('"abc" is not a record id');
    expect(await h.run(['conversions', 'bulk', 'approve', '--yes'])).toBe(2);
    expect(h.err()).toContain('Give the ids, or pipe them in with --stdin');
    expect(h.http.requests).toHaveLength(0);
  });

  it('prints the requests with --dry-run and sends nothing', async () => {
    const h = signedIn([]);
    expect(await h.run(['conversions', 'bulk', 'approve', '1', '2', '--dry-run'])).toBe(0);
    expect(h.out()).toContain(`Would send POST ${SANDBOX_BASE_URL}/conversions/bulk`);
    expect(h.out()).toContain('{"action":"approve","ids":[1,2]}');
    expect(h.http.requests).toHaveLength(0);
  });

  it('needs --live on a live organization', async () => {
    const h = harness([], { edition: 'production' });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production', baseUrl: SANDBOX_BASE_URL }) });
    expect(await h.run(['conversions', 'bulk', 'approve', '1', '--yes'])).not.toBe(0);
    expect(h.http.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(h.err()).toContain('--live');
  });

  it("prints Siren's answer with --json", async () => {
    const h = signedIn([reply(200, { success: true, affected: 1 })]);
    expect(await h.run(['conversions', 'bulk', 'approve', '1', '--yes', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual([{ success: true, affected: 1 }]);
  });

  it('lists the actions in help, and only resources with a bulk route have bulk', async () => {
    const h = signedIn([]);
    expect(await h.run(['conversions', 'bulk', '--help'])).toBe(0);
    expect(h.out().replace(/\s+/g, ' ')).toContain('approve, reject, markPending, delete or permanent_delete');
    expect(await h.run(['notification-preferences', 'bulk', 'x'])).toBe(2);
    const listed = signedIn([]);
    expect(await listed.run(['conversions'])).toBe(0);
    expect(listed.out()).toMatch(/siren conversions bulk <action> +POST \/conversions\/bulk/);
    expect(await listed.run(['collaborator-groups'])).toBe(0);
    expect(listed.out()).toMatch(/siren collaborator-groups add <id> +POST \/collaborator-groups\/\{id\}\/members/);
  });
});

describe('siren collaborator-groups add <id>', () => {
  it('adds the people given, or piped in, in one request, and says who was in it already', async () => {
    const h = signedIn([reply(201, [{ id: 1, collaboratorId: 39 }, { id: 2, collaboratorId: 177 }])], { stdin: '39\n177\n195\n' });
    expect(await h.run(['collaborator-groups', 'add', '5', '--stdin', '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /collaborator-groups/5/members']);
    expect(bodyAt(h)).toEqual({ members: [{ collaboratorId: 39 }, { collaboratorId: 177 }, { collaboratorId: 195 }] });
    expect(h.out()).toBe('Added 2 people to collaborator group 5. 1 was in it already.\n');
  });
});
