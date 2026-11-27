import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * siren condition-sets, on Siren's /condition-sets routes as main serves
 * them since PR 1142. The answers are recorded from the PR 1181 preview.
 */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/audiences/condition-sets-and-enrollers.json', import.meta.url), 'utf8')) as Record<string, any>;
const UTC = { env: { TZ: 'UTC' } };
const queryOf = (h: ReturnType<typeof harness>, at: number) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
const bodyOf = (h: ReturnType<typeof harness>, at: number) => JSON.parse(h.http.requests[at]!.body!) as Record<string, unknown>;
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { ...UTC, ...options });
  h.signedIn();
  return h;
};
const routeMissing = () => reply(404, { error: { message: 'Not found.' } });

describe('siren condition-sets list and get', () => {
  it('lists each set on one line, with its conditions and when Siren last checked it', async () => {
    const h = signedIn([reply(200, recorded.sets)]);
    expect(await h.run(['condition-sets', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /condition-sets']);
    expect(h.out()).toBe(['ID  NAME                                  CONDITIONS   LAST CHECKED (UTC)', '1   Example: in the Creator Circle group  1 condition  Nov 24, 2026', ''].join('\n'));
    expect(h.err()).toContain('siren condition-sets matches 1');
  });

  it("shows one set with its conditions in Siren's words and what uses it", async () => {
    const h = signedIn([reply(200, recorded.set1), reply(200, recorded.conditions), reply(200, recorded.uses1)]);
    expect(await h.run(['condition-sets', 'get', '1']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /condition-sets/1', 'GET /condition-sets/conditions', 'GET /condition-sets/1/uses']);
    expect(h.out()).toBe(
      [
        'condition set 1 · Example: in the Creator Circle group',
        '',
        '  checked  Nov 24, 2026',
        '',
        '  conditions (1)',
        '    In collaborator group 2',
        '',
        '  used by (1)',
        '    enroller 2  Example: add people who match  active',
        '',
      ].join('\n'),
    );
    expect(h.err()).toContain('siren condition-sets matches 1');
    expect(h.err()).toContain('siren enrollers get 2');
  });

  it("fills every kind of condition's words, and falls back to its id when the catalog can't be read", async () => {
    const set = { ...recorded.set1, conditions: [{ id: 'last_engagement_days', args: { comparison: 'more_than', days: 30 } }, { id: 'in_program_for_days', args: { program: [4, 5], days: 90 } }, { id: 'account_not_set_up', args: {} }] };
    const h = signedIn([reply(200, set), reply(200, recorded.conditions), reply(200, { usedBy: [], uses: {} })]);
    expect(await h.run(['condition-sets', 'get', '1']), h.err()).toBe(0);
    expect(h.out()).toContain('    Last engagement more than 30 days ago\n    In programs 4 and 5 for at least 90 days\n    Hasn\'t set up their account\n');
    expect(h.out()).not.toContain('used by');

    const bare = signedIn([reply(200, set), reply(500, { error: { message: 'down' } }), reply(500, { error: { message: 'down' } })]);
    expect(await bare.run(['condition-sets', 'get', '1']), bare.err()).toBe(0);
    expect(bare.out()).toContain('    last_engagement_days  comparison more_than, days 30\n');
  });

  it("prints Siren's answer alone with --json", async () => {
    const h = signedIn([reply(200, recorded.set1)]);
    expect(await h.run(['condition-sets', 'get', '1', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual(recorded.set1);
    expect(h.paths()).toEqual(['GET /condition-sets/1']);
  });
});

describe('siren condition-sets matches', () => {
  const people = recorded.collaborators.map((person: any) => reply(200, person));

  it('counts who matches now and names the first few', async () => {
    const h = signedIn([reply(200, recorded.matches1), reply(200, recorded.people1), ...people]);
    expect(await h.run(['condition-sets', 'matches', '1']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /condition-sets/1/matches', 'GET /condition-sets/1/people', 'GET /collaborators/39', 'GET /collaborators/177', 'GET /collaborators/195']);
    expect(queryOf(h, 1)).toEqual({ limit: '5' });
    expect(h.out()).toBe(
      ['3 people match condition set 1 now.', '', '  39   Marcus Bell   hw.marcus@example.com', '  177  Ana Ferreira  hw.ana@example.com', '  195  Lena Vogel    hw.lena@example.com', ''].join('\n'),
    );
  });

  it('says how many more there are, and that Siren stopped counting at its cap', async () => {
    const h = signedIn([reply(200, { count: 1000, more: true }), reply(200, { collaboratorIds: [39], nextCursor: 39, unjudged: 2 }), people[0]!]);
    expect(await h.run(['condition-sets', 'matches', '1', '--limit', '1']), h.err()).toBe(0);
    expect(h.out()).toContain('1,000 or more people match condition set 1 now.');
    expect(h.out()).toContain('  and more. --limit 25 lists up to 25.');
    expect(h.err()).toContain("2 people couldn't be checked yet.");
  });

  it('counts the matches of conditions not yet saved, from a file or standard input', async () => {
    const conditions = [{ id: 'joined_days', args: { comparison: 'less_than', days: 30 } }];
    const h = signedIn([reply(200, { count: 12, more: false })], { stdin: JSON.stringify({ name: 'New', conditions }) });
    expect(await h.run(['condition-sets', 'matches', '-']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /condition-sets/matches']);
    expect(bodyOf(h, 0)).toEqual({ conditions });
    expect(h.out()).toBe('12 people would match these conditions now.\n');
  });

  it('prints the count and the people as JSON with --json', async () => {
    const h = signedIn([reply(200, recorded.matches1), reply(200, recorded.people1), ...people]);
    expect(await h.run(['condition-sets', 'matches', '1', '--json']), h.err()).toBe(0);
    const shown = JSON.parse(h.out());
    expect(shown).toMatchObject({ count: 3, more: false, unjudged: 0 });
    expect(shown.collaborators.map((person: any) => person.id)).toEqual([39, 177, 195]);
  });
});

describe('siren condition-sets create', () => {
  const file = JSON.stringify({ name: 'Joined this month', conditions: [{ id: 'joined_days', args: { comparison: 'less_than', days: 30 } }] });

  it('makes a set from JSON and names the command that counts its matches', async () => {
    const h = signedIn([reply(201, { id: 4, name: 'Joined this month', conditions: [], sourceKey: null, lastCheckedAt: null, archivedAt: null })], { stdin: file });
    expect(await h.run(['condition-sets', 'create', '-']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /condition-sets']);
    expect(bodyOf(h, 0)).toEqual(JSON.parse(file));
    expect(h.out()).toContain('Made condition set 4 · Joined this month.');
    expect(h.err()).toContain('siren condition-sets matches 4');
  });

  it("prints each field Siren refuses on its own row, and refuses a file that isn't a set before sending", async () => {
    const h = signedIn([reply(422, { error: { message: "Choose a different condition. This one isn't available.", context: { problems: { conditions: "Choose a different condition. This one isn't available." } } } })], { stdin: file });
    expect(await h.run(['condition-sets', 'create', '-'])).toBe(1);
    expect(h.err()).toContain("conditions: Choose a different condition. This one isn't available.");
    const bad = signedIn([], { stdin: '[1]' });
    expect(await bad.run(['condition-sets', 'create', '-'])).toBe(1);
    expect(bad.err()).toContain('name and conditions');
    expect(bad.paths()).toEqual([]);
  });

  it('needs --live on a live organization, as every write that can move people does', async () => {
    const h = harness([], { ...UTC, edition: 'production', stdin: file });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production', baseUrl: SANDBOX_BASE_URL }) });
    expect(await h.run(['condition-sets', 'create', '-'])).toBe(1);
    expect(h.err()).toContain('--live');
    expect(h.paths()).toEqual([]);
  });
});

describe('siren condition-sets on a Siren without them', () => {
  it('says this Siren has no condition sets yet when the route is missing', async () => {
    const h = signedIn([routeMissing()]);
    expect(await h.run(['condition-sets', 'list'])).toBe(1);
    expect(h.err()).toContain("This Siren doesn't have condition sets yet.");
  });

  it("says the plan doesn't include them, and keeps a missing set a missing set", async () => {
    const h = signedIn([reply(403, { error: { message: 'Your plan does not include this feature.', code: 'plan_required', context: { capability: 'audience-conditions' } } })]);
    expect(await h.run(['condition-sets', 'list'])).toBe(1);
    expect(h.err()).toContain("This organization's plan doesn't include condition sets.");
    const gone = signedIn([reply(404, { error: { message: "This condition set doesn't exist." } })]);
    expect(await gone.run(['condition-sets', 'get', '9'])).toBe(1);
    expect(gone.err()).toContain("This condition set doesn't exist.");
  });

  it('lists the conditions a set can use, with the values each takes', async () => {
    const h = signedIn([reply(200, recorded.conditions)]);
    expect(await h.run(['condition-sets', 'conditions']), h.err()).toBe(0);
    expect(h.out()).toContain('in_collaborator_group');
    expect(h.out()).toMatch(/joined_days +Joined {comparison} {days} days ago +comparison \(more_than, less_than\), days\n/);
  });
});
