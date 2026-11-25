import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { AppRequestStatus } from '../src/taxonomy';
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
const apps = () => reply(200, [appRecord()]);

describe('siren apps requests: the list', () => {
  it('prints a count line, a table oldest first, and a tip that names the newest by its short id', async () => {
    const h = harness([apps(), list(waiting, older), list()], { env: UTC });
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
    expect(h.paths()).toEqual(['GET /apps', 'GET /apps/requests', 'GET /apps/requests']);
  });

  it('with --attention: says how many need you, and why each one does, with the commands for the newest', async () => {
    const h = harness([apps(), list(stuck)], { env: UTC });
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
    const h = harness([apps(), list(waiting), list(), apps(), list(), list()], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--app', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toContain('1 request in Acme (3), sandbox');
    const before = h.out().length;
    expect(await h.run(['apps', 'requests', '--app', APP_KEY]), h.err()).toBe(0);
    expect(h.out().slice(before)).toBe(['No requests for acme-payouts yet.', 'siren apps requests --app acme-payouts --follow watches for them.', ''].join('\n'));
  });

  it('in a terminal: a bold count, a dim id, colored states, and nothing past 80 columns', async () => {
    const long = requestRow({ id: 'apr_c0ffee0123456789abcdef0123456789', status: 'needs_attention', lastError: 'The handler answered 500 with a long message that runs past the edge' });
    const h = harness([apps(), list(waiting, older, long), list()], { env: UTC });
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
    const h = harness([apps(), list(waiting), list(), list({ ...waiting, status: 'answered' }), list(), list({ ...waiting, status: 'answered' }), list()], {
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
    const h = harness([apps(), list(waiting), list(), list(), list()], { env: UTC, onSleep: (count, abort) => (count === 1 ? abort() : undefined) });
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--follow', '--json'])).toBe(130);
    expect(h.out().trim().split('\n').map((line) => JSON.parse(line))).toEqual([waiting]);
  });
});

describe('short request ids', () => {
  // The fake answers every status the SDK lists, so a status the SDK gains is read here too.
  const STATUSES: string[] = Object.values(AppRequestStatus);
  const filler = (n: number, status = 'delivered') =>
    Array.from({ length: n }, (_, at) => requestRow({ id: `apr_ff${String(at).padStart(30, '0')}`, status }));
  const statusOf = (h: ReturnType<typeof harness>, at: number) => new URL(h.http.requests[at]!.url).searchParams.get('status');

  it('reads a request by its first eight characters when the whole organization holds one id that starts with them', async () => {
    const h = harness([list(waiting, older), reply(200, { ...waiting, data: {}, answer: null, answeredByUser: null }), apps(), reply(200, [])], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'requests', 'b79943ff']), h.err()).toBe(0);
    // Fewer than 50 requests in all, so one read covers the whole organization.
    expect(h.paths()).toEqual(['GET /apps/requests', `GET /apps/requests/${APP_REQUEST_ID}`, 'GET /apps', `GET /apps/${APP_KEY}/deliveries`]);
  });

  it('takes a short id with or without apr_ for resend', async () => {
    const h = harness([list(waiting), reply(200, waiting)], { env: UTC });
    h.signedIn();
    expect(await h.run(['apps', 'resend', 'apr_b79943ff']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps/requests', `POST /apps/requests/${APP_REQUEST_ID}/resend`]);
  });

  it('counts the 4 characters after apr_, so apr_ alone or with 3 characters is no id, and nothing is sent', async () => {
    for (const typed of ['apr_', 'apr_b79', 'b79', '']) {
      const h = harness([list(waiting), reply(200, { status: 'accepted' })]);
      h.signedIn();
      expect(await h.run(['apps', 'answer', typed, '--body', '{"outcome":"paid"}']), typed).toBe(2);
      expect(h.err()).toContain("isn't a request id");
      expect(h.sent()).toEqual([]);
    }
  });

  it('reads only statuses Siren accepts: the list ListAppRequests validates at feat/apps 0383186437', () => {
    expect(STATUSES).toEqual(['pending', 'sent', 'delivered', 'answered', 'applying', 'applied', 'needs_attention', 'dropped']);
  });

  it('reads every state when the latest 50 are full, and finds an older request that matches', async () => {
    const reads = [list(...filler(50)), ...STATUSES.map((status) => (status === 'needs_attention' ? list(requestRow({ status })) : list(...filler(3, status))))];
    const h = harness([...reads, reply(200, { status: 'accepted' })]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', 'b79943ff', '--body', '{"outcome":"paid"}']), h.err()).toBe(0);
    expect(h.paths()).toEqual([...Array.from({ length: STATUSES.length + 1 }, () => 'GET /apps/requests'), `POST /apps/requests/${APP_REQUEST_ID}/answer`]);
    expect(Array.from({ length: STATUSES.length + 1 }, (_, at) => statusOf(h, at))).toEqual([null, ...STATUSES]);
  });

  it('refuses, and answers nothing, when a state holds 50 or more, so an older request could start the same way', async () => {
    const reads = [list(waiting, ...filler(49)), ...STATUSES.map((status) => (status === 'delivered' ? list(...filler(50)) : list()))];
    const h = harness([...reads, reply(200, { status: 'accepted' })]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', 'b79943ff', '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(h.err()).toContain("can't be sure b79943ff names one request");
    expect(h.err()).toContain('whole id');
    expect(h.paths()).not.toContain(`POST /apps/requests/${APP_REQUEST_ID}/answer`);
  });

  it('refuses a short id that matches no request, or several, which it lists, and answers none of them', async () => {
    const none = harness([list(waiting)]);
    none.signedIn();
    expect(await none.run(['apps', 'requests', 'deadbeef'])).toBe(1);
    expect(none.err()).toContain('Acme has no request that starts with deadbeef.');
    expect(none.err()).toContain('siren apps requests');

    const twin = requestRow({ id: 'apr_b79943ff00000000000000000000beef' });
    const both = harness([list(waiting, twin), reply(200, { status: 'accepted' })]);
    both.signedIn();
    expect(await both.run(['apps', 'answer', 'b79943ff', '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(both.err()).toContain('2 requests start with b79943ff: b79943ff8ca3, b79943ff0000.');
    expect(both.paths()).toEqual(['GET /apps/requests']);
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
    const h = harness([detail(), apps(), reply(200, [sendOf(2, 200, '{"received":true}', 'delivered'), sendOf(1, 500, 'upstream timeout', 'failed')])], { env: UTC });
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

    const stuck = harness([detail({ status: 'needs_attention', lastError: 'Host not found' }), apps(), reply(200, [])], { env: UTC });
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
    const h = harness([reply(200, { status: 'accepted' }), reply(200, { status: 'accepted', duplicate: true })]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}']), h.err()).toBe(0);
    expect(h.out()).toBe(['Answered b79943ff', '', '  Answer   {"outcome":"paid"}', '', 'siren apps requests b79943ff shows it.', ''].join('\n'));
    const before = h.out().length;
    expect(await h.run(['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":"paid"}']), h.err()).toBe(0);
    expect(h.out().slice(before)).toBe('Siren already had this answer for b79943ff. Nothing changed.\n');
  });

  it('resend: a ✓ line with the short id in bold, its state and sends, and the command that shows each send', async () => {
    const h = harness([reply(200, requestRow({ sendCount: 2 }))]);
    h.signedIn();
    expect(await h.run(['apps', 'resend', APP_REQUEST_ID]), h.err()).toBe(0);
    expect(h.out()).toBe(['Sent b79943ff again', '', '  State   waiting', '  Sends   2', '', 'siren apps requests b79943ff shows each send.', ''].join('\n'));
  });
});
