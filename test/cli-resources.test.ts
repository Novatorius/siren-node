import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { RESOURCE_COMMANDS } from '../src/cli/resources.generated';
import { apiPath, fieldValue, setNested } from '../src/cli/commands/resources';
import { runCli } from '../src/cli/run';
import { ACCESS_2, AuthAnswers, REFRESH_2, harness, membershipAcme, membershipTwo, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * devtools resources lane: `siren <resource> <op>` and `siren get|post|put|
 * patch|delete <path>`. Contract: contract/devtools-resources.md in the
 * devtools run folder, section 4. Siren's answers follow GetPrograms.php and
 * ListResponseWrapperInterceptor.php on feat/apps 6d2abd936a.
 */

const LIVE = 'https://live.example.com/siren/v1';

const programs = [
  { id: 1, name: 'Referral program', status: 'active', units: 'usd' },
  { id: 2, name: 'Partner program', status: 'draft', units: 'usd' },
];

function envelope(items: unknown[], page = 1, totalPages = 1, total = items.length, perPage = 10) {
  return { items, total, page, perPage, totalPages };
}

function signedIn(replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) {
  const h = harness(replies, options);
  h.signedIn();
  return h;
}

function signedInLive(replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) {
  const h = harness(replies, { edition: 'production', ...options });
  h.signedIn({ [LIVE]: session({ edition: 'production', baseUrl: LIVE }) });
  return h;
}

describe('the generated resource commands', () => {
  it('generates programs with all five operations from the spec', () => {
    const programsCommand = RESOURCE_COMMANDS.find((resource) => resource.name === 'programs');
    expect(programsCommand?.ops.list).toMatchObject({ method: 'GET', path: '/programs', paginated: true });
    expect(programsCommand?.ops.get).toMatchObject({ method: 'GET', path: '/programs/{id}' });
    expect(programsCommand?.ops.create).toMatchObject({ method: 'POST', path: '/programs' });
    expect(programsCommand?.ops.update?.path).toBe('/programs/{id}');
    expect(programsCommand?.ops.delete).toMatchObject({ method: 'DELETE', path: '/programs/{id}' });
  });

  it('leaves the apps and auth routes to their hand-written commands', () => {
    const names = RESOURCE_COMMANDS.map((resource) => resource.name);
    expect(names).not.toContain('apps');
    expect(names).not.toContain('auth');
  });

  it('lists programs as an aligned table with a Next line', async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await h.run(['programs', 'list'])).toBe(0);
    expect(h.paths()).toEqual(['GET /programs']);
    // Through a pipe, standard output is the table alone, and the count, Next and tip go to standard error.
    const out = h.out();
    // The default columns leave units out, so the tip says how to pick others.
    // Review round 1, C12: split by tabs, with no padding, as every piped list is.
    expect(out).toBe(['ID\tNAME\tSTATUS', '1\tReferral program\tactive', '2\tPartner program\tdraft', ''].join('\n'));
    expect(h.err()).toBe(['2 programs', '', 'Next', '  siren programs get 1', '', '--json prints the answer as JSON. --ids prints the ids alone. --fields picks the columns.', ''].join('\n'));
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('shows one program as a record view, its name in the headline, with one request', async () => {
    const h = signedIn([reply(200, programs[0])]);
    expect(await h.run(['programs', 'get', '1'])).toBe(0);
    expect(h.paths()).toEqual(['GET /programs/1']);
    expect(h.out()).toBe('program 1 · Referral program\n\n  status  active\n  units   usd\n');
  });

  it('prints Siren\'s answer as JSON with --json, and nothing else', async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await h.run(['programs', 'list', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual(envelope(programs));
  });

  it('creates with -d fields, coercing numbers and booleans', async () => {
    const h = signedIn([reply(201, { id: 9, name: 'New', units: 'usd' })]);
    expect(await h.run(['programs', 'create', '-d', 'name=New', '-d', 'units=usd', '-d', 'limit=5', '-d', 'live=true'])).toBe(0);
    expect(h.paths()).toEqual(['POST /programs']);
    expect(JSON.parse(h.http.requests[0]!.body!)).toEqual({ name: 'New', units: 'usd', limit: 5, live: true });
    expect(h.out()).toContain('program 9 saved in Acme (3), sandbox\n');
  });

  it("keeps -d text as text where openapi types the field a string, and reads numbers where it types one (review of PR 94)", async () => {
    const h = signedIn([]);
    expect(await h.run(['programs', 'create', '-d', 'name=2026', '-d', 'expirationDays=30', '-d', 'incentiveTypeArgs[transactionPercent]=12.5', '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(h.out()).body).toEqual({ name: '2026', expirationDays: 30, incentiveTypeArgs: { transactionPercent: 12.5 } });
    const raw = signedIn([]);
    expect(await raw.run(['post', '/programs', '-d', 'name=2026', '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(raw.out()).body).toEqual({ name: '2026' });
  });

  it('clears a nullable field with -d key=null, and refuses null for a field Siren never takes empty', async () => {
    const h = signedIn([]);
    expect(await h.run(['application-forms', 'update', '3', '-d', 'confirmationUrl=null', '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(h.out()).body).toEqual({ confirmationUrl: null });
    const raw = signedIn([]);
    expect(await raw.run(['put', '/application-forms/3', '-d', 'confirmationUrl=null', '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(raw.out()).body).toEqual({ confirmationUrl: null });
    const refused = signedIn([]);
    expect(await refused.run(['application-forms', 'update', '3', '-d', 'name=null', '--dry-run'])).toBe(2);
    expect(refused.err()).toContain("name can't be cleared with null");
    expect(refused.http.requests).toHaveLength(0);
  });

  it('updates with the method the spec names for the route', async () => {
    const programsCommand = RESOURCE_COMMANDS.find((resource) => resource.name === 'programs')!;
    const h = signedIn([reply(200, { id: 1, name: 'Renamed' })]);
    expect(await h.run(['programs', 'update', '1', '-d', 'name=Renamed'])).toBe(0);
    expect(h.paths()).toEqual([`${programsCommand.ops.update!.method} /programs/1`]);
  });

  it('refuses an operation the resource lacks, naming the ones it has', async () => {
    const h = signedIn([]);
    expect(await h.run(['programs', 'frobnicate'])).toBe(2);
    expect(h.err()).toContain('siren programs has no frobnicate. It has list, get, create, update, delete.');
    expect(h.paths()).toEqual([]);
  });

  it('lists the operations for a resource named alone, sending nothing', async () => {
    const h = harness([]);
    expect(await h.run(['programs'])).toBe(0);
    expect(h.out()).toContain('siren programs list');
    expect(h.out()).toContain('GET /programs');
    expect(h.sent()).toEqual([]);
  });

  it('lists every resource with siren resources', async () => {
    const h = harness([]);
    expect(await h.run(['resources'])).toBe(0);
    // Through a pipe, standard output holds one resource a line, and the count goes to standard error (review round 1, C12).
    expect(h.err()).toContain(`${RESOURCE_COMMANDS.length} resources, generated from Siren's API`);
    expect(h.out()).toMatch(/^programs +list get create update delete$/m);
    expect(h.out().trim().split('\n')).toHaveLength(RESOURCE_COMMANDS.length);
  });
});

describe('siren get, post, put, patch and delete', () => {
  it('reads any path, with or without the leading slash or /siren/v1', async () => {
    const h = signedIn([reply(200, envelope(programs)), reply(200, envelope(programs)), reply(200, envelope(programs))]);
    expect(await h.run(['get', '/programs'])).toBe(0);
    expect(await h.run(['get', 'programs'])).toBe(0);
    expect(await h.run(['get', '/siren/v1/programs'])).toBe(0);
    expect(h.paths()).toEqual(['GET /programs', 'GET /programs', 'GET /programs']);
  });

  it('sends -d as query parameters on a read, with --limit and --offset as number and offset', async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await h.run(['get', '/programs', '-d', 'status=active', '--limit', '2', '--offset', '4'])).toBe(0);
    const url = new URL(h.http.requests[0]!.url);
    // A raw get of a list route asks for what programs list does, newest first with its fields (review round 1, C26).
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ status: 'active', number: '2', offset: '4', orderBy: 'id', order: 'desc' });
  });

  it('follows every page with --all and prints one envelope holding them all with --json', async () => {
    const h = signedIn([
      reply(200, envelope([programs[0]], 1, 2, 2, 1)),
      reply(200, envelope([programs[1]], 2, 2, 2, 1)),
    ]);
    expect(await h.run(['get', '/programs', '--limit', '1', '--all', '--json'])).toBe(0);
    expect(h.http.requests.map((request) => new URL(request.url).searchParams.get('offset'))).toEqual([null, '1']);
    // The same shape as one page, so a script reads .items either way (review of PR 94).
    expect(JSON.parse(h.out())).toEqual({ items: programs, total: 2, page: 1, perPage: 2, totalPages: 1 });
  });

  it('says how many pages there are when it read one of several', async () => {
    const h = signedIn([reply(200, envelope(programs, 1, 3, 6, 2))]);
    expect(await h.run(['get', '/programs'])).toBe(0);
    expect(h.err()).toContain('2 programs  page 1 of 3\n');
    expect(h.err()).toContain('--all reads every page.');
  });

  it('builds a body from --data @file and lays -d fields over it', async () => {
    const h = signedIn([reply(201, { id: 3 })]);
    h.write('program.json', JSON.stringify({ name: 'From file', units: 'usd', settings: { a: 1 } }));
    expect(await h.run(['post', '/programs', '--data', '@program.json', '-d', 'name=Over', '-d', 'settings[b]=2'])).toBe(0);
    expect(JSON.parse(h.http.requests[0]!.body!)).toEqual({ name: 'Over', units: 'usd', settings: { a: 1, b: 2 } });
  });

  it('prints the request with --dry-run and sends nothing, not even the edition read', async () => {
    const h = harness([]);
    expect(await h.run(['post', '/programs', '-d', 'name=Referral program', '--dry-run'])).toBe(0);
    expect(h.out()).toBe(`Would send POST ${SANDBOX_BASE_URL}/programs\n\n  body   {"name":"Referral program"}\n`);
    expect(h.err()).toBe('Nothing was sent.\n');
    expect(h.sent()).toEqual([]);
  });

  it('refuses a full address, so the session goes only to the Siren it targets', async () => {
    const h = signedIn([]);
    expect(await h.run(['get', 'https://evil.example.com/siren/v1/programs'])).toBe(2);
    expect(h.err()).toContain('Give a path such as /programs, not an address.');
    expect(h.sent()).toEqual([]);
  });

  it('refuses a path that leaves /siren/v1, plain or encoded, and sends nothing', async () => {
    for (const path of [
      '/../../wp-json/wp/v2/users',
      '/programs/../../../wp-json/wp/v2/users',
      '/siren/v1/../../wp-json',
      '/%2e%2e/%2E%2E/wp-json',
      '/.%2e/wp-json',
      '/%252e%252e/wp-json',
      '/..\\..\\wp-json',
      '/programs/..%2F..%2Fwp-json',
      '/programs/%2e%2e%5c%2e%2e%5cwp-json',
    ]) {
      const h = signedIn([]);
      expect(await h.run(['get', path]), path).toBe(2);
      expect(h.err(), path).toContain('leaves /siren/v1');
      expect(h.sent(), path).toEqual([]);
    }
  });

  it('resolves dot segments that stay inside /siren/v1', async () => {
    const h = signedIn([reply(200, { id: 8 })]);
    expect(await h.run(['get', '/programs/./7/../8'])).toBe(0);
    expect(h.paths()).toEqual(['GET /programs/8']);
  });

  it('refuses a record id that is a dot segment', async () => {
    const h = signedIn([]);
    expect(await h.run(['programs', 'get', '..'])).toBe(2);
    expect(h.err()).toContain('is not a record id');
    expect(h.sent()).toEqual([]);
  });

  it('refuses a raw delete that names no record, before asking or sending', async () => {
    for (const path of ['/programs', '/coupon-codes', '/programs/7/frobnicate']) {
      const h = signedInLive([reply(200, {})], { env: { SIREN_BASE_URL: LIVE }, interactive: true, typed: ['programs'] });
      expect(await h.run(['delete', path, '--live']), path).toBe(2);
      expect(h.err(), path).toContain('needs a path that names one record');
      expect(h.prompts, path).toEqual([]);
      expect(h.paths(), path).toEqual([]);
    }
  });

  it('asks for the record id, not the last path segment, before a live raw delete', async () => {
    const h = signedInLive([reply(200, {})], { env: { SIREN_BASE_URL: LIVE }, interactive: true, typed: ['app_1'] });
    expect(await h.run(['delete', '/apps/app_1/key', '--live'])).toBe(0);
    expect(h.prompts[0]).toBe('This deletes app_1 from Acme (3), live. Type app_1 to delete it: ');
    expect(h.paths()).toEqual(['DELETE /apps/app_1/key']);
  });

  it('prints a refusal in three parts: what, why, and the command that helps', async () => {
    const h = signedIn([reply(404, { error: { message: 'Program not found.', code: 'not_found' } })]);
    expect(await h.run(['programs', 'get', '99'])).toBe(1);
    expect(h.err()).toBe('siren: Siren has no program 99 in organization 3. Siren answered 404 not_found: Program not found. Run siren programs list to list the programs there.\n');
  });

  it('styles the refusal in a terminal: a red ✗ headline, the why, and the command to run', async () => {
    const h = signedIn([reply(404, { error: { message: 'Program not found.', code: 'not_found' } })]);
    expect(await runCli(['programs', 'get', '99'], { ...h.io, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(1);
    const plain = h.err().replace(/\u001b\[[\d;]*m/g, '');
    expect(plain).toBe('✗ Siren has no program 99 in organization 3.\n  Siren answered 404 not_found: Program not found.\n› Run siren programs list to list the programs there.\n');
  });

  it('styles a list in a terminal: a green ✓ headline and a dim header', async () => {
    const h = signedIn([reply(200, envelope(programs))]);
    expect(await runCli(['programs', 'list'], { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(0);
    expect(h.out()).toContain('✓');
    expect(h.out()).toContain('\u001b[2mID  NAME');
    const plain = h.out().replace(/\u001b\[[\d;]*m/g, '');
    expect(plain).toContain('› --json prints the answer as JSON.');
    for (const line of plain.split('\n')) expect([...line].length).toBeLessThanOrEqual(80);
  });

  it('prints a refusal as JSON on standard error with --json', async () => {
    const h = signedIn([reply(404, { error: { message: 'Program not found.', code: 'not_found' } })]);
    expect(await h.run(['get', '/programs/99', '--json'])).toBe(1);
    expect(JSON.parse(h.err())).toEqual({ error: { message: 'Program not found.', status: 404, code: 'not_found', fix: 'siren programs list to see what is there', context: null } });
    expect(h.out()).toBe('');
  });
});

describe('the live guard', () => {
  it('reads a live organization without --live', async () => {
    const h = signedInLive([reply(200, envelope(programs))], { env: { SIREN_BASE_URL: LIVE } });
    expect(await h.run(['programs', 'list'])).toBe(0);
  });

  it('refuses a live write without --live, before sending it', async () => {
    const h = signedInLive([reply(201, { id: 3 })], { env: { SIREN_BASE_URL: LIVE } });
    expect(await h.run(['post', '/programs', '-d', 'name=X'])).toBe(1);
    expect(h.err()).toContain('is a live Siren. A change to a live organization needs --live, so none happens by accident. Run siren post /programs -d name=X --live.');
    expect(h.paths()).toEqual([]);
  });

  it('sends a live write with --live', async () => {
    const h = signedInLive([reply(201, { id: 3 })], { env: { SIREN_BASE_URL: LIVE } });
    expect(await h.run(['post', '/programs', '-d', 'name=X', '--live'])).toBe(0);
    expect(h.paths()).toEqual(['POST /programs']);
  });

  it('asks for the id to be typed before a live delete, and sends nothing when it is wrong', async () => {
    const h = signedInLive([reply(200, {})], { env: { SIREN_BASE_URL: LIVE }, interactive: true, typed: ['12'] });
    expect(await h.run(['programs', 'delete', '7', '--live'])).toBe(1);
    expect(h.prompts[0]).toBe('This deletes 7 from Acme (3), live. Type 7 to delete it: ');
    expect(h.err()).toContain('Nothing was deleted. You typed "12", not "7".');
    expect(h.paths()).toEqual([]);
  });

  it('deletes on a live organization once the id is typed', async () => {
    const h = signedInLive([reply(200, { id: 7 })], { env: { SIREN_BASE_URL: LIVE }, interactive: true, typed: ['7'] });
    expect(await h.run(['delete', '/programs/7', '--live'])).toBe(0);
    expect(h.paths()).toEqual(['DELETE /programs/7']);
  });

  it('needs --confirm with the id for a live delete with no terminal', async () => {
    const h = signedInLive([reply(200, { id: 7 })], { env: { SIREN_BASE_URL: LIVE } });
    expect(await h.run(['programs', 'delete', '7', '--live'])).toBe(1);
    expect(h.err()).toContain('Run siren programs delete 7 --confirm 7 --live.');
    expect(h.paths()).toEqual([]);
    expect(await h.run(['programs', 'delete', '7', '--live', '--confirm', '8'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(await h.run(['programs', 'delete', '7', '--live', '--confirm', '7'])).toBe(0);
    expect(h.paths()).toEqual(['DELETE /programs/7']);
  });

  it('asks nothing before a sandbox delete', async () => {
    const h = signedIn([reply(200, { id: 7 })], { interactive: true });
    expect(await h.run(['programs', 'delete', '7'])).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.paths()).toEqual(['DELETE /programs/7']);
  });
});

describe('the organization a record command acts in', () => {
  const twoOrgs = () => session({ orgSlug: 'acme', memberships: [membershipAcme, membershipTwo] });

  it('acts in the organization --org names, on tokens switched for this run', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, envelope(programs))]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['programs', 'list', '--org', 'acme-two']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /programs']);
    expect(h.http.requests[1]!.headers.Authorization).toBe(`Bearer ${ACCESS_2}`);
  });

  it('takes SIREN_ORG for a raw request too', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(201, { id: 3 })], { env: { SIREN_ORG: 'acme-two' } });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['post', '/programs', '-d', 'name=X']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'POST /programs']);
    expect(h.out()).toContain(`saved in ${membershipTwo.orgName} (acme-two), sandbox`);
  });

  it('refuses with the list when the person has several and nothing names one, sending nothing', async () => {
    const h = harness([]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['programs', 'list'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('acme-two');
  });
});

describe('record command helpers', () => {
  it('reads -d values as JSON scalars or text', () => {
    expect(fieldValue('5')).toBe(5);
    expect(fieldValue('-2.5')).toBe(-2.5);
    expect(fieldValue('true')).toBe(true);
    expect(fieldValue('null')).toBe(null);
    expect(fieldValue('007')).toBe('007');
    expect(fieldValue('usd')).toBe('usd');
  });

  it('nests a[b][c] keys', () => {
    const target: Record<string, unknown> = {};
    setNested(target, 'a[b][c]', 1);
    setNested(target, 'a[d]', 2);
    expect(target).toEqual({ a: { b: { c: 1 }, d: 2 } });
  });

  it('splits a query string off a path', () => {
    expect(apiPath('/programs?status=active')).toEqual({ path: '/programs', query: { status: 'active' } });
  });
});

describe("what Siren answers, printed", () => {
  /** Siren's text with an escape sequence, a link and a bell in it, which must never reach the screen. */
  const sly = (text: string) => `${text}\u001b[2J\u001b]8;;https://evil.example\u0007\u009b1A`;
  /** Only the style module's own color codes, no other control character, and no line past 80 columns. */
  const clear = (text: string, width = true) => {
    const bare = text.replace(/\u001b\[[\d;]*m/g, '');
    expect(bare).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    if (width) for (const line of bare.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    return bare;
  };
  const terminal = (h: ReturnType<typeof harness>) => ({ ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });

  it('cleans every cell of a list, every label and value of a record, and a bare answer', async () => {
    const rows = [{ id: sly('1'), name: sly('Referral program'), status: 'active' }, { id: 2, name: 'Partner\nprogram', status: sly('draft') }];
    const list = signedIn([reply(200, envelope(rows))]);
    expect(await runCli(['programs', 'list'], terminal(list))).toBe(0);
    const shown = clear(list.out());
    expect(shown).toMatch(/1 +Referral program +active/);
    expect(shown).toContain('siren programs get 1');

    const one = signedIn([reply(200, { id: sly('7'), [sly('name')]: sly('Referral program'), rules: { note: sly('x') } })]);
    expect(await runCli(['programs', 'get', '7'], terminal(one))).toBe(0);
    expect(clear(one.out())).toMatch(/name +Referral program/);

    const plain = signedIn([reply(200, { id: 7, name: sly('Referral program') })]);
    expect(await plain.run(['programs', 'get', '7'])).toBe(0);
    expect(plain.out()).not.toContain('\u001b');

    const bare = signedIn([reply(200, sly('pong'))]);
    expect(await runCli(['get', '/ping'], terminal(bare))).toBe(0);
    expect(clear(bare.out())).toContain('pong');
  });

  it("cleans Siren's words in a refusal", async () => {
    const h = signedIn([reply(404, { error: { message: sly('Program not found.'), code: 'not_found' } })]);
    expect(await runCli(['programs', 'get', '99'], terminal(h))).toBe(1);
    expect(clear(h.err())).toContain('Program not found.');
  });
});
