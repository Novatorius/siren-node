import { describe, expect, it } from 'vitest';
import { CLI_CLIENT, namedClient } from '../src/cli/io';
import { CLI_VERSION, COMMANDS } from '../src/cli/run';
import { entryLines, sinceOf } from '../src/cli/commands/logs';
import type { LogEntry } from '../src/cli/commands/logs';
import { Style } from '../src/cli/style';
import { reply } from './http-fakes';
import { ACCESS_2, AuthAnswers, NOW_MS, REFRESH_2, harness, membershipAcme, membershipTwo, session } from './cli-fakes';
import { SANDBOX_BASE_URL } from '../src/http';
import { APP_REQUEST_ID, appRecord, requestRow } from './apps-siren-answers';

/*
 * `siren logs tail` over `GET /logs`
 * (contract/devtools-logs.md, section 6).
 */

const CURSOR_1 = 'eyJoIjp7ImEiOjF9fQ';
const CURSOR_2 = 'eyJoIjp7ImEiOjJ9fQ';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 'api_9',
    type: 'api',
    at: '2026-11-24T19:02:11.000Z',
    status: 'ok',
    summary: 'GET /apps',
    durationMs: 38,
    httpStatus: 200,
    reason: null,
    app: null,
    source: 'cli',
    credential: 'session',
    requestId: 'req_0123456789abcdef01234567',
    ...overrides,
  };
}

function page(entries: LogEntry[], nextCursor: string, nextPollMs = 1000) {
  return reply(200, { entries, nextCursor, nextPollMs });
}

/** The query of the `index`th request the command sent. */
function queryOf(h: ReturnType<typeof harness>, index: number): Record<string, string> {
  return Object.fromEntries(new URL(h.http.requests[index]!.url).searchParams);
}

/** A harness whose sleeps are recorded, in milliseconds. */
function timed(replies: Parameters<typeof harness>[0], stopAt: number) {
  const h = harness(replies, { onSleep: (count, abort) => count === stopAt && abort() });
  const waits: number[] = [];
  const inner = h.io.sleep;
  (h.io as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
    waits.push(ms);
    return inner(ms);
  };
  h.signedIn();
  return { h, waits };
}

const plain = new Style({ tty: false, env: {} });
const rich = new Style({ tty: true, env: {} });
const command = (words: string) => `siren ${words}`;

describe('siren logs tail', () => {
  it('is a command in the Logs group', async () => {
    expect(COMMANDS).toContain('logs tail');
    const h = harness([]);
    expect(await h.run(['logs', 'tail', '--help'])).toBe(0);
    expect(h.out()).toContain('--since <time>');
    for (const line of h.out().split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  });

  it('starts at now, prints each entry once, waits as long as Siren says, and exits 130 on Ctrl-C', async () => {
    const { h, waits } = timed([page([], CURSOR_1, 1000), page([entry()], CURSOR_2, 750), page([], CURSOR_2, 1000)], 3);

    expect(await h.run(['logs', 'tail']), h.err()).toBe(130);

    expect(h.paths()).toEqual(['GET /logs', 'GET /logs', 'GET /logs']);
    expect(queryOf(h, 0)).toEqual({});
    expect(queryOf(h, 1)).toEqual({ cursor: CURSOR_1 });
    expect(queryOf(h, 2)).toEqual({ cursor: CURSOR_2 });
    expect(waits).toEqual([1000, 750, 1000]);
    expect(h.out().match(/GET \/apps/g)).toHaveLength(1);
    expect(h.out()).toContain('Tailing Acme, all apps');
    // The session goes with every read, and the edition is read again before each read after the first.
    expect(h.http.requests[0]!.headers.Authorization).toMatch(/^Bearer /);
    expect(h.editionReads.length).toBeGreaterThanOrEqual(3);
  });

  it('reads again at once when Siren says more are waiting', async () => {
    const { h, waits } = timed([page([entry()], CURSOR_1, 0), page([entry({ id: 'api_10' })], CURSOR_2, 1000)], 1);

    expect(await h.run(['logs', 'tail', '--json'])).toBe(130);
    expect(waits).toEqual([1000]);
    expect(h.paths()).toHaveLength(2);
  });

  it('sends each filter, and --since only on the first read', async () => {
    const { h } = timed([page([], CURSOR_1), page([], CURSOR_2)], 2);
    const argv = ['logs', 'tail', '--app', 'acme-payouts', '--feature', 'payout-method', '--status', 'failed,refused', '--type', 'request,delivery'];

    expect(await h.run([...argv, '--source', 'api-key,cli', '--method', 'post', '--path', 'apps', '--since', '10m', '--expand']), h.err()).toBe(130);

    expect(queryOf(h, 0)).toEqual({
      app: 'acme-payouts',
      feature: 'payout-method',
      status: 'failed,refused',
      type: 'request,delivery',
      source: 'api_key,cli',
      method: 'POST',
      path: '/apps',
      since: new Date(NOW_MS - 600_000).toISOString(),
      expand: '1',
    });
    expect(queryOf(h, 1).since).toBeUndefined();
    expect(queryOf(h, 1).cursor).toBe(CURSOR_1);
    expect(h.out()).toContain('app acme-payouts, feature payout-method, failed or refused only');
  });

  it('with --json prints one JSON object a line and nothing else, and --limit stops with 0', async () => {
    const { h } = timed([page([entry(), entry({ id: 'api_10' })], CURSOR_1, 0), page([entry({ id: 'api_11' }), entry({ id: 'api_12' })], CURSOR_2)], 99);

    expect(await h.run(['logs', 'tail', '--json', '--limit', '3'])).toBe(0);

    const lines = h.out().trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as LogEntry).id)).toEqual(['api_9', 'api_10', 'api_11']);
  });

  it('tails the organization the resolver settles, switching for --org and naming it in the headline and the hints', async () => {
    const failed = entry({ id: 'delivery_4_1', type: 'delivery', status: 'failed', summary: 'ask payout-method', reason: 'The address answered 500.', request: APP_REQUEST_ID });
    const h = harness([AuthAnswers.tokens(ACCESS_2, REFRESH_2), page([failed], CURSOR_1)], { onSleep: (count, abort) => count === 1 && abort() });
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme', memberships: [membershipAcme, membershipTwo] }) });

    expect(await h.run(['logs', 'tail', '--org', 'acme-two']), h.err()).toBe(130);

    expect(h.paths()).toEqual(['POST /auth/switch-org', 'GET /logs']);
    expect(h.http.requests[1]!.headers.Authorization).toBe(`Bearer ${ACCESS_2}`);
    expect(h.out()).toContain('Tailing Acme Two, all apps');
    expect(h.out()).toContain(`siren apps requests ${APP_REQUEST_ID} --org acme-two`);
  });

  it('refuses to guess among several organizations with no terminal to ask in, and sends nothing', async () => {
    const h = harness([page([], CURSOR_1)]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'acme', memberships: [membershipAcme, membershipTwo] }) });

    expect(await h.run(['logs', 'tail'])).toBe(1);
    expect(h.err()).toContain('Pick one with --org <slug>');
    expect(h.paths()).toEqual([]);
  });

  it('refuses a bad flag with 2 before sending anything', async () => {
    for (const bad of [
      ['--status', 'broken'],
      ['--type', 'requests'],
      ['--source', 'robot'],
      ['--method', 'TRACE'],
      ['--since', 'yesterday'],
      ['--since', '8d'],
      ['--limit', '0'],
      ['--app', 'Acme Payouts'],
    ]) {
      const h = harness([]);
      h.signedIn();
      expect(await h.run(['logs', 'tail', ...bad]), bad.join(' ')).toBe(2);
      expect(h.http.requests, bad.join(' ')).toHaveLength(0);
    }
  });

  it('says when the app is not in the organization, with the command that lists them', async () => {
    const h = harness([reply(404, { error: { message: 'This organization has no app acme-ledger.', code: 'app_not_found' } })]);
    h.signedIn();

    expect(await h.run(['logs', 'tail', '--app', 'acme-ledger'])).toBe(1);
    expect(h.err()).toContain('This organization has no app acme-ledger.');
    expect(h.err()).toContain('siren apps list');
  });

  it('keeps trying while Siren is out of reach, with waits that grow to 5 seconds', async () => {
    const down = reply(503, { error: { message: 'Down for a moment.' } });
    const { h, waits } = timed([down, down, down, down, down, page([entry()], CURSOR_1, 1000)], 6);

    expect(await h.run(['logs', 'tail'])).toBe(130);
    expect(waits).toEqual([500, 1000, 2000, 4000, 5000, 1000]);
    expect(h.out()).toContain('GET /apps');
  });

  it('stops with a refusal when a target changed edition between reads', async () => {
    const h = harness([page([], CURSOR_1), page([], CURSOR_2)], { edition: (read) => (read >= 2 ? 'production' : 'sandbox') });
    h.signedIn();

    expect(await h.run(['logs', 'tail'])).toBe(1);
    expect(h.paths()).toEqual(['GET /logs']);
  });
});

describe('a log line', () => {
  it('is time, type, summary, status and duration, aligned, within 80 columns', () => {
    const [line] = entryLines(plain, entry({ summary: `POST /apps/${'a'.repeat(80)}` }), command);
    const at = new Date('2026-11-24T19:02:11.000Z');
    const clock = [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');

    expect(line!.startsWith(`${clock}  api       POST /apps/`)).toBe(true);
    expect(line).toMatch(/…  ok         38ms$/);
    expect([...line!].length).toBe(80);
  });

  it('shows a failure in red with ✗, its reason under it, and the command to look closer', () => {
    const failed = entry({
      id: 'delivery_4_1',
      type: 'delivery',
      status: 'failed',
      summary: 'ask payout-method to acme.example',
      durationMs: null,
      httpStatus: 500,
      reason: 'The address answered 500. Siren tries again at 19:04:11 UTC.',
      app: 'acme-ledger',
      request: APP_REQUEST_ID,
    });

    const lines = entryLines(rich, failed, command);

    // The style module's failure: one red bold run, ✗ and the word together.
    expect(lines[0]).toContain('\u001b[31m\u001b[1m✗ failed\u001b[0m');
    expect(lines[1]).toContain('The address answered 500.');
    expect(lines[2]!.replace(/\u001b\[[\d;]*m/g, '')).toContain(`› siren apps requests ${APP_REQUEST_ID}`);
    const flat = entryLines(plain, failed, command);
    expect(flat.join('\n')).not.toContain('\u001b[');
    expect(flat[0]).toContain('failed');
  });

  it('cleans every value from Siren, so no escape sequence or control character reaches the screen', () => {
    const sly = entry({
      type: 'deli\u001b[2Jvery',
      status: 'fail\u0007ed',
      summary: 'ask \u001b]8;;https://evil.example\u0007payout-method',
      app: 'acme\u009b2J-ledger',
      reason: 'The address\u001b[1A answered 500.\r\nAgain.',
      request: `${APP_REQUEST_ID}\u001b[31m`,
    });
    const failed = { ...sly, status: 'failed' };
    for (const style of [rich, plain]) {
      for (const one of [sly, failed, { ...failed, request: undefined, requestId: 'req_\u001b[2J1' }]) {
        const text = entryLines(style, one, command).join('\n').replace(/\u001b\[[\d;]*m/g, '');
        expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
        for (const line of text.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
      }
    }
    const shown = entryLines(plain, failed, command).join('\n');
    expect(shown).toContain('ask payout-method  acme-ledger');
    expect(shown).toContain('The address answered 500. Again.');
    expect(shown).toContain(`siren apps requests ${APP_REQUEST_ID}`);
  });

  it('shows a request with its app and status, and --expand shows the body', () => {
    const lines = entryLines(
      plain,
      entry({ type: 'request', summary: 'ask payout-method', app: 'acme-ledger', requestStatus: 'sent', request: requestRow(), durationMs: null, body: { data: { payoutId: 88 } } }),
      command,
    );

    expect(lines[0]).toContain('ask payout-method  acme-ledger  sent');
    expect(lines.join('\n')).toContain('"payoutId": 88');
  });

  it('reads --since as a time back from now, or as a time', () => {
    expect(sinceOf('2h', NOW_MS)).toBe(new Date(NOW_MS - 7_200_000).toISOString());
    expect(sinceOf(new Date(NOW_MS - 1000).toISOString(), NOW_MS)).toBe(new Date(NOW_MS - 1000).toISOString());
  });
});

describe('the tool as Siren sees it', () => {
  it('names itself in X-Siren-Client on every request, keeping the headers it was given', async () => {
    const seen: Array<Record<string, string>> = [];
    const client = namedClient({ send: async (request) => (seen.push({ ...request.headers }), reply(200, {})) });

    await client.send({ method: 'GET', url: 'https://siren.example/siren/v1/apps', headers: { Authorization: 'Bearer t', Accept: 'application/json' }, timeout: 1000 });

    expect(seen[0]).toEqual({ Authorization: 'Bearer t', Accept: 'application/json', 'X-Siren-Client': `siren-cli/${CLI_VERSION}` });
    expect(CLI_CLIENT).toBe(`siren-cli/${CLI_VERSION}`);
  });
});
