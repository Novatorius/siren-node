import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { APP_KEY, APP_REQUEST_ID, appRecord, requestRow } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * `siren apps requests` as catalog mockup 3 has it (review/cli-dx/
 * output-catalog.md in the run folder): a count line, a table with an
 * eight-character id, a short local time, the app, a short feature name,
 * what the request is about, the sends and its state, and a tip with the
 * command for one. --attention trades the state for why it needs you.
 * Every command takes the eight-character id. --json prints the list.
 */

const ESC = '\u001b[';
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const UTC = { TZ: 'UTC' };
const OTHER_ID = 'apr_0123456789abcdef0123456789abcdef';
const older = requestRow({ id: OTHER_ID, feature: 'app:11', kind: 'postConversionAction', mode: 'tell', subject: { type: 'conversion', id: '29' }, status: 'delivered', answerBy: null, createdAt: '2026-11-16T08:00:00+00:00' });
const waiting = requestRow();
const stuck = requestRow({ status: 'needs_attention', sendCount: 3, lastError: 'Host not found' });
const list = (...rows: unknown[]) => reply(200, { requests: rows });
/** What GET /apps/requests?idPrefix= answers from feat/apps 76d5bbdf83: the matches, two at most. */
const found = (...rows: unknown[]) => reply(200, { requests: rows, total: rows.length });
const apps = () => reply(200, [appRecord()]);

describe('siren apps requests: the list', () => {
  it('prints a count line, a table oldest first, and a tip that names the newest by its short id', async () => {
    const h = harness([apps(), list(waiting, older), list(), found(waiting)], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests']), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        '2 requests in Acme (3), sandbox',
        '',
        'ID        WHEN          APP           FEATURE          ABOUT          SENDS  STATE',
        '01234567  Nov 16 08:00  acme-payouts  Post-conversion  conversion 29  1      delivered',
        'b79943ff  Nov 17 09:14  acme-payouts  Payout method    payout 88      1      waiting',
        '',
        'siren apps requests b79943ff shows one.',
        '',
      ].join('\n'),
    );
    // The latest, then every request that needs attention, then one idPrefix lookup that shows the short id finds the newest.
    expect(h.paths()).toEqual(['GET /apps', 'GET /apps/requests', 'GET /apps/requests', 'GET /apps/requests']);
    expect(Object.fromEntries(new URL(h.http.requests[3]!.url).searchParams)).toEqual({ idPrefix: 'apr_b79943ff' });
  });

  it('with --attention: says how many need you, and why each one does, with the commands for the newest', async () => {
    const h = harness([apps(), list(stuck), found(stuck)], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--attention']), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        '1 request needs you in Acme (3), sandbox',
        '',
        'ID        WHEN          APP           FEATURE        ABOUT      SENDS  WHY',
        'b79943ff  Nov 17 09:14  acme-payouts  Payout method  payout 88  3      Host not found',
        '',
        'siren apps requests b79943ff shows it, and siren apps resend b79943ff sends it again.',
        '',
      ].join('\n'),
    );
  });

  it('with --app: only that app, and a short line with the command to watch when it has none', async () => {
    const h = harness([apps(), list(waiting), list(), found(waiting), apps(), list(), list()], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--app', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toContain(`1 request for ${APP_KEY} in Acme (3), sandbox`);
    const before = h.out().length;
    expect(await h.run(['apps', 'requests', '--app', APP_KEY]), h.err()).toBe(0);
    expect(h.out().slice(before)).toBe(['No requests for acme-payouts yet.', 'siren apps requests --app acme-payouts --follow watches for them.', ''].join('\n'));
  });

  it('in a terminal: a bold count, a dim id, colored states, and nothing past 80 columns', async () => {
    const long = requestRow({ id: 'apr_c0ffee0123456789abcdef0123456789', status: 'needs_attention', lastError: 'The handler answered 500 with a long message that runs past the edge' });
    const h = harness([apps(), list(waiting, older, long), list(), found(long)], { env: UTC });
    h.signedIn();
    expect(await runCli(['apps', 'requests'], { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(0);
    const text = h.out();
    expect(text).toContain(`${ESC}1m3 requests${ESC}0m`);
    expect(text).toContain(`${ESC}2mb79943ff${ESC}0m`);
    expect(strip(text)).toContain('● waiting');
    expect(strip(text)).toContain('✓ delivered');
    expect(strip(text)).toContain('● needs attention');
    for (const line of strip(text).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    await expect(text).toMatchFileSnapshot('./__snapshots__/cli-styled-requests.txt');
  });

  it('with --json: the rows Siren sent, oldest first, as one JSON array with full ids', async () => {
    const h = harness([apps(), list(waiting, older), list()], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--json']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual([older, waiting]);
  });

  it('with --follow: says it is watching, prints the header once and each change as a row, and exits 130 on Ctrl-C', async () => {
    const h = harness([apps(), list(waiting), list(), found(waiting), list({ ...waiting, status: 'answered' }), list(), list({ ...waiting, status: 'answered' }), list()], {
      env: UTC,
      onSleep: (count, abort) => (count === 2 ? abort() : undefined),
    });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--follow'])).toBe(130);
    expect(h.err()).toContain('Watching Acme (3), sandbox for requests. Ctrl-C stops.');
    const rows = h.out().split('\n').filter((line) => line.startsWith('b79943ff'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('waiting');
    expect(rows[1]).toContain('answered');
    expect(h.out().split('\n').filter((line) => line.startsWith('ID '))).toHaveLength(1);
  });

  it('with --follow --json: one JSON object a line for each change', async () => {
    const h = harness([apps(), list(waiting), list(), found(waiting), list(), list()], { env: UTC, onSleep: (count, abort) => (count === 1 ? abort() : undefined) });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--follow', '--json'])).toBe(130);
    expect(h.out().trim().split('\n').map((line) => JSON.parse(line))).toEqual([waiting]);
  });
});

describe('short request ids', () => {
  /*
   * CLI pass 3, must-fix 1: the tool finds a short id with one call to
   * GET /apps/requests?idPrefix=, which Siren reads from feat/apps
   * 76d5bbdf83 and answers with at most two matches. Against an older
   * Siren, which refuses the param or ignores it, the tool prints whole
   * ids and asks for one, so it never prints a short id it can't find.
   */
  const queryOf = (h: ReturnType<typeof harness>, at: number) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
  const twin = requestRow({ id: 'apr_b79943ff00000000000000000000beef' });
  const detailOf = (row: unknown) => reply(200, { ...(row as object), data: {}, answer: null, answeredByUser: null });

  it('finds a short id with one idPrefix call, then reads that request', async () => {
    const h = harness([found(waiting), detailOf(waiting), apps(), reply(200, [])], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', 'b79943ff']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps/requests', `GET /apps/requests/${APP_REQUEST_ID}`, 'GET /apps', `GET /apps/${APP_KEY}/deliveries`]);
    expect(queryOf(h, 0)).toEqual({ idPrefix: 'apr_b79943ff' });
    expect(h.out()).toContain('siren apps resend b79943ff sends it again.');
  });

  it('takes a short id with or without apr_, in either case, for resend', async () => {
    for (const typed of ['apr_b79943ff', 'B79943FF']) {
      const h = harness([found(waiting), reply(200, waiting)], { env: UTC });
      h.signedIn();
      expect(await h.run(['apps', 'resend', typed]), h.err()).toBe(0);
      expect(h.paths()).toEqual(['GET /apps/requests', `POST /apps/requests/${APP_REQUEST_ID}/resend`]);
      expect(queryOf(h, 0)).toEqual({ idPrefix: 'apr_b79943ff' });
    }
  });

  it('counts the 4 characters after apr_, so apr_ alone or with 3 characters is no id, and nothing is sent', async () => {
    for (const typed of ['apr_', 'apr_b79', 'b79', '']) {
      const h = harness([found(waiting), reply(200, { status: 'accepted' })]);
      h.signedIn();
      expect(await h.run(['apps', 'answer', typed, '--body', '{"outcome":"paid"}']), typed).toBe(2);
      expect(h.err()).toContain("isn't a request id");
      expect(h.sent()).toEqual([]);
    }
  });

  it('refuses a short id that matches no request', async () => {
    const h = harness([found()]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', 'deadbeef'])).toBe(1);
    expect(h.err()).toContain('Acme has no request that starts with deadbeef.');
    expect(h.err()).toContain('siren apps requests');
    expect(h.paths()).toEqual(['GET /apps/requests']);
  });

  it('refuses a short id two requests start with, lists both, and says there may be more, since Siren answers two at most', async () => {
    const h = harness([found(waiting, twin), reply(200, { status: 'accepted' })]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', 'b79943ff', '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(h.err()).toContain('siren: b79943ff starts more than one request. It starts b79943ff8ca3, b79943ff0000 and maybe more, so nothing was sent. Give more of the id.');
    expect(h.err()).not.toMatch(/\d requests start/);
    expect(h.paths()).toEqual(['GET /apps/requests']);
  });

  it('asks for the whole id when Siren refuses idPrefix, as a Siren before feat/apps 76d5bbdf83 does', async () => {
    const h = harness([reply(400, { error: { message: 'Unknown parameter idPrefix.', context: {} } })]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', 'b79943ff'])).toBe(1);
    expect(h.err()).toContain("siren: sandbox.sirenaffiliates.com can't find a request by the start of its id.");
    expect(h.err()).toContain('Give the whole id, apr_ and 32 characters, which siren apps requests prints.');
    expect(h.paths()).toEqual(['GET /apps/requests']);
  });

  it('asks for the whole id when Siren ignores idPrefix and answers its latest requests', async () => {
    const h = harness([list(waiting, older, stuck)]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', 'b79943ff'])).toBe(1);
    expect(h.err()).toContain("can't find a request by the start of its id.");
    expect(h.paths()).toEqual(['GET /apps/requests']);
  });

  it('prints whole ids in the list and its tip when Siren ignores idPrefix, since a short one could not be found', async () => {
    const h = harness([apps(), list(waiting, older), list(), list(waiting, older)], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps', 'GET /apps/requests', 'GET /apps/requests', 'GET /apps/requests']);
    expect(queryOf(h, 3)).toEqual({ idPrefix: 'apr_b79943ff' });
    expect(h.out()).toContain(`${OTHER_ID}  Nov 16 08:00`);
    expect(h.out()).toContain(`siren apps requests ${APP_REQUEST_ID} shows one.`);
    expect(h.out()).not.toMatch(/^b79943ff /m);
  });

  it('prints whole ids in a request and its tip when Siren refuses idPrefix', async () => {
    const h = harness([detailOf(waiting), apps(), reply(200, []), reply(400, { error: { message: 'Unknown parameter idPrefix.', context: {} } })], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', APP_REQUEST_ID]), h.err()).toBe(0);
    expect(h.out()).toContain(`siren apps resend ${APP_REQUEST_ID} sends it again.`);
  });

  it('refuses what is not a request id before sending anything, and shows what one looks like', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', 'apr_12'])).toBe(2);
    expect(h.err()).toContain('"apr_12" isn\'t a request id.');
    expect(h.err()).toContain('apr_ec16a240198d5bc956c9a55c01103dd4');
    expect(h.sent()).toEqual([]);
  });
});

describe('siren apps requests <id>: one request', () => {
  const sendOf = (n: number, httpStatusCode: number, responseBody: string, status: string) => ({
    id: 70 + n,
    eventId: `${APP_REQUEST_ID}.${n}`,
    eventType: 'app.request',
    status,
    attemptCount: 1,
    httpStatusCode,
    responseBody,
    errorMessage: null,
    nextRetryAt: null,
    deliveredAt: null,
    dateCreated: '2026-11-17 09:14:03',
    dateModified: '2026-11-17 09:14:04',
  });
  const detail = (over: Record<string, unknown> = {}) => reply(200, { ...requestRow({ sendCount: 2, ...over }), data: { payoutId: 88, amount: 2500, currency: 'USD' }, answer: null, answeredByUser: null });

  it('prints a block about it, its sends as a table, the data Siren sent, and the command that sends it again', async () => {
    const h = harness([detail(), apps(), reply(200, [sendOf(2, 200, '{"received":true}', 'delivered'), sendOf(1, 500, 'upstream timeout', 'failed')]), found(waiting)], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', APP_REQUEST_ID]), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        APP_REQUEST_ID,
        '',
        '  State     waiting',
        '  Kind      ask · Payout method (payoutMethod)',
        '  App       acme-payouts · acme-ledger (app:12)',
        '  About     payout 88',
        '  Created   Nov 17 09:14',
        '  Answer    none yet, due Nov 18 09:14',
        '',
        'SENDS',
        '#  STATUS     HTTP  THE APP SAID',
        '1  failed     500   upstream timeout',
        '2  delivered  200   {"received":true}',
        '',
        'DATA',
        '  payoutId  88',
        '  amount    2500',
        '  currency  USD',
        '',
        'siren apps resend b79943ff sends it again.',
        '',
      ].join('\n'),
    );
  });

  it('names the answer and who gave it, and for a request that needs you, the commands to answer or resend it', async () => {
    const reply7 = { ...requestRow(), data: {}, answer: { outcome: 'paid', reference: 'TX-1' }, answeredByUser: { id: 7, email: 'dev@acme.example' }, status: 'answered', answeredBy: 'user:7', answeredAt: '2026-11-17T10:00:00+00:00' };
    const answered = harness([reply(200, reply7), apps(), reply(200, [])], { env: UTC });
    answered.signedIn();
    expect(await answered.run(['apps', 'requests', APP_REQUEST_ID]), answered.err()).toBe(0);
    expect(answered.out()).toContain('  Answer    {"outcome":"paid","reference":"TX-1"}');
    expect(answered.out()).toContain('  From      dev@acme.example at Nov 17 10:00');
    expect(answered.out()).toContain('Siren sent no data.');

    const stuck = harness([detail({ status: 'needs_attention', lastError: 'Host not found' }), apps(), reply(200, []), found(waiting)], { env: UTC });
    stuck.signedIn();
    expect(await stuck.run(['apps', 'requests', APP_REQUEST_ID]), stuck.err()).toBe(0);
    expect(stuck.out()).toContain('  State     needs attention: Host not found');
    expect(stuck.out()).toContain(`siren apps answer b79943ff --body '{"outcome":"…"}' answers it.\nsiren apps resend b79943ff sends it again.\n`);
  });

  it('in a terminal: a dim id, a colored state, dim data keys, and nothing past 80 columns', async () => {
    const stuck = requestRow({ status: 'needs_attention', lastError: 'Host not found' });
    const h = harness([list(stuck), detail({ status: 'needs_attention', lastError: 'Host not found' }), apps(), reply(200, [sendOf(1, 500, 'upstream timeout', 'failed')])], { env: UTC });
    h.signedIn();
    expect(await runCli(['apps', 'requests', 'b79943ff'], { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(0);
    const text = h.out();
    expect(text).toContain(`${ESC}2m${APP_REQUEST_ID}${ESC}0m`);
    expect(text).toContain(`${ESC}33m● needs attention: Host not found${ESC}0m`);
    expect(text).toContain(`${ESC}2mpayoutId${ESC}0m`);
    for (const line of strip(text).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    await expect(text).toMatchFileSnapshot('./__snapshots__/cli-styled-request.txt');
  });
});

describe('siren apps answer and resend: the success output', () => {
  it('answer: a ✓ line with the short id in bold, the answer, and the command that shows the request', async () => {
    const h = harness([reply(200, { status: 'accepted' }), found(waiting), reply(200, { status: 'accepted', duplicate: true }), found(waiting)]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}']), h.err()).toBe(0);
    expect(h.out()).toBe(['Answered b79943ff', '', '  Answer   {"outcome":"paid"}', '', 'siren apps requests b79943ff shows it.', ''].join('\n'));
    const before = h.out().length;
    expect(await h.run(['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}']), h.err()).toBe(0);
    expect(h.out().slice(before)).toBe('Siren already had this answer for b79943ff. Nothing changed.\n');
  });

  it('resend: a ✓ line with the short id in bold, its state and sends, and the command that shows each send', async () => {
    const h = harness([reply(200, requestRow({ sendCount: 2 })), found(waiting)]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', APP_REQUEST_ID]), h.err()).toBe(0);
    expect(h.out()).toBe(['Sent b79943ff again', '', '  State   waiting', '  Sends   2', '', 'siren apps requests b79943ff shows each send.', ''].join('\n'));
  });
});

describe('CLI pass 3, should-fix 8: a tell takes no answer', () => {
  it('offers only resend for a tell that needs attention, since Siren answers 422 to an answer', async () => {
    const tell = { ...requestRow({ mode: 'tell', kind: 'postConversionAction', status: 'needs_attention', lastError: 'Host not found' }), data: {}, answer: null, answeredByUser: null };
    const h = harness([reply(200, tell), apps(), reply(200, []), found(waiting)], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', APP_REQUEST_ID]), h.err()).toBe(0);
    expect(h.out()).not.toContain('apps answer');
    expect(h.out()).toContain('siren apps resend b79943ff sends it again.');
  });
});

describe("CLI pass 3, should-fix 7: in an app's folder, the list is that app's", () => {
  const theirs = requestRow({ id: 'apr_aaaa0000000000000000000000000000', appId: 99, createdAt: '2026-11-17T10:00:00+00:00' });
  const appFile = JSON.stringify({ version: 1, apps: { [APP_KEY]: { name: 'Acme', url: 'https://acme.example/siren' } } });
  const otherApp = () => reply(200, [appRecord(), appRecord({ id: 99, key: 'other-app' })]);

  it('lists only the app siren.app.json names, says so, and names the flag that lists them all', async () => {
    const h = harness([otherApp(), list(waiting, theirs), list(), found(waiting)], { env: UTC });
    h.signedIn();
    h.write('siren.app.json', appFile);
    expect(await h.run(['apps', 'requests']), h.err()).toBe(0);
    expect(h.out()).toContain(`1 request for ${APP_KEY} in Acme (3), sandbox`);
    expect(h.out()).not.toContain('aaaa0000');
    expect(h.out()).toContain("siren apps requests --all lists every app's.");
    // One app's list has no APP column, since every row is that app's.
    expect(h.out()).not.toMatch(/^ID .* APP /m);
  });

  it('lists every app with --all, and refuses --all beside --app', async () => {
    const h = harness([otherApp(), list(waiting, theirs), list(), found(theirs)], { env: UTC });
    h.signedIn();
    h.write('siren.app.json', appFile);
    expect(await h.run(['apps', 'requests', '--all']), h.err()).toBe(0);
    expect(h.out()).toContain('2 requests in Acme (3), sandbox');
    expect(h.out()).toContain('aaaa0000');
    expect(await h.run(['apps', 'requests', '--all', '--app', APP_KEY])).toBe(2);
  });

  it('says when the app in siren.app.json is not in the organization yet, and how to make it', async () => {
    const h = harness([reply(200, [appRecord({ id: 99, key: 'other-app' })]), list(theirs), list()], { env: UTC });
    h.signedIn();
    h.write('siren.app.json', appFile);
    expect(await h.run(['apps', 'requests'])).toBe(1);
    expect(h.err()).toContain(`siren: Acme has no app ${APP_KEY}. siren.app.json names it, and it isn't made yet. Run siren apps apply to make it.`);
  });

  it('names the app while following', async () => {
    const h = harness([otherApp(), list(), list()], { env: UTC, onSleep: (count, abort) => (count === 1 ? abort() : undefined) });
    h.signedIn();
    h.write('siren.app.json', appFile);
    expect(await h.run(['apps', 'requests', '--follow'])).toBe(130);
    expect(h.err()).toContain(`Watching ${APP_KEY} in Acme (3), sandbox for requests. Ctrl-C stops.`);
  });

  it('in a terminal: drops ABOUT before APP, and shows the newest 20 with a count of the rest', async () => {
    const many = Array.from({ length: 25 }, (_, at) =>
      requestRow({
        id: `apr_${String(at).padStart(2, '0')}${'0'.repeat(30)}`,
        status: 'needs_attention',
        subject: { type: 'distributorLines', id: '5:t6884' },
        createdAt: `2026-11-17T09:${String(at).padStart(2, '0')}:00+00:00`,
      }),
    );
    const h = harness([apps(), list(...many), list(), found(many[24])], { env: UTC });
    h.signedIn();
    expect(await runCli(['apps', 'requests'], { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(0);
    const lines = strip(h.out()).split('\n');
    expect(lines[0]).toBe('25 requests in Acme (3), sandbox');
    const header = lines.find((line) => line.startsWith('ID '))!;
    expect(header).toContain('APP');
    expect(header).not.toContain('ABOUT');
    const rows = lines.filter((line) => /^\d{8} /.test(line));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatch(/^05000000 /);
    expect(h.out()).toContain('5 older requests are not shown. --json prints them all.');
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
  });
});
