import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/cli/run';
import { rewriteFeatureRefs, withoutPaths } from '../src/cli/commands/sandbox';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { ACCESS_2, AuthAnswers, REFRESH_2, harness, membershipAcme, session } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';

/*
 * Acceptance tests for `siren sandbox create`, `list`, `reset`, `inbox` and
 * `siren seed`, the sandbox lane. Contract: contract/devtools-sandbox.md in
 * the run folder, "CLI commands".
 *
 * Two Sirens take part in a copy: the sandbox the command talks to, and a
 * live Siren the setup comes from. The harness answers `GET
 * /auth/signup-options` itself, so `edition` answers by read: the sandbox
 * is read first, then the live Siren.
 */

const posix = process.platform !== 'win32';
const LIVE = 'https://siren.acme.example/siren/v1';
const RAW_KEY = `sk_test_${'5e'.repeat(32)}`;
const SIGNING_SECRET = '7d'.repeat(32);
const sandboxFirst = (read: number) => (read === 1 ? 'sandbox' : 'production');

const liveSession = session({ edition: 'production', baseUrl: LIVE, orgId: 9, orgName: 'Acme', orgSlug: 'acme' });
const sandboxOrg = { orgId: 42, orgName: 'Acme (sandbox)', orgSlug: 'acme-sandbox', role: 'admin' };

/** A recipe as `GET /recipes/export` answers it, with one program that names the live app's feature 11. */
function exported() {
  return reply(200, {
    success: true,
    recipe: {
      version: 1,
      name: 'Exported configuration',
      tracking: { cookieDays: 30 },
      programs: [
        { name: 'Partners', postConversionActions: [{ type: 'app:11' }, { type: 'emailCollaborator' }] },
        { name: 'Affiliates', sorter: 'app:12' },
      ],
      programGroups: [{ name: 'All' }],
      collaboratorGroups: [{ name: 'VIP' }, { name: 'New' }],
    },
    skipped: { programs: [{ id: 5, name: 'Draft', reason: 'draft' }] },
  });
}

/** The app the sandbox makes, with its own ids, a new key and a new secret. */
function declaredOnSandbox() {
  const live = appRecord();
  return reply(201, {
    ...live,
    id: 70,
    features: live.features.map((feature) => ({ ...feature, id: feature.id + 100, ref: `app:${feature.id + 100}`, appId: 70 })),
    rawKey: RAW_KEY,
    signingSecret: SIGNING_SECRET,
  });
}

function copyReplies(apply = reply(202, { success: true, jobId: 'job1', status: 'queued' })) {
  return [
    exported(),
    reply(200, [appRecord()]),
    reply(201, { org: sandboxOrg }),
    AuthAnswers.tokens(ACCESS_2, REFRESH_2),
    declaredOnSandbox(),
    apply,
    reply(200, { success: true, jobId: 'job1', status: 'complete', perStanzaProcessed: { programs: 2 } }),
  ];
}

function signedInBoth(h: ReturnType<typeof harness>) {
  h.signedIn({ [SANDBOX_BASE_URL]: session(), [LIVE]: liveSession });
}

describe('sandbox: siren sandbox create', () => {
  it('lists the five commands', () => {
    for (const command of ['sandbox create', 'sandbox list', 'sandbox reset', 'sandbox inbox', 'seed']) expect(COMMANDS).toContain(command);
  });

  it('copies the live setup into a new sandbox organization, turns feature references, and prints no key or secret', async () => {
    const h = harness(copyReplies(), { edition: sandboxFirst });
    signedInBoth(h);

    const code = await h.run(['sandbox', 'create', '--from', 'acme']);

    expect(code, h.err()).toBe(0);
    expect(h.paths()).toEqual([
      'GET /recipes/export',
      'GET /apps',
      'POST /sandbox/orgs',
      'POST /auth/switch-org',
      `PUT /apps/${APP_KEY}`,
      'POST /recipes/apply',
      'GET /recipes/imports/job1',
    ]);
    // Reads went to the live Siren, writes to the sandbox.
    const hosts = h.http.requests.map((request) => new URL(request.url).host);
    expect(hosts.slice(0, 2)).toEqual(['siren.acme.example', 'siren.acme.example']);
    expect(hosts.slice(2).every((host) => host === new URL(SANDBOX_BASE_URL).host)).toBe(true);
    expect(h.http.requests.slice(0, 2).every((request) => request.method === 'GET')).toBe(true);

    // The export leaves out the client's people.
    const include = new URL(h.http.requests[0]!.url).searchParams.get('include')!.split(',');
    expect(include).toContain('programs');
    expect(include).not.toContain('collaborators');
    expect(include).not.toContain('mappings');

    expect(bodyOf(h.http.requests[2])).toEqual({ name: 'Acme (sandbox)' });
    const declared = bodyOf(h.http.requests[4]) as Record<string, unknown>;
    expect(declared).toMatchObject({ name: 'Acme', url: 'https://acme.example/siren' });
    expect(declared).not.toHaveProperty('rawKey');
    expect((declared.features as Array<Record<string, unknown>>).map((feature) => feature.key)).toEqual(['notify-crm', 'acme-ledger']);
    expect((declared.features as Array<Record<string, unknown>>)[1]).toMatchObject({ currencies: ['USD'], answerWindowMinutes: 1 });

    const applied = bodyOf(h.http.requests[5]) as Record<string, unknown>;
    expect(applied.configurationOnly).toBe(true);
    expect(JSON.stringify(applied.programs)).toContain('"app:111"');
    expect(JSON.stringify(applied.programs)).toContain('"app:112"');
    expect(JSON.stringify(applied)).not.toMatch(/"app:1[12]"/);

    // The session moved to the new organization, and the copy is on record.
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 42, orgSlug: 'acme-sandbox', accessToken: ACCESS_2 });
    expect(h.credentials().sessions[LIVE]).toMatchObject({ orgId: 9 });
    const recordPath = join(h.configDir, 'sandboxes.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { copies: Array<Record<string, unknown>> };
    expect(record.copies).toEqual([
      expect.objectContaining({ baseUrl: SANDBOX_BASE_URL, orgId: 42, orgSlug: 'acme-sandbox', from: { baseUrl: LIVE, orgId: 9, orgSlug: 'acme', orgName: 'Acme' } }),
    ]);
    if (posix) expect(statSync(recordPath).mode & 0o777).toBe(0o600);

    for (const secret of [RAW_KEY, SIGNING_SECRET, ACCESS_2, REFRESH_2]) {
      expect(h.printed()).not.toContain(secret);
      expect(readFileSync(recordPath, 'utf8')).not.toContain(secret);
    }
    const out = h.out();
    expect(out).toContain('Copied Acme into a sandbox organization');
    expect(out).toContain('acme-sandbox on sandbox.sirenaffiliates.com');
    expect(out).toContain('1 copied (2 features)');
    expect(out).toContain('collaborators');
    expect(out).toContain('1 programs, the export leaves them out');
    expect(out).toContain('siren seed --sales 50');
    for (const line of out.split('\n')) expect([...line].length).toBeLessThanOrEqual(80);
  });

  it('leaves out an app choice a recipe cannot carry, says so, and applies the rest', async () => {
    const refused = reply(422, {
      error: {
        message: 'Recipe validation failed.',
        context: { type: 'RECIPE_VALIDATION_FAILED', errors: [{ path: 'programs.1.sorter', message: "A recipe can't name an app's feature. Choose it after the recipe is applied." }] },
      },
    });
    const replies = copyReplies(refused);
    replies.splice(6, 0, reply(202, { success: true, jobId: 'job1', status: 'queued' }));
    const h = harness(replies, { edition: sandboxFirst });
    signedInBoth(h);

    expect(await h.run(['sandbox', 'create', '--from', 'acme', '--json']), h.err()).toBe(0);
    const second = bodyOf(h.http.requests[6]) as { programs: Array<Record<string, unknown>> };
    expect(second.programs[1]).toEqual({ name: 'Affiliates' });
    expect(JSON.stringify(second.programs[0])).toContain('app:111');
    const answer = JSON.parse(h.out()) as { notCopied: Array<{ what: string }>; import: { status: string } };
    expect(answer.import.status).toBe('complete');
    expect(answer.notCopied.map((item) => item.what)).toContain('app choice at programs.1.sorter');
  });

  it('refuses a live session in another organization before anything is made', async () => {
    const h = harness([], { edition: sandboxFirst });
    signedInBoth(h);
    expect(await h.run(['sandbox', 'create', '--from', 'globex'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('siren use globex --base-url https://siren.acme.example/siren/v1 --live');
  });

  it('refuses a live Siren with no session here, naming the login that makes one', async () => {
    const h = harness([], { edition: sandboxFirst });
    h.signedIn({ [SANDBOX_BASE_URL]: session() });
    expect(await h.run(['sandbox', 'create', '--from', 'acme', '--live-url', 'siren.acme.example'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('login');
    expect(h.err()).toContain('--live');
  });

  it('refuses a --from Siren that is a sandbox', async () => {
    const h = harness([], { edition: 'sandbox' });
    signedInBoth(h);
    expect(await h.run(['sandbox', 'create', '--from', 'acme'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('copies from a live one');
  });

  it('needs --from', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['sandbox', 'create'])).toBe(2);
    expect(h.err()).toContain('--from');
  });
});

describe('sandbox: every command runs only on a sandbox', () => {
  const lines = [
    ['sandbox', 'create', '--from', 'acme'],
    ['sandbox', 'list'],
    ['sandbox', 'reset', '--confirm', 'acme'],
    ['sandbox', 'inbox'],
    ['seed'],
  ];

  it('refuses a live Siren before anything is sent, and says how to reach a sandbox', async () => {
    for (const argv of lines) {
      const h = harness([], { edition: 'production' });
      h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production' }) });
      expect(await h.run(argv), argv.join(' ')).toBe(1);
      expect(h.paths()).toEqual([]);
      expect(h.err()).toContain('runs only on a sandbox');
      expect(h.err()).toContain('--sandbox');
    }
  });

  it('refuses --live before anything is sent', async () => {
    for (const argv of lines) {
      const h = harness([], { edition: 'production' });
      h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production' }) });
      expect(await h.run([...argv, '--live']), argv.join(' ')).toBe(1);
      expect(h.paths()).toEqual([]);
      expect(h.err()).toContain('without --live');
    }
  });
});

describe('sandbox: siren sandbox list', () => {
  it('lists the organizations, marks the one in use, and names where a copy came from', async () => {
    const copied = JSON.stringify({
      version: 1,
      copies: [{ ...sandboxOrg, baseUrl: SANDBOX_BASE_URL, from: { baseUrl: LIVE, orgId: 9, orgSlug: 'acme', orgName: 'Acme' }, copiedAt: '2026-11-24T17:00:00.000Z' }],
    });
    const listing = () => {
      const h = harness([reply(200, { memberships: [membershipAcme, sandboxOrg] })]);
      h.signedIn({ [SANDBOX_BASE_URL]: session({ orgId: 42, orgSlug: 'acme-sandbox' }) });
      mkdirSync(h.configDir, { recursive: true });
      writeFileSync(join(h.configDir, 'sandboxes.json'), copied, { mode: 0o600 });
      return h;
    };

    const h = listing();
    expect(await h.run(['sandbox', 'list', '--json']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /auth/memberships']);
    const answer = JSON.parse(h.out()) as { orgs: Array<Record<string, unknown>> };
    expect(answer.orgs).toEqual([
      expect.objectContaining({ orgSlug: 'acme', current: false, copiedFrom: null }),
      expect.objectContaining({ orgSlug: 'acme-sandbox', current: true, copiedFrom: { baseUrl: LIVE, orgId: 9, orgSlug: 'acme', orgName: 'Acme' } }),
    ]);

    const plain = listing();
    expect(await plain.run(['sandbox', 'list'])).toBe(0);
    expect(plain.out()).toContain('2 sandbox organizations on sandbox.sirenaffiliates.com');
    expect(plain.out()).toMatch(/\* +acme-sandbox +Acme \(sandbox\) +acme on siren\.acme\.example/);
  });
});

describe('sandbox: siren sandbox reset', () => {
  const cleared = reply(200, { org: { orgId: 3, orgSlug: 'acme' }, cleared: { conversions: 5, obligations: 4, transactions: 3, webhook_deliveries: 2 }, total: 14 });

  it('sends the slug the person typed, and shows what it cleared', async () => {
    const h = harness([cleared], { interactive: true, typed: ['acme'] });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'reset']), h.err()).toBe(0);
    expect(h.prompts).toEqual(['Type acme to confirm: ']);
    expect(h.paths()).toEqual(['POST /sandbox/reset']);
    expect(bodyOf(h.http.requests[0])).toEqual({ confirm: 'acme' });
    expect(h.out()).toMatch(/Conversions +5/);
    expect(h.out()).toMatch(/Deliveries +2/);
    expect(h.out()).toContain('Kept');
  });

  it('sends nothing when the slug typed is wrong, or with no terminal and no --confirm', async () => {
    const wrong = harness([cleared], { interactive: true, typed: ['acme-live'] });
    wrong.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await wrong.run(['sandbox', 'reset'])).toBe(1);
    expect(wrong.paths()).toEqual([]);
    expect(wrong.err()).toContain('nothing was cleared');

    const piped = harness([cleared]);
    piped.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await piped.run(['sandbox', 'reset'])).toBe(1);
    expect(piped.paths()).toEqual([]);
    expect(piped.err()).toContain('siren sandbox reset --confirm acme');

    const flagged = harness([cleared]);
    flagged.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await flagged.run(['sandbox', 'reset', '--confirm', 'acme', '--json'])).toBe(0);
    expect(JSON.parse(flagged.out())).toMatchObject({ total: 14 });
  });

  it("passes on Siren's refusal of the slug", async () => {
    const h = harness([reply(422, { error: { message: 'Type acme to confirm. Nothing was cleared.', context: { type: 'sandbox_reset_unconfirmed', orgSlug: 'acme' } } })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'reset', '--confirm', 'acme'])).toBe(1);
    expect(h.err()).toContain('Nothing was cleared');
  });
});

describe('sandbox: siren seed', () => {
  const queued = reply(202, { jobId: 'seed1', status: 'queued', sales: 12, collaborators: 3, months: 2 });
  const running = reply(200, { jobId: 'seed1', status: 'running', progress: { phase: 'sales', salesSent: 4, salesRefused: 0 } });
  const done = reply(200, {
    jobId: 'seed1',
    status: 'complete',
    progress: { phase: 'sales', months: 2, collaboratorsMade: 2, collaboratorsUsed: 3, salesSent: 12, salesRefused: 0, conversions: 14, firstAt: '2026-09-30T10:00:00+00:00', lastAt: '2026-11-23T18:00:00+00:00' },
  });

  it('queues the seed with the counts asked for, waits on its job, and reports it', async () => {
    const h = harness([queued, running, done]);
    h.signedIn();
    expect(await h.run(['seed', '--sales', '12', '--collaborators', '3', '--months', '2', '--seed', '7']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /sandbox/seed', 'GET /jobs/seed1', 'GET /jobs/seed1']);
    expect(bodyOf(h.http.requests[0])).toEqual({ sales: 12, collaborators: 3, months: 2, seed: 7 });
    const out = h.out();
    expect(out).toContain('with 2 months of sales');
    expect(out).toMatch(/Sales +12 sent, 0 refused/);
    expect(out).toMatch(/Collaborators +3 \(2 made, 1 already here\)/);
    expect(out).toContain('2026-09-30 to 2026-11-23');
  });

  it('sends the defaults, and stops at the job id with --no-wait', async () => {
    const h = harness([queued]);
    h.signedIn();
    expect(await h.run(['seed', '--no-wait', '--json'])).toBe(0);
    expect(bodyOf(h.http.requests[0])).toEqual({ sales: 50, collaborators: 10, months: 3 });
    expect(h.paths()).toEqual(['POST /sandbox/seed']);
    expect(JSON.parse(h.out())).toMatchObject({ jobId: 'seed1' });
  });

  it('refuses counts out of range before anything is sent', async () => {
    for (const argv of [['--sales', '0'], ['--sales', '201'], ['--collaborators', '26'], ['--months', '7'], ['--months', 'two'], ['--seed', '-1']]) {
      const h = harness([queued]);
      h.signedIn();
      expect(await h.run(['seed', ...argv]), argv.join(' ')).toBe(2);
      expect(h.sent()).toEqual([]);
    }
  });

  it('exits 1 with the job error when the seed fails', async () => {
    const h = harness([queued, reply(200, { jobId: 'seed1', status: 'failed', errorMessage: 'No collaborator could be made.', progress: {} })]);
    h.signedIn();
    expect(await h.run(['seed'])).toBe(1);
    expect(h.err()).toContain('No collaborator could be made.');
  });
});

describe('sandbox: siren sandbox inbox', () => {
  const email = { id: 31, recipients: ['ana@example.com'], subject: 'Your commission was approved', fromName: 'Acme', template: 'conversion-approved', createdAt: '2026-11-24T17:40:00+00:00' };

  it('lists the caught emails, newest first, and shows one with its text', async () => {
    const h = harness([reply(200, { emails: [email], total: 1 })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'inbox', '--limit', '5']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /sandbox/inbox']);
    expect(new URL(h.http.requests[0]!.url).searchParams.get('number')).toBe('5');
    expect(h.out()).toContain("1 email in acme's sandbox inbox");
    expect(h.out()).toMatch(/#31 +2026-11-24 17:40 +ana@example\.com +Your commission was approved/);
    expect(h.out()).toContain('siren sandbox inbox 31');

    const one = harness([reply(200, { ...email, text: 'Your commission of $12.00 was approved.', html: '<p>…</p>', headers: {} })]);
    one.signedIn();
    expect(await one.run(['sandbox', 'inbox', '31'])).toBe(0);
    expect(one.paths()).toEqual(['GET /sandbox/inbox/31']);
    expect(one.out()).toContain('Your commission of $12.00 was approved.');
  });

  it('refuses a limit out of range and an id that is not a number', async () => {
    for (const argv of [['--limit', '0'], ['--limit', '101'], ['abc']]) {
      const h = harness([]);
      h.signedIn();
      expect(await h.run(['sandbox', 'inbox', ...argv])).toBe(2);
      expect(h.paths()).toEqual([]);
    }
  });
});

describe('sandbox: the recipe helpers', () => {
  it('turns each known feature reference and reports the unknown ones', () => {
    const { recipe, unknown } = rewriteFeatureRefs({ a: ['app:1', { b: 'app:2' }], c: 'app:3', d: 'application:1', e: 'app:' }, new Map([['app:1', 'app:101'], ['app:2', 'app:102']]));
    expect(recipe).toEqual({ a: ['app:101', { b: 'app:102' }], c: 'app:3', d: 'application:1', e: 'app:' });
    expect(unknown).toEqual(['app:3']);
  });

  it('takes values out by path, list entries highest first', () => {
    const recipe = { programs: [{ name: 'a', sorter: 'app:1', filters: ['x', 'app:2', 'app:3'] }] };
    expect(withoutPaths(recipe, ['programs.0.filters.1', 'programs.0.filters.2', 'programs.0.sorter'])).toEqual({ programs: [{ name: 'a', filters: ['x'] }] });
    expect(recipe.programs[0]!.sorter).toBe('app:1');
  });
});
