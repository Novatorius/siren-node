import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClientError, SANDBOX_BASE_URL } from '../src/http';
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
  ['apps', 'list'],
  ['apps', 'show', APP_KEY],
  ['apps', 'requests'],
  ['apps', 'requests', APP_REQUEST_ID],
  ['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}'],
  ['apps', 'resend', APP_REQUEST_ID],
  ['apps', 'rotate-key', APP_KEY, '--yes'],
  ['apps', 'rotate-secret', APP_KEY, '--yes'],
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

  // The follow runs here pass --attention, which reads one list, then follows GET /logs.
  it('reads the edition once per command, before anything else, and again before each poll while following', async () => {
    const apply = harness([reply(200, [app])]);
    apply.signedIn();
    expect(await apply.run(['apps', 'list']), apply.err()).toBe(0);
    expect(apply.sent()).toEqual(['GET /auth/signup-options', 'GET /apps']);

    const follow = harness([reply(200, [app]), reply(200, { requests: [requestRow()] })], { onSleep: (count, abort) => count === 3 && abort() });
    follow.signedIn();
    expect(await follow.run(['apps', 'requests', '--attention', '--follow']), follow.err()).toBe(130);
    const polls = follow.paths().filter((path) => path === 'GET /apps/requests').length;
    expect(polls).toBeGreaterThan(1);
    expect(follow.editionReads).toHaveLength(polls);
    expect(follow.sent()[0]).toBe('GET /auth/signup-options');
    expect(follow.sent().filter((path) => path !== 'GET /auth/signup-options')).toEqual(follow.paths());
    // The apps are read once, with the first poll. After that each edition read comes just before its poll.
    const polled = follow.sent().filter((path) => path !== 'GET /apps');
    for (let at = 0; at < polled.length; at += 2) expect(polled[at], `request ${at}`).toBe('GET /auth/signup-options');

    const login = harness([AuthAnswers.oneOrg(), reply(200, [app])], { stdin: PASSWORD });
    expect(await login.run(['login', '--email', EMAIL, '--password-stdin']), login.err()).toBe(0);
    expect(login.sent()).toEqual(['GET /auth/signup-options', 'POST /auth/login']);
  });

  it('stops a follow run within one poll when the target turns live, with the line every other command gives', async () => {
    const h = harness([reply(200, [app]), reply(200, { requests: [requestRow()] }), reply(200, { requests: [requestRow()] }), reply(200, { requests: [requestRow()] })], {
      edition: (read) => (read <= 2 ? 'sandbox' : 'production'),
      onSleep: (count, abort) => count === 5 && abort(),
    });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--attention', '--follow'])).toBe(1);
    expect(h.paths()).toEqual(['GET /apps', 'GET /apps/requests', 'GET /apps/requests']);
    expect(h.editionReads).toHaveLength(3);
    expect(h.err()).toMatch(/^Watching Acme \(3\), sandbox for requests\. Ctrl-C stops\.\n/);
    const followed = h.err().replace(/^Watching .*\n/, '');

    const other = harness([reply(200, [app])], { edition: 'production' });
    other.signedIn();
    expect(await other.run(['apps', 'list'])).toBe(1);
    expect(followed).toBe(other.err());
    expect(followed).toBe(
      `siren: ${SANDBOX_BASE_URL} is now a live Siren, and your session was made when it was a sandbox one, so nothing was sent with it. ` +
        'Run siren login --live to sign in again.\n',
    );
  });

  it('stops a follow run within one poll when a live target turns into a sandbox', async () => {
    const h = harness([reply(200, []), reply(200, { requests: [] }), reply(200, { requests: [] })], {
      edition: (read) => (read === 1 ? 'production' : 'sandbox'),
      onSleep: (count, abort) => count === 5 && abort(),
    });
    h.signedIn({ [BASE]: session({ edition: 'production', baseUrl: BASE }) });
    expect(await h.run(['apps', 'requests', '--attention', '--follow', '--live', '--base-url', BASE])).toBe(1);
    expect(h.paths()).toEqual(['GET /apps', 'GET /apps/requests']);
    expect(h.err()).toContain('is now a sandbox Siren, and your session was made when it was a live one');
  });

  it('gives the edition read a short timeout of its own, so a target that hangs is given up well under ten seconds', async () => {
    const h = harness([reply(200, [app])], { edition: new HttpClientError('The operation was aborted due to timeout') });
    h.signedIn();
    expect(await h.run(['apps', 'list'])).toBe(1);
    expect(h.paths()).toEqual([]);
    const timeouts = h.editionReads.map((request) => request.timeout);
    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeout of timeouts) expect(timeout).toBeLessThanOrEqual(3000);
    // Every attempt waits its whole timeout, and the pauses between them, half a second then a second, add to it.
    const pauses = [500, 1000].slice(0, timeouts.length - 1).reduce((sum, pause) => sum + pause, 0);
    expect(timeouts.reduce((sum, timeout) => sum + timeout, 0) + pauses).toBeLessThan(7000);
    expect(h.err()).toBe(
      `siren: ${SANDBOX_BASE_URL} did not answer when the tool asked which edition it is, so nothing was sent. ` +
        'Check the address, or try again in a minute.\n',
    );
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

  it('stops a follow run that is already going once the Cloud reports live, sending the session there no more', async () => {
    cloud.edition = 'sandbox';
    const config = configFolder();
    const base = ['--base-url', cloud.baseUrl];
    const login = await runBuilt(cli, ['login', ...base, '--email', 'loopback@example.invalid', '--password-stdin'], config, 'made-up-password\n');
    expect(login.status, login.stderr).toBe(0);

    const before = cloud.seen.length;
    const following = runBuilt(cli, ['apps', 'requests', '--attention', '--follow', ...base], config);
    // The list is read once, then the feed. Flip the edition once the feed has been read.
    const polls = () => cloud.seen.slice(before).filter((request) => request.path === '/logs');
    while (polls().length < 1) await new Promise((resolve) => setTimeout(resolve, 50));
    cloud.edition = 'production';
    const flippedAt = cloud.seen.length;
    const ended = await following;

    expect(ended.status, ended.stderr).toBe(1);
    expect(ended.stderr).toContain('is now a live Siren, and your session was made when it was a sandbox one');
    const after = cloud.seen.slice(flippedAt).map((request) => `${request.method} ${request.path}`);
    expect(after).toEqual(['GET /auth/signup-options']);
    cloud.edition = 'sandbox';
  }, 60_000);

  it('gives up on a target whose edition read hangs well under ten seconds, with a line that says it did not answer', async () => {
    const config = configFolder();
    const login = await runBuilt(cli, ['login', '--base-url', cloud.baseUrl, '--email', 'loopback@example.invalid', '--password-stdin'], config, 'made-up-password\n');
    expect(login.status, login.stderr).toBe(0);
    cloud.hangEdition = true;
    const started = Date.now();
    const ended = await runBuilt(cli, ['apps', 'list', '--base-url', cloud.baseUrl], config);
    const took = Date.now() - started;
    cloud.hangEdition = false;
    expect(ended.status, ended.stderr).toBe(1);
    expect(took).toBeLessThan(9000);
    expect(ended.stderr).toBe(
      `siren: ${cloud.baseUrl} did not answer when the tool asked which edition it is, so nothing was sent. Check the address, or try again in a minute.\n`,
    );
  }, 60_000);
});
