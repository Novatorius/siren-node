import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAppFile } from '../src/cli/app-file';
import { COMMANDS } from '../src/cli/run';
import { resolveTarget } from '../src/cli/targets';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { AuthAnswers, EMAIL, PASSWORD, harness, session } from './cli-fakes';
import { APP_KEY, appMissing, appRecord } from './apps-siren-answers';

/*
 * The CLI review's pass 1, first run and sign-in
 * (review/cli-dx/pass-1-review.md in the run folder). Contract:
 * docs/architecture/apps-cli.md, "First run" and "The commands".
 */

const UAT = 'https://uat.example.com/siren/v1';
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const app = appRecord({ apiKeyPrefix: RAW_KEY.slice(0, 16) });

async function signInLive(h: ReturnType<typeof harness>) {
  expect(await h.run(['login', '--base-url', UAT, '--live', '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
}

describe('cli pass 1, finding 2: the tool remembers the Siren you signed in to', () => {
  it('uses the Siren login named, for the next command that names none', async () => {
    const h = harness([AuthAnswers.oneOrg(), AuthAnswers.memberships()], { edition: 'production', stdin: PASSWORD });
    await signInLive(h);
    expect(h.credentials()).toMatchObject({ current: UAT });
    expect(await h.run(['orgs']), h.err()).toBe(0);
    expect(h.http.requests.at(-1)?.url.startsWith(UAT)).toBe(true);
    expect(h.out()).toMatch(/acme\s+Acme\s+admin/);
  });

  it('lets a flag or SIREN_BASE_URL win over the remembered Siren', async () => {
    const h = harness([AuthAnswers.oneOrg()], { edition: 'production', stdin: PASSWORD });
    await signInLive(h);
    expect(await h.run(['orgs', '--sandbox'])).toBe(1);
    // Alex after the demo: "Not logged in." in plain words, the API address only where it helps.
    expect(h.err()).toContain('siren: Not logged in.');
    expect(h.err()).toContain(`You are logged in to Acme on ${UAT}.`);
    expect(h.err()).toContain(`--base-url ${UAT}`);

    const other = harness([], { env: { SIREN_BASE_URL: 'https://other.example.com/siren/v1' } });
    other.signedIn({ [UAT]: session({ baseUrl: UAT, edition: 'production' }) });
    expect(await other.run(['whoami'])).toBe(1);
    expect(other.err()).toContain('siren: Not logged in.');
    expect(other.err()).toContain('\nSiren: other.example.com\n');
  });

  it('reads a live organization without --live, and still asks for --live before a write', async () => {
    const h = harness([AuthAnswers.oneOrg(), reply(200, [app])], { edition: 'production', stdin: PASSWORD });
    await signInLive(h);
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.out()).toContain(APP_KEY);

    expect(await h.run(['apps', 'off', APP_KEY])).toBe(1);
    expect(h.err()).toContain(`${UAT} is a live Siren. Add --live to change a live organization.`);
  });

  it('forgets the remembered Siren when you sign out of it', async () => {
    const h = harness([AuthAnswers.oneOrg(), AuthAnswers.loggedOut()], { edition: 'production', stdin: PASSWORD });
    await signInLive(h);
    expect(await h.run(['logout']), h.err()).toBe(0);
    expect(h.out()).toContain(`Signed out of ${UAT}.`);
    expect(h.credentials().current).toBeUndefined();
  });

  it('siren whoami prints who, which organization and which Siren, and where the session is kept, and sends nothing', async () => {
    const h = harness([]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ baseUrl: SANDBOX_BASE_URL, orgSlug: 'acme' }) });
    expect(await h.run(['whoami']), h.err()).toBe(0);
    expect(h.out()).toContain(`Logged in as ${EMAIL} to Acme (acme), as admin.`);
    expect(h.out()).toContain(`Siren: ${SANDBOX_BASE_URL}, a sandbox.`);
    expect(h.out()).toContain(`Session file: ${h.credentialsPath}`);
    expect(h.sent()).toEqual([]);

    expect(await h.run(['whoami', '--json']), h.err()).toBe(0);
    const json = JSON.parse(h.out().slice(h.out().indexOf('{'))) as Record<string, unknown>;
    expect(json).toMatchObject({ email: EMAIL, org: { name: 'Acme', slug: 'acme', id: 3 }, role: 'admin', baseUrl: SANDBOX_BASE_URL, edition: 'sandbox' });
    expect(JSON.stringify(json)).not.toContain('Token');
  });

  it('siren whoami exits 1 when signed out', async () => {
    const h = harness([]);
    expect(await h.run(['whoami'])).toBe(1);
    expect(h.err()).toBe('siren: Not logged in. Run siren login to log in.\n');
  });
});

describe('cli pass 1, finding 3: bare siren, the apps group, help and typos', () => {
  it('siren alone shows where you stand and the three commands that come next, and exits 0', async () => {
    const out = harness([]);
    expect(await out.run([])).toBe(0);
    // Alex after the demo: "Not logged in. Run siren login to log in.", with no API address on the default Siren.
    expect(out.out()).toContain('Not logged in. Run siren login to log in.');
    expect(out.out()).not.toContain(SANDBOX_BASE_URL);
    for (const next of ['siren login', 'siren apps init', 'siren apps apply', 'siren --help']) expect(out.out()).toContain(next);
    expect(out.sent()).toEqual([]);

    const elsewhere = harness([], { env: { SIREN_BASE_URL: 'https://uat.example/siren/v1' } });
    expect(await elsewhere.run([])).toBe(0);
    expect(elsewhere.out()).toContain('Not logged in. Run siren login to log in.\n  Siren: uat.example\n');

    const signed = harness([]);
    signed.signedIn({ [SANDBOX_BASE_URL]: session({ baseUrl: SANDBOX_BASE_URL, orgSlug: 'acme' }) });
    expect(await signed.run([])).toBe(0);
    expect(signed.out()).toContain(`Logged in as ${EMAIL}.`);
    expect(signed.out()).toContain('Siren: sandbox.sirenaffiliates.com, a sandbox.');
    expect(signed.out()).toContain('siren apps requests --follow');
  });

  it('siren apps and siren apps --help list the apps commands', async () => {
    for (const argv of [['apps'], ['apps', '--help'], ['help', 'apps']]) {
      const h = harness([]);
      expect(await h.run(argv), argv.join(' ')).toBe(0);
      expect(h.out()).toContain('  apps apply ');
      expect(h.out()).toContain('  apps requests ');
      expect(h.out()).not.toContain('  login ');
    }
  });

  it('takes siren help, siren help <command>, siren version and -v', async () => {
    const help = harness([]);
    expect(await help.run(['help'])).toBe(0);
    expect(help.out()).toContain('USAGE\n  siren <command> [flags]');
    const one = harness([]);
    expect(await one.run(['help', 'apps', 'apply'])).toBe(0);
    expect(one.out()).toContain('USAGE\n  siren apps apply [file] [flags]');
    for (const argv of [['-v'], ['version']]) {
      const h = harness([]);
      expect(await h.run(argv)).toBe(0);
      expect(h.out()).toMatch(/^\d+\.\d+\.\d+\n$/);
    }
  });

  it('suggests the nearest command for a typo', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'aply'])).toBe(2);
    expect(h.err()).toContain('There is no command "apps aply". Did you mean "apps apply"?');
    const two = harness([]);
    expect(await two.run(['lgin'])).toBe(2);
    expect(two.err()).toContain('Did you mean "login"?');
  });

  it("names an unknown option in the tool's own words, with the nearest one", async () => {
    const h = harness([]);
    expect(await h.run(['login', '--emial', 'x'])).toBe(2);
    expect(h.err()).toContain('There is no option --emial for siren login. Did you mean --email?');
    expect(h.err()).not.toContain('positional argument');
    const value = harness([]);
    expect(await value.run(['login', '--email'])).toBe(2);
    expect(value.err()).toContain('--email needs a value.');
  });
});

describe('cli pass 1, finding 7: each command explains its options and shows an example', () => {
  it('lists every option of every command with a line about it, the shared flags, and an example', async () => {
    for (const command of COMMANDS) {
      const h = harness([]);
      expect(await h.run([...command.split(' '), '--help']), command).toBe(0);
      const text = h.out();
      expect(text, command).toContain(`USAGE\n  siren ${command}`);
      expect(text, command).toContain('EXAMPLES\n  $ siren ');
      for (const flag of ['--sandbox', '--live', '--base-url', '--quiet']) expect(text, `${command} ${flag}`).toContain(flag);
    }
    const login = harness([]);
    await login.run(['login', '--help']);
    expect(login.out()).toMatch(/--password\s+\S/);
    expect(login.out()).toMatch(/--password-stdin\s+\S/);
  });
});

describe('cli pass 1, finding 8: apps rotate is gone', () => {
  it('is not a command, and the help does not list it', async () => {
    expect(COMMANDS).not.toContain('apps rotate');
    const h = harness([]);
    expect(await h.run(['apps', 'rotate', APP_KEY])).toBe(2);
    expect(h.err()).toContain('There is no command "apps rotate".');
    const help = harness([]);
    await help.run(['--help']);
    expect(help.out()).not.toMatch(/apps rotate[ \n]/);
  });
});

describe('cli pass 1, finding 9: --base-url takes a bare host', () => {
  it('adds https and /siren/v1 to a bare host, and /siren/v1 to an address with no path', () => {
    expect(resolveTarget({ baseUrl: 'siren.example.com' }, {}).baseUrl).toBe('https://siren.example.com/siren/v1');
    expect(resolveTarget({ baseUrl: 'https://siren.example.com' }, {}).baseUrl).toBe('https://siren.example.com/siren/v1');
    expect(resolveTarget({ baseUrl: 'http://localhost:8080/' }, {}).baseUrl).toBe('http://localhost:8080/siren/v1');
    expect(resolveTarget({}, { SIREN_BASE_URL: 'siren.example.com' }).baseUrl).toBe('https://siren.example.com/siren/v1');
    expect(resolveTarget({ baseUrl: 'https://siren.example.com/custom/' }, {}).baseUrl).toBe('https://siren.example.com/custom');
  });
});

describe('cli pass 1, finding 5: apps init writes a first app a newcomer can apply', () => {
  it('writes one Post-conversion action, one name, a $schema, and says where SIREN_APP_URL goes', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'init', '--key', APP_KEY, '--name', 'Acme']), h.err()).toBe(0);
    const file = JSON.parse(h.file('siren.app.json')) as Record<string, any>;
    expect(file.$schema).toMatch(/^https:\/\/unpkg\.com\/@novatorius\/siren@[\d.]+\/siren\.app\.schema\.json$/);
    expect(file.name).toBeUndefined();
    expect(file.description).toBeUndefined();
    const features = Object.values(file.apps[APP_KEY].features) as Array<{ kind: string }>;
    expect(features.map((feature) => feature.kind)).toEqual(['postConversionAction']);
    expect(parseAppFile(h.file('siren.app.json'), { SIREN_APP_URL: 'https://acme.example/siren' }).problems).toEqual([]);
    expect(h.out()).toContain('.env');
    expect(h.out()).toContain('Your editor completes them.');
    expect(h.out()).toMatch(/tunnel/);
  });

  it('keeps the two env files out of git by name, so .env.example can still be committed', async () => {
    const h = harness([]);
    await h.run(['apps', 'init', '--key', APP_KEY]);
    const lines = h.file('.gitignore').split('\n');
    expect(lines).toEqual(expect.arrayContaining(['.env.sandbox', '.env.live', '.env.*.tmp']));
    expect(lines).not.toContain('.env.*');
  });

  it('fills SIREN_APP_URL from .env beside the file when the shell does not set it, and says so', async () => {
    const h = harness([appMissing(), reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })]);
    h.signedIn();
    await h.run(['apps', 'init', '--key', APP_KEY]);
    h.write('.env', '# mine\nexport SIREN_APP_URL="https://acme.example/siren"\nOTHER=1\n');
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(JSON.parse(String(h.http.requests[1]?.body))).toMatchObject({ url: 'https://acme.example/siren' });
    expect(h.out()).toMatch(/\n  URL from +SIREN_APP_URL in \.env\n/);
  });

  it('names the place once in a problem line', async () => {
    const h = harness([]);
    h.signedIn();
    await h.run(['apps', 'init', '--key', APP_KEY]);
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.err()).toMatch(/siren\.app\.json:\d+:\d+: apps\.acme-payouts\.url needs the environment variable SIREN_APP_URL/);
    expect(h.err()).not.toContain('url: apps.');
    expect(h.err()).toContain('.env');
  });
});

describe('cli pass 1, finding 6: the first apply says what comes next', () => {
  it('asks to make the app on the named organization, shows the address host, and ends with next steps', async () => {
    const h = harness([appMissing(), reply(201, { ...app, rawKey: RAW_KEY, signingSecret: SIGNING_SECRET })], {
      env: { SIREN_APP_URL: 'https://acme.example/siren?token=abc' },
      interactive: true,
      typed: ['yes'],
    });
    h.signedIn();
    await h.run(['apps', 'init', '--key', APP_KEY]);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.prompts.at(-1)).toBe(`Make ${APP_KEY} in Acme (3), sandbox? [y/N] `);
    expect(h.prompts.at(-1)).not.toContain('last write wins');
    expect(h.out()).toContain('https://acme.example');
    expect(h.printed()).not.toContain('token=abc');
    expect(h.out()).toContain('node --env-file=.env.sandbox');
    expect(h.out()).toContain('siren apps requests --follow');
    expect(h.out()).toMatch(/\n  notify-crm +app:\d+ · /);
    expect(h.out()).not.toContain('autofulfiller');
  });
});

describe('cli pass 1, finding 1: the README never says npx siren', () => {
  it('names the scoped package for npx', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).not.toMatch(/npx siren\b/);
    expect(readme).toContain('npx @novatorius/siren');
  });
});

describe("cli pass 1 re-check: the reviewer's small points", () => {
  it('suggests each command a cut-off name starts, as for apps rotate', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'rotate', APP_KEY])).toBe(2);
    expect(h.err()).toContain('There is no command "apps rotate". Did you mean "apps rotate-key" or "apps rotate-secret"?');
  });

  it('prints the follow hint after a live first apply with no --live, since reads need none', async () => {
    const h = harness([appMissing(), reply(201, { ...app, rawKey: `sk_live_${'0a'.repeat(32)}`, signingSecret: SIGNING_SECRET })], {
      edition: 'production',
      env: { SIREN_APP_URL: 'https://acme.example/siren' },
    });
    h.signedIn({ [UAT]: session({ baseUrl: UAT, edition: 'production' }) });
    await h.run(['apps', 'init', '--key', APP_KEY]);
    expect(await h.run(['apps', 'apply', '--yes', '--live', '--base-url', UAT]), h.err()).toBe(0);
    expect(h.out()).toContain(`\n  2  siren apps requests --follow --base-url ${UAT}\n`);
  });

  it('points $schema at the versioned schema on unpkg, which resolves with or without a local install, and the package ships that file', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { name: string; version: string };
    const h = harness([]);
    await h.run(['apps', 'init', '--key', APP_KEY]);
    const schema = (JSON.parse(h.file('siren.app.json')) as { $schema: string }).$schema;
    expect(schema).toBe(`https://unpkg.com/${pkg.name}@${pkg.version}/siren.app.schema.json`);
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: join(__dirname, '..'), encoding: 'utf8' })) as Array<{
      files: Array<{ path: string }>;
    }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain(schema.split(`${pkg.version}/`)[1]);
  }, 60_000);

  it('says sign in to, not change, when login meets a live Siren without --live', async () => {
    const h = harness([], { edition: 'production', stdin: PASSWORD });
    expect(await h.run(['login', '--base-url', UAT, '--email', EMAIL, '--password-stdin'])).toBe(1);
    expect(h.err()).toContain(`${UAT} is a live Siren. Add --live to log in to a live organization.`);
    const help = harness([]);
    await help.run(['login', '--help']);
    expect(help.out()).not.toMatch(/--live\s+Change a live organization/);
  });

  it('calls it the logo animation in help and the README, never the hook', async () => {
    const help = harness([]);
    await help.run(['--help']);
    const login = harness([]);
    await login.run(['login', '--help']);
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    for (const text of [help.out(), login.out(), readme]) expect(text).not.toMatch(/Siren hook|Siren's hook|the hook/i);
    expect(help.out()).toContain('logo animation');
  });
});
