import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * siren enrollers, on the /enrollers routes of Siren PR 1181 (open). The
 * answers are recorded from that PR's preview. A Siren without the routes
 * gets a refusal that says so.
 */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/audiences/condition-sets-and-enrollers.json', import.meta.url), 'utf8')) as Record<string, any>;
const UTC = { env: { TZ: 'UTC' } };
const queryOf = (h: ReturnType<typeof harness>, at: number) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { ...UTC, ...options });
  h.signedIn();
  return h;
};
const list = (items: unknown[], total = items.length) => reply(200, items, { 'x-siren-estimated-count': String(total) });
const triggers = () => reply(200, recorded.triggers);
const logLine = {
  id: 31,
  enrollerId: 1,
  collaboratorId: 39,
  triggerId: 'approved',
  depth: 0,
  outcome: 'acted',
  reason: null,
  errorClass: null,
  happenedAt: '2026-11-24 16:10:00',
  finishedAt: '2026-11-24 16:10:01',
  places: [],
  notes: [],
  missing: [],
  message: 'Added Marcus Bell to Creator Program.',
  dates: [],
};

describe('siren enrollers list and get', () => {
  it("prints Siren's answer as it came with --json, and reads no triggers (review of PR 94)", async () => {
    const h = signedIn([reply(200, { items: recorded.enrollers, total: 2 })]);
    expect(await h.run(['enrollers', 'list', '--json']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /enrollers']);
    expect(JSON.parse(h.out())).toEqual({ items: recorded.enrollers, total: 2 });
  });

  it('lists each enroller on one line with its status and what starts it, in words', async () => {
    const h = signedIn([list(recorded.enrollers), triggers()]);
    expect(await h.run(['enrollers', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /enrollers', 'GET /enroller-triggers']);
    expect(h.out()).toBe(
      ['ID\tNAME\tSTATUS\tSTARTS', '1\tExample: big following\tactive\tApproved', '2\tExample: add people who match\tactive\tStarts matching a condition set', ''].join('\n'),
    );
    expect(h.err()).toContain('siren enrollers get 1');
  });

  it('sends --status, and keeps trigger ids when the trigger list fails', async () => {
    const h = signedIn([list(recorded.enrollers.slice(0, 1), 1), reply(500, { error: { message: 'down' } })]);
    expect(await h.run(['enrollers', 'list', '--status', 'paused']), h.err()).toBe(0);
    expect(queryOf(h, 0)).toMatchObject({ status: 'paused' });
    expect(h.out()).toContain('active\tapproved\n');
  });

  it('shows one enroller: what starts it, what it does, and its latest log lines', async () => {
    const h = signedIn([reply(200, recorded.enroller1), triggers(), list([logLine], 4)]);
    expect(await h.run(['enrollers', 'get', '1']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /enrollers/1', 'GET /enroller-triggers', 'GET /enrollers/1/log']);
    expect(queryOf(h, 2)).toEqual({ number: '3' });
    expect(h.out()).toBe(
      [
        'enroller 1 · Example: big following',
        '',
        '  status        active',
        '  when          Approved',
        '  forms         4',
        '  answer tests  followers more than 10000',
        '  adds to       program 2',
        '  created       Nov 24, 2026',
        '',
        '  log (4)',
        '    Nov 24 16:10  collaborator 39  Added Marcus Bell to Creator Program.',
        '    and 3 more',
        '',
        // The enroller's page in Siren's app ends the view.
        'https://sandbox.sirenaffiliates.com/enrollers/1?org=3',
        '',
      ].join('\n'),
    );
    expect(h.err()).toContain('siren enrollers log 1');
    expect(h.err()).toContain('siren programs get 2');
  });

  it('marks an enroller that only holds people while they match, and one that needs fixing', async () => {
    const two = { ...recorded.enrollers[1], needsFix: 'Its condition set was archived.', removeGroupIds: [3, 4] };
    const h = signedIn([reply(200, two), triggers(), list([], 0)]);
    expect(await h.run(['enrollers', 'get', '2']), h.err()).toBe(0);
    expect(h.out()).toContain('  condition set        1\n');
    expect(h.out()).toContain('  adds to              program 2\n  takes out of         collaborator groups 3 and 4\n  only while matching  yes\n');
    expect(h.out()).toContain('  needs fixing         Its condition set was archived.\n');
    expect(h.out()).toContain('  log                  nothing yet\n');
  });
});

describe('siren enrollers log', () => {
  it('prints the log newest first, one line each', async () => {
    const h = signedIn([list([logLine], 1)]);
    expect(await h.run(['enrollers', 'log', '1', '--limit', '50']), h.err()).toBe(0);
    expect(queryOf(h, 0)).toEqual({ number: '50' });
    expect(h.out()).toBe('Nov 24 16:10  collaborator 39  Added Marcus Bell to Creator Program.\n');
  });

  it('says when the log is empty', async () => {
    const h = signedIn([list([], 0)]);
    expect(await h.run(['enrollers', 'log', '2']), h.err()).toBe(0);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('Enroller 2 has done nothing yet.');
  });
});

describe('siren enrollers run', () => {
  it("says what a run would do, and sends nothing without --yes when there's no terminal to ask in", async () => {
    const h = signedIn([reply(200, recorded.runNow2)]);
    expect(await h.run(['enrollers', 'run', '2'])).toBe(1);
    expect(h.paths()).toEqual(['GET /enrollers/2/run-now']);
    expect(h.err()).toContain('About 3 of the 3 people who match now would move.');
    expect(h.err()).toContain('siren enrollers run 2 --yes');
  });

  it('starts the run with --yes and names the job', async () => {
    const h = signedIn([reply(200, recorded.runNow2), reply(202, { jobId: 77, joined: false, matching: 3, waiting: null })]);
    expect(await h.run(['enrollers', 'run', '2', '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /enrollers/2/run-now', 'POST /enrollers/2/run-now']);
    expect(h.out()).toContain('Enroller 2 is running on the 3 people who match now, as job 77.');
  });

  it('needs --live on a live organization, since a run moves people', async () => {
    const h = harness([], { ...UTC, edition: 'production' });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production', baseUrl: SANDBOX_BASE_URL }) });
    expect(await h.run(['enrollers', 'run', '2', '--yes'])).toBe(1);
    expect(h.err()).toContain('--live');
    expect(h.paths()).toEqual([]);
  });
});

describe('siren enrollers on a Siren without them', () => {
  it("says this Siren doesn't have enrollers yet, for every enroller command", async () => {
    for (const line of [['enrollers', 'list'], ['enrollers', 'get', '1'], ['enrollers', 'log', '1']]) {
      const h = signedIn([reply(404, { error: { message: 'Not found.' } }), triggers()]);
      expect(await h.run(line)).toBe(1);
      expect(h.err()).toContain("This Siren doesn't have enrollers yet.");
    }
  });

  it("says the plan doesn't include enrollers, and keeps a missing enroller a missing enroller", async () => {
    const h = signedIn([reply(403, { error: { message: 'Your plan does not include this feature.', code: 'plan_required', context: { capability: 'enrollers' } } })]);
    expect(await h.run(['enrollers', 'list'])).toBe(1);
    expect(h.err()).toContain("This organization's plan doesn't include enrollers.");
    const gone = signedIn([reply(404, { error: { message: 'Enroller not found.' } }), triggers()]);
    expect(await gone.run(['enrollers', 'get', '9'])).toBe(1);
    expect(gone.err()).toContain('Enroller not found.');
  });
});
