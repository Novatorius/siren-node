import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cursorOf, offsetsOf } from '../src/cli/commands/activity';
import { runCli } from '../src/cli/run';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * siren activity --on <type:id>: a record's timeline, newest first. Siren has
 * no single timeline route, so the command reads GET /notes, GET
 * /conversions and GET /payouts and merges them. The answers are recorded
 * from Siren PR 1254's preview, for collaborator 208 in uat-org.
 */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/records/activity-and-chains.json', import.meta.url), 'utf8')) as Record<string, any>;
const page = (key: string, items?: unknown[]) => {
  const { query: _query, ...body } = recorded[key];
  return reply(200, items === undefined ? body : { ...body, items });
};
const EUR = { code: 'EUR', name: 'Euro', symbol: '€', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: true };
const currencies = () => reply(200, [EUR]);
const APP = 'https://sandbox.sirenaffiliates.com';
const UTC = { env: { TZ: 'UTC' } };
const queryOf = (h: ReturnType<typeof harness>, at: number) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { ...UTC, ...options });
  h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'uat-org' }) });
  return h;
};
/** The `type id` of each line, such as `conversion 5640`. */
const records = (text: string) => text.trimEnd().split('\n').map((line) => /\b(?:note|conversion|payout) \d+/.exec(line)?.[0]);
const all = () => [page('collaboratorNotes'), page('collaboratorConversions'), page('collaboratorPayouts'), currencies()];

describe('siren activity --on', () => {
  it("merges a collaborator's notes, conversions and payouts, newest first, one line each with its page last", async () => {
    const h = signedIn(all());
    expect(await h.run(['activity', '--on', 'collaborator:208', '--limit', '7']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /notes', 'GET /conversions', 'GET /payouts', 'GET /registries/currencies']);
    expect(queryOf(h, 0)).toMatchObject({ sourceType: 'collaborator', sourceId: '208', order: 'desc', number: '8', offset: '0' });
    expect(queryOf(h, 1)).toMatchObject({ collaboratorId: '208', orderBy: 'id', order: 'desc', number: '8', offset: '0' });
    expect(queryOf(h, 2)).toMatchObject({ collaboratorId: '208', orderBy: 'id', order: 'desc' });
    const lines = h.out().trimEnd().split('\n');
    expect(records(h.out())).toEqual(['note 14334', 'note 14333', 'note 14304', 'note 14303', 'note 14299', 'conversion 5640', 'note 14297']);
    expect(lines[0]).toMatch(/^Nov 27 17:39  note 14334 +Conversion for sale \(€109\.00 EUR\) in EU Partner Program approved by admin@siren-uat\.local  https:\/\/sandbox\.sirenaffiliates\.com\/collaborators\/208\/view\?org=uat-org$/);
    // A conversion names its sale and reward by type and id, prints its amount as money, and opens on its own page.
    expect(lines[5]).toBe(`Nov 26 15:23  conversion 5640  complete  €19.62 EUR  sale conversion, transaction 7517, obligation 5888  ${APP}/conversions/5640?org=uat-org`);
    // The count adds what each route says it holds: 200 notes, 77 conversions and 7 payouts.
    expect(h.err()).toContain('7 of 284 items.');
    expect(h.err()).toContain(`siren activity --on collaborator:208 --limit 7 --cursor ${cursorOf({ notes: 6, conversions: 1, payouts: 0 })} reads the next page.`);
    expect(h.err()).toContain('siren explain conversion 5640 says why it paid what it did.');
  });

  it('reads on from a cursor, and shows a payout on the fulfillment that holds it', async () => {
    const h = signedIn([page('collaboratorNotes', []), page('collaboratorConversions', recorded.collaboratorConversions.items.slice(1)), page('collaboratorPayouts'), currencies()]);
    expect(await h.run(['activity', '--on', 'collaborator:208', '--cursor', cursorOf({ notes: 6, conversions: 1, payouts: 0 })]), h.err()).toBe(0);
    expect([queryOf(h, 0).offset, queryOf(h, 1).offset, queryOf(h, 2).offset]).toEqual(['6', '1', '0']);
    const lines = h.out().trimEnd().split('\n');
    expect(records(h.out())).toEqual(['conversion 5514', 'conversion 5493', 'conversion 5484', 'payout 613', 'payout 565', 'payout 523']);
    expect(lines[3]).toBe(`Nov 1 13:00   payout 613       unpaid    €218.70 EUR  in fulfillment 39, waiting: paypal email missing  ${APP}/fulfillments/39?org=uat-org`);
    expect(h.err()).not.toContain('--cursor');
  });

  it('prints the record page once, then each item as a heading and its full text wrapped beneath, within 80 columns', async () => {
    const h = signedIn(all());
    const tty = { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } };
    expect(await runCli(['activity', '--on', 'collaborator:208', '--limit', '3'], tty), h.err()).toBe(0);
    const plain = h.out().replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n');
    expect(plain.slice(0, 2)).toEqual(['Activity on collaborator 208', `${APP}/collaborators/208/view?org=uat-org`]);
    // The page is not repeated under each note.
    expect(plain.filter((line) => line.includes(APP))).toHaveLength(1);
    expect(plain[3]).toBe('Nov 27 17:39  note 14334');
    // The note's whole text, wrapped at spaces and never cut with an ellipsis.
    const body = plain.slice(4, plain.indexOf('', 4)).map((line) => line.trim()).join(' ');
    expect(body).toBe('Conversion for sale (€109.00 EUR) in EU Partner Program approved by admin@siren-uat.local');
    expect(h.out()).not.toContain('…');
    for (const line of plain) expect(line.length).toBeLessThanOrEqual(80);
    expect(h.err()).toContain('opens its page in Siren.');
  });

  it('prints the items, the record, the cursor and what it left out as JSON, amounts as Siren stores them', async () => {
    const h = signedIn([page('collaboratorNotes'), page('collaboratorConversions'), page('collaboratorPayouts')]);
    expect(await h.run(['activity', '--on', 'collaborator:208', '--limit', '2', '--json']), h.err()).toBe(0);
    // --json reads no currencies, since it keeps the stored integers.
    expect(h.paths()).toEqual(['GET /notes', 'GET /conversions', 'GET /payouts']);
    const body = JSON.parse(h.out());
    expect(body.record).toEqual({ type: 'collaborator', id: 208, url: `${APP}/collaborators/208/view?org=uat-org` });
    expect(body.items.map((item: { kind: string; id: number }) => `${item.kind} ${item.id}`)).toEqual(['status 14334', 'status 14333']);
    expect(body.items[1]).toMatchObject({ type: 'note', key: 'obligation_status_changed', amount: null, date: '2026-11-27T17:39:18+00:00' });
    expect(body.nextCursor).toBe(cursorOf({ notes: 2, conversions: 0, payouts: 0 }));
    expect(body.hidden).toEqual([]);
  });

  it('keeps to the kinds --kind names, and reads only the routes they need', async () => {
    const h = signedIn([page('collaboratorPayouts'), currencies()]);
    expect(await h.run(['activity', '--on', 'collaborator:208', '--kind', 'payout']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /payouts', 'GET /registries/currencies']);
    expect(h.out().trimEnd().split('\n')).toHaveLength(3);
    // A status change is a note Siren wrote when a status changed.
    const status = signedIn([page('collaboratorNotes')]);
    expect(await status.run(['activity', '--on', 'collaborator:208', '--kind', 'status', '--json']), status.err()).toBe(0);
    expect(JSON.parse(status.out()).items.map((item: { id: number }) => item.id)).toEqual([14334, 14333]);
  });

  it('reads a program\'s conversions by programId, and the organization\'s own notes with --on org', async () => {
    const h = signedIn([page('collaboratorNotes', []), page('collaboratorConversions', [])]);
    expect(await h.run(['activity', '--on', 'program:16']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /notes', 'GET /conversions']);
    expect(queryOf(h, 1)).toMatchObject({ programId: '16' });
    expect(h.err()).toContain('Nothing has happened to this record that this sign-in can read.');
    const org = signedIn([page('collaboratorNotes', [])]);
    expect(await org.run(['activity', '--on', 'org']), org.err()).toBe(0);
    expect(queryOf(org, 0)).toMatchObject({ sourceType: 'org', sourceId: '3' });
  });

  it('sends --since to the notes, reaches back further than the log, and drops older conversions and payouts', async () => {
    const h = signedIn([page('collaboratorNotes', []), page('collaboratorConversions'), page('collaboratorPayouts'), currencies()]);
    expect(await h.run(['activity', '--on', 'collaborator:208', '--since', '2026-10-15T00:00:00Z']), h.err()).toBe(0);
    expect(queryOf(h, 0)).toMatchObject({ from: '2026-10-15 00:00:00' });
    expect(records(h.out())).toEqual(['conversion 5640', 'conversion 5514', 'conversion 5493', 'conversion 5484', 'payout 613']);
  });

  it('says which part it left out when one route is missing or refused, and shows the rest', async () => {
    const h = signedIn([page('collaboratorNotes', []), page('collaboratorConversions', []), reply(404, { error: { message: 'Not found.' } })]);
    expect(await h.run(['activity', '--on', 'collaborator:208', '--json']), h.err()).toBe(0);
    expect(JSON.parse(h.out()).hidden).toEqual([{ part: 'payouts', reason: "This Siren doesn't answer that route yet." }]);
    const refused = signedIn([page('collaboratorNotes', []), reply(403, { error: { message: 'Forbidden', code: 'plan_required' } }), page('collaboratorPayouts', [])]);
    expect(await refused.run(['activity', '--on', 'collaborator:208']), refused.err()).toBe(0);
    expect(refused.err()).toContain("Not shown: conversions. This organization's plan doesn't include it.");
  });

  it('refuses with Siren\'s answer when no part can be read', async () => {
    const h = signedIn([reply(404, { error: { message: 'Not found.' } })]);
    expect(await h.run(['activity', '--on', 'customer:4']), h.err()).toBe(1);
    expect(h.paths()).toEqual(['GET /notes']);
  });

  it('refuses a line it cannot read before sending anything', async () => {
    const h = signedIn([]);
    expect(await h.run(['activity'])).toBe(2);
    expect(h.err()).toContain('--on collaborator:1');
    expect(await h.run(['activity', '--on', 'webhook:4'])).toBe(2);
    expect(h.err()).toContain('collaborator, obligation, conversion');
    expect(await h.run(['activity', '--on', 'collaborator'])).toBe(2);
    expect(h.err()).toContain('collaborator:<id>');
    expect(await h.run(['activity', '--on', 'program:4', '--kind', 'payout'])).toBe(2);
    expect(h.err()).toContain("A program's timeline has no payout items. Siren lists payouts for collaborators and fulfillments.");
    expect(await h.run(['activity', '--on', 'collaborator:1', '--kind', 'refund'])).toBe(2);
    expect(h.err()).toContain('--kind takes note, status, conversion, payout');
    expect(await h.run(['activity', '--on', 'collaborator:1', '--cursor', 'nope'])).toBe(2);
    expect(await h.run(['activity', '--on', 'collaborator:1', '--limit', '500'])).toBe(2);
    expect(h.paths()).toEqual([]);
  });
});

describe('the activity cursor', () => {
  it("reads back the offsets it was made from, and starts at the top when there's none", () => {
    expect(offsetsOf(cursorOf({ notes: 20, conversions: 3, payouts: 1 }))).toEqual({ notes: 20, conversions: 3, payouts: 1 });
    expect(offsetsOf(undefined)).toEqual({ notes: 0, conversions: 0, payouts: 0 });
  });
});
