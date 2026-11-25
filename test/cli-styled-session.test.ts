import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, membershipAcme, membershipTwo, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * whoami, orgs and logout in the report shape (review/cli-dx/
 * output-catalog.md in the run folder, "Session"): who in the headline,
 * aligned dim labels, the host instead of the whole address, live in
 * amber, and the organization in use marked.
 */

const ESC = '\u001b[';
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const tty = (h: ReturnType<typeof harness>, env: Record<string, string> = {}) => ({ ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color', ...env } });
const both = [
  { orgId: 3, orgName: 'Acme', orgSlug: 'acme', role: 'admin' },
  { orgId: 4, orgName: 'Acme Two', orgSlug: 'acme-two', role: 'member' },
];

describe('siren whoami', () => {
  it('names who in the headline, then the organization, the other ones, the Siren by host, and the session file', async () => {
    const h = harness([]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme', memberships: both }) });
    expect(await h.run(['whoami']), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        'Logged in as dev@acme.example',
        '',
        '  Org       Acme (acme) · admin',
        '  Also in   acme-two',
        '  Siren     sandbox.sirenaffiliates.com · sandbox',
        `  Session   ${h.credentialsPath}`,
        '',
      ].join('\n'),
    );
    expect(h.out()).not.toContain('/siren/v1');
    expect(h.sent()).toEqual([]);
  });

  it('in a terminal: a ✓, dim labels, and live in amber', async () => {
    const h = harness([], { edition: 'production' });
    h.signedIn({ 'https://api.sirenaffiliates.com/siren/v1': session({ edition: 'production', baseUrl: 'https://api.sirenaffiliates.com/siren/v1' }) });
    expect(await runCli(['whoami', '--live'], tty(h))).toBe(0);
    expect(strip(h.out())).toContain('✓ Logged in as dev@acme.example');
    expect(h.out()).toContain(`${ESC}2mOrg${ESC}0m`);
    expect(h.out()).toContain(`api.sirenaffiliates.com · ${ESC}33mlive${ESC}0m`);
  });

  it('with SIREN_TOKEN: the token by name and last four, who, the organization, the Siren, and when it expires', async () => {
    const TOKEN = `siren_pat_${'a'.repeat(44)}9f3c`;
    const h = harness([
      reply(200, { id: 9, name: 'CI deploy', lastFour: '9f3c', expiresAt: '2027-01-31T00:00:00+00:00', user: { id: 7, email: 'dev@acme.example', role: 'admin' }, organization: { orgId: 3, orgName: 'Acme', orgSlug: 'acme' } }),
    ], { env: { SIREN_TOKEN: TOKEN } });
    expect(await h.run(['whoami']), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        'Using SIREN_TOKEN "CI deploy"',
        '',
        '  Token   ending 9f3c, expires 2027-01-31',
        '  User    dev@acme.example · admin',
        '  Org     Acme (acme)',
        '  Siren   sandbox.sirenaffiliates.com · sandbox',
        '',
        'SIREN_TOKEN wins over the session file while it is set.',
        '',
      ].join('\n'),
    );
    expect(h.printed()).not.toContain(TOKEN);
  });
});

describe('siren orgs', () => {
  it('prints a table with a dim header, and marks the one --org names', async () => {
    const h = harness([reply(200, { memberships: [membershipAcme, membershipTwo] })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ memberships: both }) });
    expect(await h.run(['orgs', '--org', 'acme-two']), h.err()).toBe(0);
    expect(h.out()).toBe(['   ORG       NAME      ROLE', '   acme      Acme      admin', '*  acme-two  Acme Two  admin', ''].join('\n'));
  });

  it('with several and none named: no mark, and a tip that says how a command picks one', async () => {
    const h = harness([reply(200, { memberships: [membershipAcme, membershipTwo] })]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ memberships: both }) });
    expect(await h.run(['orgs']), h.err()).toBe(0);
    expect(h.out()).toBe(
      ['   ORG       NAME      ROLE', '   acme      Acme      admin', '   acme-two  Acme Two  admin', '', 'Each command picks one with --org <slug>, SIREN_ORG, or "org" in siren.app.json.', ''].join('\n'),
    );
  });

  it('in a terminal: a green ● and a bold row for the one in use', async () => {
    const h = harness([reply(200, { memberships: [membershipAcme] })]);
    h.signedIn();
    expect(await runCli(['orgs'], tty(h))).toBe(0);
    expect(h.out()).toContain(`${ESC}2m   ORG   NAME  ROLE${ESC}0m`);
    expect(strip(h.out())).toContain('●  acme  Acme  admin');
    expect(h.out()).toContain(`${ESC}1macme${ESC}0m`);
  });

  it('with --json: the memberships as Siren sent them', async () => {
    const h = harness([reply(200, { memberships: [membershipAcme, membershipTwo] })]);
    h.signedIn();
    expect(await h.run(['orgs', '--json']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual([
      { orgId: 3, orgName: 'Acme', orgSlug: 'acme', role: 'admin' },
      { orgId: 4, orgName: 'Acme Two', orgSlug: 'acme-two', role: 'admin' },
    ]);
  });
});

describe('siren logout', () => {
  it('says it logged out of the Siren by host, and refuses when there was no session there', async () => {
    const h = harness([reply(200, { message: 'Logged out successfully.' })]);
    h.signedIn();
    expect(await h.run(['logout']), h.err()).toBe(0);
    expect(h.out()).toBe('Logged out of sandbox.sirenaffiliates.com.\n');
    expect(await h.run(['logout'])).toBe(1);
    expect(h.err()).toContain("You weren't logged in to sandbox.sirenaffiliates.com, so there was nothing to log out of.");
  });
});
