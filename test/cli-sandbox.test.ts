import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, runCli } from '../src/cli/run';
import { rewriteFeatureRefs, withoutPaths } from '../src/cli/commands/sandbox';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { ACCESS_1, ACCESS_2, AuthAnswers, REFRESH_2, harness, membershipAcme, session } from './cli-fakes';
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

// Login keeps the person's memberships, so the resolver reads them without asking Siren.
const liveSession = session({ edition: 'production', baseUrl: LIVE, orgId: 9, orgName: 'Acme', orgSlug: 'acme', memberships: [{ ...membershipAcme, orgId: 9 }] });
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

/** A recipe refusal as Siren's 422 sends it, from POST /recipes/preview or /recipes/apply. */
function recipeRefused(errors: Array<Record<string, string>>) {
  return reply(422, { error: { message: 'Recipe validation failed.', context: { type: 'RECIPE_VALIDATION_FAILED', errors } } });
}

/** A field Siren's validator refuses, as the dev data generator's sorter is (contract/devtools-generator-sorter-bug.md). */
const BAD_SORTER = {
  path: 'programGroups.group_1.sorter',
  message: "Invalid sorter 'alphabetical'. Valid values: newestBindingWins, oldestBindingWins.",
  code: 'UNKNOWN_VALUE',
};

/**
 * What POST /recipes/preview answers for the exported recipe: Siren refuses
 * every `app:` choice in any recipe (code APP_FEATURE), and the copy turns or
 * drops those after it makes the apps, so this refusal lets the copy go on.
 */
const APP_CHOICES = [
  { path: 'programs.0.postConversionActions.0.type', message: "Invalid post conversion action 'app:11'. A recipe names only built-in choices.", code: 'APP_FEATURE' },
  { path: 'programs.1.sorter', message: "Invalid sorter 'app:12'. A recipe names only built-in choices.", code: 'APP_FEATURE' },
];
function previewOnlyAppChoices() {
  return recipeRefused(APP_CHOICES);
}

function copyReplies(apply = reply(202, { success: true, jobId: 'job1', status: 'queued' }), preview = previewOnlyAppChoices()) {
  return [
    exported(),
    reply(200, [appRecord()]),
    preview,
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
      'POST /recipes/preview',
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

    // The setup is checked on the sandbox, in the person's own organization there, before anything is made.
    expect(bodyOf(h.http.requests[2])).toMatchObject({ configurationOnly: true, programGroups: [{ name: 'All' }] });
    expect(h.http.bearers()[2]).toBe(`Bearer ${ACCESS_1}`);
    expect(bodyOf(h.http.requests[3])).toEqual({ name: 'Acme (sandbox)' });
    const declared = bodyOf(h.http.requests[5]) as Record<string, unknown>;
    expect(declared).toMatchObject({ name: 'Acme' });
    // No sandbox ask may reach the client's real server, so the copy has no address.
    expect(declared).not.toHaveProperty('url');
    expect(JSON.stringify(declared)).not.toContain('acme.example');
    expect(declared).not.toHaveProperty('rawKey');
    expect((declared.features as Array<Record<string, unknown>>).map((feature) => feature.key)).toEqual(['notify-crm', 'acme-ledger']);
    expect((declared.features as Array<Record<string, unknown>>)[1]).toMatchObject({ currencies: ['USD'], answerWindowMinutes: 1 });

    const applied = bodyOf(h.http.requests[6]) as Record<string, unknown>;
    expect(applied.configurationOnly).toBe(true);
    expect(JSON.stringify(applied.programs)).toContain('"app:111"');
    expect(JSON.stringify(applied.programs)).toContain('"app:112"');
    expect(JSON.stringify(applied)).not.toMatch(/"app:1[12]"/);

    // The new organization's token served this run only. Both sessions keep their organization, and the copy is on record.
    expect(h.http.bearers().slice(5)).toEqual([`Bearer ${ACCESS_2}`, `Bearer ${ACCESS_2}`, `Bearer ${ACCESS_2}`]);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 3, accessToken: ACCESS_1 });
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
    expect(out).toMatch(/Apps +acme-payouts \(no address, run siren listen or set one\)/);
    expect(out).toContain('siren listen --org acme-sandbox --app acme-payouts');
    expect(out).toContain('collaborators');
    expect(out).toContain('1 programs, the export leaves them out');
    expect(out).toContain('siren seed --org acme-sandbox --sales 50');
    expect(out).toContain('siren sandbox inbox --org acme-sandbox');
    expect(out).toContain('Set SIREN_ORG=acme-sandbox to leave out --org.');
    expect(out).not.toContain('using');
    for (const line of out.split('\n')) expect([...line].length).toBeLessThanOrEqual(80);
  });

  it('keeps only the features that need no address when the sandbox refuses an app with none', async () => {
    const refused = reply(422, {
      error: {
        message: 'acme-payouts has features that need an address.',
        context: { reason: 'app_items_need_key_and_address', app: APP_KEY, missing: ['address'], field: 'items' },
      },
    });
    const replies = copyReplies();
    replies.splice(5, 1, refused, reply(201, { ...appRecord(), id: 70, features: [], rawKey: RAW_KEY, signingSecret: null }));
    const h = harness(replies, { edition: sandboxFirst });
    signedInBoth(h);

    expect(await h.run(['sandbox', 'create', '--from', 'acme', '--json']), h.err()).toBe(0);
    expect(h.paths().slice(5, 7)).toEqual([`PUT /apps/${APP_KEY}`, `PUT /apps/${APP_KEY}`]);
    const second = bodyOf(h.http.requests[6]) as Record<string, unknown>;
    expect(second).not.toHaveProperty('url');
    expect(second).not.toHaveProperty('events');
    expect(second.features).toEqual([]);
    const answer = JSON.parse(h.out()) as { copied: { apps: unknown[] }; notCopied: Array<{ what: string; why: string }> };
    expect(answer.copied.apps).toEqual([{ key: APP_KEY, features: 0 }]);
    expect(answer.notCopied).toContainEqual({ what: 'acme-payouts: 2 features', why: 'this sandbox needs an address for them' });
    // Their references in the recipe name features that were not copied, so the copy lists those too.
    expect(answer.notCopied.map((item) => item.what)).toContain('feature app:11');
  });

  it('leaves out an app choice a recipe cannot carry, says so, and applies the rest', async () => {
    const refused = reply(422, {
      error: {
        message: 'Recipe validation failed.',
        context: { type: 'RECIPE_VALIDATION_FAILED', errors: [{ path: 'programs.1.sorter', message: "A recipe can't name an app's feature. Choose it after the recipe is applied." }] },
      },
    });
    const replies = copyReplies(refused);
    replies.splice(7, 0, reply(202, { success: true, jobId: 'job1', status: 'queued' }));
    const h = harness(replies, { edition: sandboxFirst });
    signedInBoth(h);

    expect(await h.run(['sandbox', 'create', '--from', 'acme', '--json']), h.err()).toBe(0);
    const second = bodyOf(h.http.requests[7]) as { programs: Array<Record<string, unknown>> };
    expect(second.programs[1]).toEqual({ name: 'Affiliates' });
    expect(JSON.stringify(second.programs[0])).toContain('app:111');
    const answer = JSON.parse(h.out()) as { notCopied: Array<{ what: string }>; import: { status: string } };
    expect(answer.import.status).toBe('complete');
    expect(answer.notCopied.map((item) => item.what)).toContain('app choice at programs.1.sorter');
  });

  it("checks the setup on the sandbox first, and when Siren would refuse a field makes nothing and names the field", async () => {
    const preview = recipeRefused([...APP_CHOICES, BAD_SORTER]);
    const h = harness(copyReplies(undefined, preview), { edition: sandboxFirst });
    signedInBoth(h);

    expect(await h.run(['sandbox', 'create', '--from', 'acme'])).toBe(1);
    // All or nothing: no organization, no app and no import on the sandbox.
    expect(h.paths()).toEqual(['GET /recipes/export', 'GET /apps', 'POST /recipes/preview']);
    expect(existsSync(join(h.configDir, 'sandboxes.json'))).toBe(false);
    const err = h.err().replace(/\s+/g, ' ');
    expect(err).toContain("Siren would refuse Acme's setup, so nothing was made.");
    expect(err).toContain("Siren checked it on the sandbox first and refused 1 field.");
    expect(h.err()).toContain("\nprogramGroups.group_1.sorter: Invalid sorter 'alphabetical'. Valid values: newestBindingWins, oldestBindingWins.\n");
    // The app choices are not the person's to fix. The copy handles them.
    expect(err).not.toContain('app:12');
    expect(err).toContain('Fix it in Acme on siren.acme.example, then run siren sandbox create --from acme');

    // In a terminal it is the three-part error: a red ✗ headline, Siren's reason wrapped to 80 columns, and the fix.
    const tty = harness(copyReplies(undefined, preview), { edition: sandboxFirst });
    signedInBoth(tty);
    expect(await runCli(['sandbox', 'create', '--from', 'acme'], { ...tty.io, stderrTty: true, env: { ...tty.io.env, TERM: 'xterm-256color' } })).toBe(1);
    const lines = tty.err().replace(/\u001b\[[\d;]*m/g, '').trimEnd().split('\n');
    expect(lines[0]).toBe("✗ Siren would refuse Acme's setup, so nothing was made.");
    expect(lines.slice(1)).toEqual([
      '  Siren checked it on the sandbox first and refused 1 field.',
      '  programGroups.group_1.sorter',
      "    Invalid sorter 'alphabetical'. Valid values: newestBindingWins,",
      '    oldestBindingWins.',
      '› Fix it in Acme on siren.acme.example, then run',
      '  siren sandbox create --from acme.',
    ]);
  });

  it('names how many more fields Siren refused when there are several', async () => {
    const more = { ...BAD_SORTER, path: 'programGroups.group_2.sorter', message: "Invalid sorter 'random'. Valid values: newestBindingWins, oldestBindingWins." };
    const h = harness(copyReplies(undefined, recipeRefused([BAD_SORTER, more, { ...more, path: 'programGroups.group_3.sorter' }])), { edition: sandboxFirst });
    signedInBoth(h);
    expect(await h.run(['sandbox', 'create', '--from', 'acme'])).toBe(1);
    const err = h.err().replace(/\s+/g, ' ');
    expect(err).toContain("programGroups.group_1.sorter: Invalid sorter 'alphabetical'.");
    expect(err).toContain('Siren checked it on the sandbox first and refused 3 fields.');
    // Through a pipe, one `place: message` line each, as a compiler prints them.
    expect(h.err()).toContain("\nprogramGroups.group_2.sorter: Invalid sorter 'random'.");
    expect(h.err()).toContain("\nprogramGroups.group_3.sorter: Invalid sorter 'random'.");
  });

  it('goes on to the copy when the preview fails for another reason, since the apply checks the setup again', async () => {
    const h = harness(copyReplies(undefined, reply(403, { error: { message: 'Forbidden.' } })), { edition: sandboxFirst });
    signedInBoth(h);
    expect(await h.run(['sandbox', 'create', '--from', 'acme', '--json']), h.err()).toBe(0);
    expect(h.paths()).toContain('POST /sandbox/orgs');
  });

  it("says plainly that the new organization stays, empty, when Siren refuses the setup only after it is made", async () => {
    const h = harness(copyReplies(recipeRefused([BAD_SORTER]), reply(200, { success: true, preview: {} })), { edition: sandboxFirst });
    signedInBoth(h);

    expect(await h.run(['sandbox', 'create', '--from', 'acme'])).toBe(1);
    expect(h.paths().slice(-2)).toEqual([`PUT /apps/${APP_KEY}`, 'POST /recipes/apply']);
    const err = h.err().replace(/\s+/g, ' ');
    expect(err).toContain('Made acme-sandbox, but Siren refused its setup.');
    expect(err).toContain("programGroups.group_1.sorter: Invalid sorter 'alphabetical'.");
    // Siren has no route that deletes a sandbox organization, so the tool says what is left and what to do.
    expect(err).toContain('Siren cannot delete a sandbox organization, so acme-sandbox stays, with its apps and no setup.');
    expect(err).toContain('Fix it in Acme on siren.acme.example, then run siren sandbox create --from acme');
  });

  it('reads another of the person\'s live organizations on a token for this run only', async () => {
    const globex = { orgId: 10, orgName: 'Globex', orgSlug: 'globex', role: 'admin' };
    const h = harness([reply(200, { memberships: [{ ...membershipAcme, orgId: 9 }, globex] }), AuthAnswers.tokens(ACCESS_2, REFRESH_2), ...copyReplies()], { edition: sandboxFirst });
    signedInBoth(h);
    expect(await h.run(['sandbox', 'create', '--from', 'globex', '--json']), h.err()).toBe(0);
    expect(h.paths().slice(0, 4)).toEqual(['GET /auth/memberships', 'POST /auth/switch-org', 'GET /recipes/export', 'GET /apps']);
    expect(bodyOf(h.http.requests[1])).toEqual({ orgId: 10 });
    expect(h.http.bearers().slice(2, 4)).toEqual([`Bearer ${ACCESS_2}`, `Bearer ${ACCESS_2}`]);
    expect(h.credentials().sessions[LIVE]).toMatchObject({ orgId: 9 });
    expect(JSON.parse(h.out())).toMatchObject({ from: { orgId: 10, orgSlug: 'globex' } });
  });

  it('refuses a live organization the person is not in before anything is made', async () => {
    const h = harness([reply(200, { memberships: [{ ...membershipAcme, orgId: 9 }] })], { edition: sandboxFirst });
    signedInBoth(h);
    expect(await h.run(['sandbox', 'create', '--from', 'globex'])).toBe(1);
    expect(h.paths()).toEqual(['GET /auth/memberships']);
    expect(h.err()).toContain("You're not in an organization named globex. --from names it. Yours: acme (Acme).");
    // A read needs no --live (CLI pass 3), so the hint to list them leaves it out.
    expect(h.err()).toContain('Run siren orgs --base-url https://siren.acme.example/siren/v1 to list them.');
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

  // Review round 1, C19: a read never claims to change data, and the refusal names the host, not the whole URL.
  it('says a read like sandbox list has nothing to show on a live Siren, naming its host', async () => {
    const h = harness([], { edition: 'production' });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production' }) });
    expect(await h.run(['sandbox', 'list'])).toBe(1);
    const flat = h.err().replace(/\s+/g, ' ');
    expect(flat).toContain(`siren sandbox list runs only on a sandbox Siren, and ${new URL(SANDBOX_BASE_URL).host} is live.`);
    expect(flat).not.toContain('changes test data');
    expect(flat).not.toContain(SANDBOX_BASE_URL);
    const reset = harness([], { edition: 'production' });
    reset.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production' }) });
    expect(await reset.run(['sandbox', 'reset', '--confirm', 'acme'])).toBe(1);
    expect(reset.err()).toContain('It changes test data');
  });
});

// Review round 1, C2: a Siren older than the tool answers a bare 404, and each command says what that Siren lacks.
describe('sandbox: a Siren without the sandbox routes', () => {
  const missing = () => reply(404, { error: { message: 'Not found.' } });
  for (const [argv, what] of [
    [['seed'], 'sandbox seeding'],
    [['sandbox', 'reset', '--confirm', 'acme-sandbox'], 'the sandbox tools'],
    [['sandbox', 'inbox'], 'the sandbox tools'],
  ] as const) {
    it(`siren ${argv.join(' ')} says this Siren doesn't have ${what} yet`, async () => {
      const h = harness([missing()]);
      h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme-sandbox' }) });
      expect(await h.run([...argv])).toBe(1);
      const flat = h.err().replace(/\s+/g, ' ');
      expect(flat).toContain(`This Siren doesn't have ${what} yet.`);
      expect(flat).toContain('comes with a later Siren release');
      expect(flat).not.toMatch(/(^|\s)Not found\./);
      expect(h.out()).toBe('');
    });
  }
});

describe('sandbox: what a copy takes', () => {
  it("leaves the app's contacts behind, since real people stay on the live Siren (review of PR 94)", async () => {
    const { declarationOf } = await import('../src/cli/commands/sandbox');
    const app = { key: 'acme', name: 'Acme', description: 'Acme app', url: 'https://acme.example', events: [], contacts: [{ email: 'ops@acme.example', name: 'Ops' }] };
    expect(declarationOf(app as never, [])).not.toHaveProperty('contacts');
  });
});

describe('sandbox: siren sandbox list', () => {
  it('lists the organizations and names where a copy came from', async () => {
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
      expect.objectContaining({ orgSlug: 'acme', copiedFrom: null }),
      expect.objectContaining({ orgSlug: 'acme-sandbox', copiedFrom: { baseUrl: LIVE, orgId: 9, orgSlug: 'acme', orgName: 'Acme' } }),
    ]);
    expect(answer.orgs[0]).not.toHaveProperty('current');

    const plain = listing();
    expect(await plain.run(['sandbox', 'list'])).toBe(0);
    // Through a pipe, standard output holds the table alone, and the headline and tip go to standard error (review of PR 94).
    expect(plain.err()).toContain('2 sandbox organizations on sandbox.sirenaffiliates.com');
    expect(plain.out()).toMatch(/^acme-sandbox +Acme \(sandbox\) +acme on siren\.acme\.example/m);
    expect(plain.out().split('\n')[0]).toMatch(/^ORG +NAME/);
    expect(plain.out()).not.toContain('*');
    expect(plain.out()).not.toContain('siren use');
    expect(plain.out()).not.toContain('Pass --org');
    expect(plain.err()).toContain('Pass --org <slug>, or set SIREN_ORG, to pick one.');
  });
});

describe('sandbox: siren sandbox reset', () => {
  const cleared = reply(200, { org: { orgId: 3, orgSlug: 'acme' }, cleared: { conversions: 5, obligations: 4, transactions: 3, webhook_deliveries: 2 }, total: 20 });

  it('sends the slug the person typed, and shows what it cleared', async () => {
    const h = harness([cleared], { interactive: true, typed: ['acme'] });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'reset', '--org', 'acme']), h.err()).toBe(0);
    expect(h.prompts).toEqual(['Type acme to confirm: ']);
    expect(h.paths()).toEqual(['POST /sandbox/reset']);
    expect(bodyOf(h.http.requests[0])).toEqual({ confirm: 'acme' });
    expect(h.out()).toMatch(/Conversions +5/);
    expect(h.out()).toMatch(/Deliveries +2/);
    // The six rows shown add up to 14. The other 6 of the 20 are named apart, not as a total.
    expect(h.out()).toMatch(/Also +6 rows of balances, opportunities, holds, mappings/);
    expect(h.out()).not.toContain('20');
    expect(h.out()).toContain('Kept');
    expect(h.out()).toContain('siren seed --org acme --sales 50');
  });

  it('sends nothing when the slug typed is wrong, or with no terminal and no --confirm', async () => {
    const wrong = harness([cleared], { interactive: true, typed: ['acme-live'], env: { SIREN_ORG: 'acme' } });
    wrong.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await wrong.run(['sandbox', 'reset'])).toBe(1);
    expect(wrong.paths()).toEqual([]);
    expect(wrong.err()).toContain('nothing was cleared');

    const piped = harness([cleared], { env: { SIREN_ORG: 'acme' } });
    piped.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await piped.run(['sandbox', 'reset'])).toBe(1);
    expect(piped.paths()).toEqual([]);
    expect(piped.err()).toContain('siren sandbox reset --confirm acme');

    const flagged = harness([cleared]);
    flagged.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await flagged.run(['sandbox', 'reset', '--org', 'acme', '--confirm', 'acme', '--json'])).toBe(0);
    expect(JSON.parse(flagged.out())).toMatchObject({ total: 20 });
  });

  it("passes on Siren's refusal of the slug", async () => {
    const h = harness([reply(422, { error: { message: 'Type acme to confirm. Nothing was cleared.', context: { type: 'sandbox_reset_unconfirmed', orgSlug: 'acme' } } })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'reset', '--org', 'acme', '--confirm', 'acme'])).toBe(1);
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

  it('queues the seed with the counts asked for in the person\'s only organization, waits on its job, and reports it', async () => {
    const h = harness([queued, running, done]);
    // A session login made names its organization's slug.
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['seed', '--sales', '12', '--collaborators', '3', '--months', '2', '--seed', '7']), h.err()).toBe(0);
    // The session's own organization is the only one, so nothing is asked before the seed.
    expect(h.paths()).toEqual(['POST /sandbox/seed', 'GET /jobs/seed1', 'GET /jobs/seed1']);
    expect(bodyOf(h.http.requests[0])).toEqual({ sales: 12, collaborators: 3, months: 2, seed: 7 });
    const out = h.out();
    expect(out).toContain('Seeded acme with 2 months of sales');
    expect(out).toMatch(/Sales +12 sent, 0 refused/);
    expect(out).toMatch(/Collaborators +3 \(2 made, 1 already here\)/);
    expect(out).toContain('2026-09-30 to 2026-11-23');
  });

  it('sends the defaults, and stops at the job id with --no-wait', async () => {
    const h = harness([queued]);
    h.signedIn();
    expect(await h.run(['seed', '--org', '3', '--no-wait', '--json'])).toBe(0);
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
    expect(await h.run(['seed', '--org', '3'])).toBe(1);
    expect(h.err()).toContain('No collaborator could be made.');
  });
});

describe('sandbox: siren sandbox inbox', () => {
  const email = { id: 31, recipients: ['ana@example.com'], subject: 'Your commission was approved', fromName: 'Acme', template: 'conversion-approved', createdAt: '2026-11-24T17:40:00+00:00' };

  it('lists the caught emails, newest first, and shows one with its text', async () => {
    const h = harness([reply(200, { emails: [email], total: 1 })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'inbox', '--org', 'acme', '--limit', '5']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /sandbox/inbox']);
    expect(new URL(h.http.requests[0]!.url).searchParams.get('number')).toBe('5');
    expect(h.err()).toContain("1 email in acme's sandbox inbox");
    expect(h.out()).toMatch(/#31 +2026-11-24 17:40 +ana@example\.com +Your commission was approved/);
    expect(h.err()).toContain('siren sandbox inbox --org acme 31');

    const one = harness([reply(200, { ...email, text: 'Your commission of $12.00 was approved.', html: '<p>…</p>', headers: {} })], { env: { SIREN_ORG: '3' } });
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

describe('sandbox: which organization a command acts on', () => {
  const both = () => reply(200, { memberships: [membershipAcme, sandboxOrg] });

  it('acts on another organization named with --org, on a token for this run only', async () => {
    const h = harness([both(), AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, { emails: [], total: 0 })]);
    h.signedIn();
    expect(await h.run(['sandbox', 'inbox', '--org', 'acme-sandbox']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /auth/memberships', 'POST /auth/switch-org', 'GET /sandbox/inbox']);
    expect(bodyOf(h.http.requests[1])).toEqual({ orgId: 42 });
    expect(h.http.bearers()[2]).toBe(`Bearer ${ACCESS_2}`);
    expect(h.err()).toContain("0 emails in acme-sandbox's sandbox inbox");
    expect(h.out()).toBe('');
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 3, accessToken: ACCESS_1 });
  });

  it('takes SIREN_ORG when no --org is given, and --org over it', async () => {
    const env = harness([both(), AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, { emails: [], total: 0 })], { env: { SIREN_ORG: 'acme-sandbox' } });
    env.signedIn();
    expect(await env.run(['sandbox', 'inbox']), env.err()).toBe(0);
    expect(env.err()).toContain('acme-sandbox');

    const flag = harness([reply(200, { emails: [], total: 0 })], { env: { SIREN_ORG: 'acme-sandbox' } });
    flag.signedIn();
    expect(await flag.run(['sandbox', 'inbox', '--org', '3']), flag.err()).toBe(0);
    expect(flag.paths()).toEqual(['GET /sandbox/inbox']);
  });

  it('asks for --org when the person is in several and named none, before anything else is sent', async () => {
    const h = harness([]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ memberships: [membershipAcme, sandboxOrg] }) });
    expect(await h.run(['seed'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('You belong to 2 organizations, and nothing names one.');
    expect(h.err()).toContain('Pick one with --org <slug>, SIREN_ORG');
  });

  it('refuses an organization the person is not in', async () => {
    const h = harness([both()], { env: { SIREN_ORG: 'globex' } });
    h.signedIn();
    expect(await h.run(['sandbox', 'reset', '--confirm', 'globex'])).toBe(1);
    expect(h.paths()).toEqual(['GET /auth/memberships']);
    expect(h.err()).toContain("You're not in an organization named globex. SIREN_ORG names it.");
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

describe('sandbox: what Siren sends, printed', () => {
  /** Siren's text with an escape sequence, a link and a bell in it, which must never reach the screen. */
  const sly = (text: string) => `${text}\u001b[2J\u001b]8;;https://evil.example\u0007\u009b1A`;
  /** Nothing but line breaks among the control characters, and no line past 80 columns. */
  const clear = (text: string, width = true) => {
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    if (width) for (const line of text.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  };

  it('cleans the organizations in sandbox list and the emails in sandbox inbox', async () => {
    const h = harness([reply(200, { memberships: [{ ...membershipAcme, orgName: sly('Acme'), orgSlug: sly('acme') }] })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await h.run(['sandbox', 'list']), h.err()).toBe(0);
    clear(h.out());
    expect(h.out()).toMatch(/^acme +Acme/m);

    const email = { id: 31, recipients: [sly('ana@example.com')], subject: sly('Your commission'), fromName: sly('Acme'), template: sly('conversion-approved'), createdAt: sly('2026-11-24T17:40:00+00:00') };
    const list = harness([reply(200, { emails: [email], total: 1 })]);
    list.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    expect(await list.run(['sandbox', 'inbox', '--org', 'acme']), list.err()).toBe(0);
    clear(list.out());
    expect(list.out()).toMatch(/#31 +2026-11-24 17:40 +ana@example\.com +Your commission/);

    const one = harness([reply(200, { ...email, text: `Hello,\r\n${sly('Your commission was approved.')}\n\tThanks` })], { env: { SIREN_ORG: '3' } });
    one.signedIn();
    expect(await one.run(['sandbox', 'inbox', '31']), one.err()).toBe(0);
    clear(one.out());
    expect(one.out()).toContain('Hello,\nYour commission was approved.\n');
    expect(one.out()).toMatch(/Template +conversion-approved/);
  });

  it("cleans the seed's counts and its job's error", async () => {
    const queued = reply(202, { jobId: sly('seed1'), status: 'queued', sales: 12, collaborators: 3, months: 2 });
    const done = reply(200, { jobId: 'seed1', status: 'complete', progress: { months: 2, salesSent: 12, salesRefused: 1, conversions: 14, lastRefusal: sly('No program took it.') } });
    const h = harness([queued, done]);
    h.signedIn();
    expect(await h.run(['seed', '--org', '3']), h.err()).toBe(0);
    clear(h.out());
    expect(h.out()).toMatch(/Last refusal +No program took it\./);

    const queuedOnly = harness([queued]);
    queuedOnly.signedIn();
    expect(await queuedOnly.run(['seed', '--org', '3', '--no-wait']), queuedOnly.err()).toBe(0);
    clear(queuedOnly.out());

    const failed = harness([queued, reply(200, { jobId: sly('seed1'), status: 'failed', errorMessage: sly('No collaborator could be made.'), progress: {} })]);
    failed.signedIn();
    expect(await failed.run(['seed', '--org', '3'])).toBe(1);
    // A plain error is one line by design, so only its characters are checked.
    clear(failed.err(), false);
    expect(failed.err()).toContain('No collaborator could be made.');
  });
});
