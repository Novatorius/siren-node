import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { COMMANDS } from '../src/cli/run';
import { parseAppFile } from '../src/cli/app-file';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { ACCESS_1, ACCESS_2, AuthAnswers, EMAIL, PASSWORD, REFRESH_1, REFRESH_2, harness, membershipAcme, membershipTwo, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * The organization model Alex approved on 2026-11-24: `siren login` logs
 * in the person, and each command picks its organization in this order:
 * --org, SIREN_ORG, "org" in siren.app.json, the person's only
 * organization. With none of those it asks in a terminal and refuses
 * elsewhere, with the list. The tool switches with POST /auth/switch-org
 * when the organization differs from the one its tokens act in. `siren use`
 * is gone, and every write's question names the organization.
 */

const both = [membershipAcme, membershipTwo];
const twoOrgs = () => session({ orgSlug: 'acme', memberships: both });
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };

function appFile(org?: string): string {
  return JSON.stringify({ version: 1, ...(org === undefined ? {} : { org }), apps: { [APP_KEY]: { name: 'Acme', url: '${SIREN_APP_URL}' } } });
}

describe('orgs: login logs in the person', () => {
  it('keeps every organization the person belongs to, and says how many', async () => {
    const h = harness([AuthAnswers.severalOrgs(), AuthAnswers.tokens(ACCESS_1)], { stdin: PASSWORD });
    expect(await h.run(['login', '--password-stdin', '--email', EMAIL]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/login', 'POST /auth/select-org']);
    expect(h.out()).toContain(`Logged in as ${EMAIL} · 2 organizations`);
    expect(h.credentials().sessions[SANDBOX_BASE_URL]?.memberships).toEqual(both.map(({ orgLogoUrl: _logo, ...kept }) => kept));
  });

  it('never asks which organization at login', async () => {
    const h = harness([AuthAnswers.severalOrgs(), AuthAnswers.tokens(ACCESS_1)], { stdin: PASSWORD, interactive: true });
    expect(await h.run(['login', '--password-stdin', '--email', EMAIL]), h.err()).toBe(0);
    expect(h.prompts).toEqual([]);
  });
});

describe('orgs: each command picks its organization', () => {
  it('takes --org first, and switches when the tokens act in another organization', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [appRecord()])], { env: { SIREN_ORG: 'acme' } });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list', '--org', 'acme-two']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /apps']);
    expect(JSON.parse(h.http.requests[0]!.body!)).toEqual({ orgId: 4 });
    expect(h.http.requests[1]!.headers.Authorization).toBe(`Bearer ${ACCESS_2}`);
    // The switched tokens last for this run only, so a command in another folder still starts from the session login kept.
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 3, accessToken: ACCESS_1, memberships: both });
    expect(h.credentialsText()).not.toContain(ACCESS_2);
    expect(h.credentialsText()).not.toContain(REFRESH_2);
  });

  it('refreshes the switched tokens in memory, and never writes them', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(401, {}), AuthAnswers.tokens('access-three', 'refresh-three'), reply(200, [appRecord()])]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list', '--org', 'acme-two']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /apps', 'POST /auth/refresh', 'GET /apps']);
    expect(JSON.parse(h.http.requests[2]!.body!)).toEqual({ refreshToken: REFRESH_2 });
    expect(h.http.requests[3]!.headers.Authorization).toBe('Bearer access-three');
    expect(h.credentials().sessions[SANDBOX_BASE_URL]).toMatchObject({ orgId: 3, accessToken: ACCESS_1, refreshToken: REFRESH_1 });
  });

  it('acts in the session\'s own organization for a session from before this release, and asks Siren for any other', async () => {
    const own = harness([reply(200, [appRecord()])]);
    own.signedIn({ [SANDBOX_BASE_URL]: session() });
    expect(await own.run(['apps', 'list']), own.err()).toBe(0);
    expect(own.paths()).toEqual(['GET /apps']);

    const other = harness([AuthAnswers.memberships(), AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [appRecord()])]);
    other.signedIn({ [SANDBOX_BASE_URL]: session() });
    expect(await other.run(['apps', 'list', '--org', 'acme-two']), other.err()).toBe(0);
    expect(other.paths()).toEqual(['GET /auth/memberships', 'POST /auth/switch-org', 'GET /apps']);
  });

  it('takes SIREN_ORG next, and sends no switch when the tokens already act there', async () => {
    const h = harness([reply(200, [appRecord()])], { env: { SIREN_ORG: 'acme' } });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps']);
  });

  it('takes "org" in siren.app.json next', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [appRecord()])]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    h.write('siren.app.json', appFile('acme-two'));
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /apps']);
  });

  it("takes the person's only organization last, with no question", async () => {
    const h = harness([reply(200, [appRecord()])], { interactive: true });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ memberships: [membershipAcme] }) });
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.prompts).toEqual([]);
  });

  it('asks in a terminal when nothing picks one', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [appRecord()])], { interactive: true, typed: ['acme-two'] });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.prompts.join('')).toContain('Number or slug');
    expect(h.err()).toContain('acme-two');
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /apps']);
  });

  it('refuses with the list, and sends nothing, when nothing picks one and there is no terminal', async () => {
    const h = harness([]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.err()).toBe(
      'siren: You belong to 2 organizations, and nothing names one. With no terminal to ask in, the tool needs a name. Yours: acme (Acme) and acme-two (Acme Two). ' +
        'Pick one with --org <slug>, SIREN_ORG, or "org" in siren.app.json.\n',
    );
    expect(h.sent()).toEqual([]);
  });

  it('asks Siren again before it refuses an organization the login did not list, since the person may have joined it since', async () => {
    const h = harness([AuthAnswers.memberships()]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list', '--org', 'other'])).toBe(1);
    expect(h.err()).toContain("You're not in an organization named other. --org names it. Yours: acme (Acme) and acme-two (Acme Two).");
    expect(h.paths()).toEqual(['GET /auth/memberships']);
  });
});

describe('orgs: siren use is gone, and siren orgs only lists', () => {
  it('has no use command', async () => {
    expect(COMMANDS).not.toContain('use');
    const h = harness([]);
    expect(await h.run(['use', 'acme-two'])).toBe(2);
  });

  it('lists the organizations with no marker on any', async () => {
    const h = harness([AuthAnswers.memberships()]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['orgs']), h.err()).toBe(0);
    expect(h.out()).not.toContain('*');
    expect(h.out()).toMatch(/acme\s+Acme\s+admin/);
    expect(h.out()).toMatch(/acme-two\s+Acme Two\s+admin/);
  });
});

describe('orgs: a write names its organization', () => {
  it('asks "Apply to Acme (acme), sandbox? [y/N]"', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, appRecord())], { env: URL_ENV, interactive: true, typed: ['y'] });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme' }) });
    h.write('siren.app.json', appFile());
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.prompts).toEqual(['Apply to Acme (acme), sandbox? [y/N] ']);
  });
});

describe('orgs: a personal access token carries its own organization', () => {
  const token = `siren_pat_${'ab'.repeat(24)}`;
  const about = reply(200, {
    id: 12,
    name: 'deploy',
    scopes: ['apps:manage'],
    lastFour: 'abab',
    createdAt: '2026-11-24T16:40:00+00:00',
    lastUsedAt: null,
    expiresAt: null,
    user: { id: 7, email: EMAIL, role: 'admin' },
    organization: { orgId: 3, orgName: 'Acme', orgSlug: 'acme' },
  });

  it('refuses --org or an app file that names another organization', async () => {
    const h = harness([about], { env: { SIREN_TOKEN: token } });
    expect(await h.run(['apps', 'list', '--org', 'acme-two'])).toBe(1);
    expect(h.err()).toContain('SIREN_TOKEN acts in acme, and --org names acme-two.');
    expect(h.paths()).toEqual(['GET /personal-tokens/current']);

    const file = harness([about], { env: { SIREN_TOKEN: token } });
    file.write('siren.app.json', appFile('acme-two'));
    expect(await file.run(['apps', 'list'])).toBe(1);
    expect(file.err()).toContain('SIREN_TOKEN acts in acme, and siren.app.json names acme-two.');
  });

  it('acts when they agree', async () => {
    const h = harness([about, reply(200, [appRecord()])], { env: { SIREN_TOKEN: token } });
    expect(await h.run(['apps', 'list', '--org', 'acme']), h.err()).toBe(0);
  });
});

describe('orgs: "org" in siren.app.json', () => {
  it('is in the schema and the file check, as a slug', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '..', 'siren.app.schema.json'), 'utf8')) as { properties: Record<string, { type: string }> };
    expect(schema.properties.org?.type).toBe('string');
    expect(parseAppFile(appFile('acme-two'), URL_ENV).problems).toEqual([]);
    expect(parseAppFile(JSON.stringify({ version: 1, org: 4, apps: { [APP_KEY]: { name: 'A', url: 'https://a.example' } } }), {}).problems[0]?.message).toContain('org');
  });

  it('apps init asks which organization when the person has several, and writes it', async () => {
    const h = harness([], { interactive: true, typed: ['acme-two'] });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'init', '--key', APP_KEY]), h.err()).toBe(0);
    expect(JSON.parse(h.file('siren.app.json')).org).toBe('acme-two');
    expect(h.out()).toContain('Org');
    expect(h.sent()).toEqual([]);
  });

  it('apps init takes --org, and writes no org for a person in one organization', async () => {
    const flagged = harness([]);
    flagged.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await flagged.run(['apps', 'init', '--key', APP_KEY, '--org', 'acme']), flagged.err()).toBe(0);
    expect(JSON.parse(flagged.file('siren.app.json')).org).toBe('acme');

    const one = harness([], { interactive: true });
    one.signedIn({ [SANDBOX_BASE_URL]: session({ memberships: [membershipAcme] }) });
    expect(await one.run(['apps', 'init', '--key', APP_KEY]), one.err()).toBe(0);
    expect(JSON.parse(one.file('siren.app.json')).org).toBeUndefined();
  });
});

/*
 * CLI pass 3, should-fix 5, as the coordinator ruled: the order stays
 * --org, SIREN_ORG, then the file. When SIREN_ORG and the file's "org"
 * name different organizations, a write refuses before sending, naming
 * both and the fix. A read goes ahead and says on stderr which one won.
 */
describe('orgs: SIREN_ORG and the app file disagree', () => {
  const ENV = { SIREN_ORG: 'acme' };

  it('refuses a write before sending anything, naming both and the way out', async () => {
    const h = harness([reply(200, appRecord())], { env: ENV });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    h.write('siren.app.json', appFile('acme-two'));
    expect(await h.run(['apps', 'off', APP_KEY])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toBe(
      'siren: SIREN_ORG names acme, and siren.app.json names acme-two. A change goes to one organization, so the tool won\'t guess which you meant. ' +
        'Pass --org to pick one, or unset SIREN_ORG to use siren.app.json.\n',
    );
  });

  it('acts on a write when --org settles it', async () => {
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, appRecord())], { env: ENV });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    h.write('siren.app.json', appFile('acme-two'));
    expect(await h.run(['apps', 'off', APP_KEY, '--org', 'acme-two']), h.err()).toBe(0);
    expect(h.err()).toBe('');
  });

  it('reads in the SIREN_ORG organization, and says so in a dim note on stderr', async () => {
    const h = harness([reply(200, [appRecord()])], { env: ENV });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    h.write('siren.app.json', appFile('acme-two'));
    expect(await h.run(['apps', 'list', '--json']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps']);
    expect(h.err()).toBe('› SIREN_ORG names acme, so this reads acme, not acme-two from siren.app.json.\n');
    expect(() => JSON.parse(h.out())).not.toThrow();
  });

  it('says nothing when both name the same organization, by slug or by id', async () => {
    for (const named of ['acme', '3']) {
      const h = harness([reply(200, [appRecord()]), reply(200, appRecord())], { env: { SIREN_ORG: named } });
      h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
      h.write('siren.app.json', appFile('acme'));
      expect(await h.run(['apps', 'list']), h.err()).toBe(0);
      expect(await h.run(['apps', 'off', APP_KEY]), h.err()).toBe(0);
      // Only the list's count line, which goes to stderr through a pipe, and no note about the organization.
      expect(h.err()).toMatch(/^1 app in Acme \(\w+\), sandbox\n$/);
    }
  });
});

/*
 * Pass 3 re-check, must-fix 3: the organization question in gh's shape. An
 * arrow-key list in a terminal that sends keys, name and slug, with the
 * session's organization picked to start and typing to filter. A numbered
 * list with a line answer elsewhere in a terminal. A miss asks again, and a
 * blank answer never prints an empty name.
 */
describe('orgs: the organization question', () => {
  const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
  // Acme is the session's own organization, so picking it sends no switch.
  const repliesFor = (slug: string) => (slug === 'acme' ? [reply(200, [appRecord()])] : [AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [appRecord()])]);
  const ttyRun = async (keys: readonly string[], slug = 'acme-two') => {
    const { runCli } = await import('../src/cli/run');
    const { fakeScreen } = await import('./cli-screen-fake');
    const h = harness(repliesFor(slug), { interactive: true });
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    const screen = fakeScreen({ type: keys });
    const code = await runCli(['apps', 'list', '-q'], { ...h.io, screen: screen.screen, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });
    return { h, code };
  };

  it('in a terminal that sends keys: lists name and slug, starts on the session organization, and moves with the arrows', async () => {
    const { h, code } = await ttyRun(['\u001b[B', '\r']);
    expect(code, h.err()).toBe(0);
    const text = strip(h.err());
    expect(text).toContain('? Which organization? Arrows move, typing filters, Enter picks.');
    expect(text).toMatch(/❯ Acme {6}acme\n/);
    expect(text).toMatch(/ {2}Acme Two {2}acme-two\n/);
    expect(text).toContain('? Which organization? Acme Two (acme-two)');
    expect(text).toContain('› Skip this next time with --org acme-two or SIREN_ORG=acme-two.');
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /apps']);
  });

  it('takes the start of a slug typed into the list', async () => {
    const { h, code } = await ttyRun(['acme-t', '\r']);
    expect(code, h.err()).toBe(0);
    expect(strip(h.err())).toContain('? Which organization? Acme Two (acme-two)');
  });

  it('takes the session organization on Enter alone, and sends no switch', async () => {
    const { h, code } = await ttyRun(['\r'], 'acme');
    expect(code, h.err()).toBe(0);
    expect(strip(h.err())).toContain('? Which organization? Acme (acme)');
    expect(h.paths()).toEqual(['GET /apps']);
  });

  it('stops with three parts on Ctrl-C, and sends nothing', async () => {
    const { h, code } = await ttyRun(['\u0003']);
    expect(code).toBe(1);
    expect(strip(h.err())).toMatch(/✗ No organization picked\.\n {2}Ctrl-C stopped the question, so nothing was sent\.\n› Run it again, or pass --org <slug>\./);
    expect(h.paths()).toEqual([]);
  });

  it('asks by line where keys do not come: takes a number, a slug or its start, and the session organization when blank', async () => {
    for (const [typed, slug] of [['2', 'acme-two'], ['acme-two', 'acme-two'], ['Acme T', 'acme-two'], ['', 'acme']] as const) {
      const h = harness(repliesFor(slug), { interactive: true, typed: [typed] });
      h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
      expect(await h.run(['apps', 'list']), `${typed}: ${h.err()}`).toBe(0);
      expect(h.err()).toContain('Which organization?\n  1  Acme      acme\n  2  Acme Two  acme-two\n');
      expect(h.prompts).toEqual(['Number or slug [acme]: ']);
      expect(h.err(), typed).toContain(`Skip this next time with --org ${slug} or SIREN_ORG=${slug}.`);
    }
  });

  it('asks again on a miss, three times at most, and never names an empty organization', async () => {
    const again = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), reply(200, [appRecord()])], { interactive: true, typed: ['nope', '2'] });
    again.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await again.run(['apps', 'list']), again.err()).toBe(0);
    expect(again.err()).toContain('nope is none of them. Type a number or a slug.');
    expect(again.prompts).toHaveLength(2);

    const misses = harness([], { interactive: true, typed: ['x', 'y', 'z'] });
    misses.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await misses.run(['apps', 'list'])).toBe(1);
    expect(misses.err()).toContain('siren: No organization picked. z named none of them, so nothing was sent. Run it again, or pass --org <slug>.');
    expect(misses.err()).not.toMatch(/named \./);
    expect(misses.http.requests).toHaveLength(0);
  });
});
