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
    expect(h.prompts.join('')).toContain('Organization');
    expect(h.err()).toContain('acme-two');
    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /apps']);
  });

  it('refuses with the list, and sends nothing, when nothing picks one and there is no terminal', async () => {
    const h = harness([]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.err()).toBe(
      'siren: You belong to 2 organizations: acme (Acme) and acme-two (Acme Two). Pick one with --org <slug>, SIREN_ORG, or "org" in siren.app.json.\n',
    );
    expect(h.sent()).toEqual([]);
  });

  it('asks Siren again before it refuses an organization the login did not list, since the person may have joined it since', async () => {
    const h = harness([AuthAnswers.memberships()]);
    h.signedIn({ [SANDBOX_BASE_URL]: twoOrgs() });
    expect(await h.run(['apps', 'list', '--org', 'other'])).toBe(1);
    expect(h.err()).toContain('You are not in an organization named other. Yours are acme (Acme) and acme-two (Acme Two).');
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
    expect(h.err()).toContain('SIREN_TOKEN acts in Acme (acme), and --org names acme-two.');
    expect(h.paths()).toEqual(['GET /personal-tokens/current']);

    const file = harness([about], { env: { SIREN_TOKEN: token } });
    file.write('siren.app.json', appFile('acme-two'));
    expect(await file.run(['apps', 'list'])).toBe(1);
    expect(file.err()).toContain('SIREN_TOKEN acts in Acme (acme), and siren.app.json names acme-two.');
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
