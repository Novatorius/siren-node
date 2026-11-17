import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { BASE } from './record-fakes';
import { AuthAnswers, EMAIL, PASSWORD, harness, session } from './cli-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord, requestRow } from './apps-siren-answers';
import { buildCli, configFolder, runBuilt, startFakeCloud } from './cli-loopback';
import type { FakeCloud } from './cli-loopback';

/*
 * Acceptance tests for the sandbox and live guard on every command that
 * sends anything. Contract: docs/architecture/apps-cli.md, "Sandbox and
 * live".
 *
 * Against a real Cloud, a session stored while the target was a sandbox
 * listed a production Cloud's apps with no --live, and a session stored as
 * live acted on a sandbox with --live. Every command now reads the edition
 * the target reports before it sends anything else, and refuses a session
 * made for another edition or address.
 */

const app = appRecord();

/** Each command that sends something with a stored session, with what it would send first. */
const SESSION_COMMANDS: string[][] = [
  ['orgs'],
  ['use', 'acme-two'],
  ['apps', 'list'],
  ['apps', 'show', APP_KEY],
  ['apps', 'requests'],
  ['apps', 'requests', APP_REQUEST_ID],
  ['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}'],
  ['apps', 'resend', APP_REQUEST_ID],
  ['apps', 'rotate', APP_KEY],
  ['apps', 'on', APP_KEY],
  ['apps', 'off', APP_KEY],
  ['apps', 'delete', APP_KEY, '--yes'],
];

describe('apps-cli: the edition the target reports now, on every command', () => {
  it('refuses a session stored for a sandbox when the target is now live, with --live or without, and sends nothing with it', async () => {
    for (const live of [false, true]) {
      const h = harness([reply(200, [app])], { edition: 'production' });
      h.signedIn({ [BASE]: session({ edition: 'sandbox', baseUrl: BASE }) });
      const argv = ['apps', 'list', '--base-url', BASE, ...(live ? ['--live'] : [])];
      expect(await h.run(argv), argv.join(' ')).toBe(1);
      expect(h.paths()).toEqual([]);
      expect(h.editionReads).toHaveLength(1);
      expect(h.err()).toBe(
        `siren: ${BASE} is now a live Siren, and your session was made when it was a sandbox one, so nothing was sent with it. ` +
          `Run siren login --base-url ${BASE} --live to sign in again.\n`,
      );
    }
  });

  it('refuses a session stored as live when the target is now a sandbox, with --live or without', async () => {
    for (const live of [false, true]) {
      const h = harness([reply(200, [app])], { edition: 'sandbox' });
      h.signedIn({ [BASE]: session({ edition: 'production', baseUrl: BASE }) });
      const argv = ['apps', 'list', '--base-url', BASE, ...(live ? ['--live'] : [])];
      expect(await h.run(argv), argv.join(' ')).toBe(1);
      expect(h.paths()).toEqual([]);
      expect(h.err()).toBe(
        `siren: ${BASE} is now a sandbox Siren, and your session was made when it was a live one, so nothing was sent with it. ` +
          `Run siren login --base-url ${BASE} to sign in again.\n`,
      );
      expect(h.err()).not.toContain('is a live Siren');
    }
  });

  it('a Siren that names no edition counts as live, so a sandbox session is refused there', async () => {
    const h = harness([reply(200, [app])], { edition: 'none' });
    h.signedIn({ [BASE]: session() });
    expect(await h.run(['apps', 'list', '--base-url', BASE, '--live'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('is now a live Siren');
  });

  it('checks every command that sends anything with a session, and none of them sends anything else on a mismatch', async () => {
    for (const command of SESSION_COMMANDS) {
      const h = harness([reply(200, [app])], { edition: 'production' });
      h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: '/nowhere/.env.sandbox' } }) });
      expect(await h.run(command), command.join(' ')).toBe(1);
      expect(h.paths(), command.join(' ')).toEqual([]);
      expect(h.err(), command.join(' ')).toContain('your session was made when it was a sandbox one');
    }
  });

  it('refuses a session whose stored address is not the target, before sending anything with it', async () => {
    const h = harness([reply(200, [app])]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ baseUrl: BASE }) });
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain(`The session stored for ${SANDBOX_BASE_URL} was made for ${BASE}`);
    expect(h.err()).toContain('Run siren login to sign in again.');
  });

  it('reads the edition once per command, before anything else, even while following', async () => {
    const apply = harness([reply(200, [app])]);
    apply.signedIn();
    expect(await apply.run(['apps', 'list']), apply.err()).toBe(0);
    expect(apply.sent()).toEqual(['GET /auth/signup-options', 'GET /apps']);

    const follow = harness([reply(200, { requests: [requestRow()] })], { onSleep: (count, abort) => count === 3 && abort() });
    follow.signedIn();
    expect(await follow.run(['apps', 'requests', '--follow']), follow.err()).toBe(0);
    expect(follow.paths().filter((path) => path === 'GET /apps/requests').length).toBeGreaterThan(1);
    expect(follow.editionReads).toHaveLength(1);
    expect(follow.sent()[0]).toBe('GET /auth/signup-options');

    const login = harness([AuthAnswers.oneOrg(), reply(200, [app])], { stdin: PASSWORD });
    expect(await login.run(['login', '--email', EMAIL, '--password-stdin']), login.err()).toBe(0);
    expect(login.sent()).toEqual(['GET /auth/signup-options', 'POST /auth/login']);
  });

  it('keeps the edition and the address a session was made for', async () => {
    const h = harness([AuthAnswers.oneOrg()], { stdin: PASSWORD, edition: 'production' });
    expect(await h.run(['login', '--live', '--base-url', BASE, '--email', EMAIL, '--password-stdin']), h.err()).toBe(0);
    expect(h.credentials().sessions[BASE]).toMatchObject({ edition: 'production', baseUrl: BASE });
  });

  it('logs out of a session made for another edition by forgetting it here, without sending its tokens', async () => {
    const h = harness([AuthAnswers.loggedOut()], { edition: 'production' });
    h.signedIn({ [SANDBOX_BASE_URL]: session(), [BASE]: session({ orgName: 'Local' }) });
    expect(await h.run(['logout']), h.err()).toBe(0);
    expect(h.paths()).toEqual([]);
    expect(Object.keys(h.credentials().sessions)).toEqual([BASE]);
    expect(h.out()).toContain(`Forgot the session for ${SANDBOX_BASE_URL} on this machine.`);
  });
});

describe('apps-cli: the edition check against a Cloud whose edition changes between two commands', () => {
  let cloud: FakeCloud;
  let cli: string;
  beforeAll(async () => {
    cli = buildCli();
    cloud = await startFakeCloud('sandbox');
  });
  afterAll(async () => {
    await cloud.close();
  });

  it('acts on the sandbox, then refuses the same session once the Cloud reports live, with or without --live', async () => {
    const config = configFolder();
    const base = ['--base-url', cloud.baseUrl];
    const login = await runBuilt(cli, ['login', ...base, '--email', 'loopback@example.invalid', '--password-stdin'], config, 'made-up-password\n');
    expect(login.status, login.stderr).toBe(0);
    const listed = await runBuilt(cli, ['apps', 'list', ...base], config);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('acme-payouts');

    cloud.edition = 'production';
    const before = cloud.seen.length;
    for (const live of [[], ['--live']]) {
      const refused = await runBuilt(cli, ['apps', 'list', ...base, ...live], config);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('is now a live Siren, and your session was made when it was a sandbox one');
    }
    expect(cloud.seen.slice(before).map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /auth/signup-options',
      'GET /auth/signup-options',
    ]);
    expect(cloud.seen.slice(before).every((request) => request.authorization === undefined)).toBe(true);

    cloud.edition = 'sandbox';
    const again = await runBuilt(cli, ['apps', 'list', ...base], config);
    expect(again.status, again.stderr).toBe(0);
  }, 60_000);
});
