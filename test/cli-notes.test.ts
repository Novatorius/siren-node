import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * siren notes (review/cli-dx/lean-output.md in the run folder, section 3),
 * on Siren's /notes routes as feat/apps serves them: GET /notes takes one
 * sourceType and at most one sourceId, POST /notes takes {sourceType,
 * sourceId, body}, PUT /notes/{id} takes {body, revision?}, and DELETE
 * /notes/{id} leaves a marker in the same feeds.
 */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/records/collaborator-and-program.json', import.meta.url), 'utf8')) as { collaboratorNotes: unknown[]; collaboratorNotesTotal: number };
const feed = reply(200, recorded.collaboratorNotes, { 'x-siren-estimated-count': String(recorded.collaboratorNotesTotal) });
const UTC = { env: { TZ: 'UTC' } };
const queryOf = (h: ReturnType<typeof harness>, at = 0) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
const bodyOf = (h: ReturnType<typeof harness>, at = 0) => JSON.parse(h.http.requests[at]!.body!) as Record<string, unknown>;
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { ...UTC, ...options });
  h.signedIn();
  return h;
};
const signedInLive = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  // A session whose Siren is a production edition, which every other write refuses without --live.
  const h = harness(replies, { ...UTC, edition: 'production', ...options });
  h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production', baseUrl: SANDBOX_BASE_URL }) });
  return h;
};

describe('the note shorthand', () => {
  it('prints the help for notes add on siren collaborators note --help (review of PR 94)', async () => {
    const h = signedIn([]);
    expect(await h.run(['collaborators', 'note', '--help']), h.err()).toBe(0);
    expect(h.out()).toContain('notes add <type:id> (<text> | --stdin)');
    expect(h.http.requests).toHaveLength(0);
  });
});

describe('siren notes --on', () => {
  it("reads one record's notes, newest first, one line each with its time and id", async () => {
    const h = signedIn([feed]);
    expect(await h.run(['notes', '--on', 'collaborator:1']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /notes']);
    expect(queryOf(h)).toMatchObject({ sourceType: 'collaborator', sourceId: '1', order: 'desc', number: '20' });
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toBe('Nov 25 19:29  420  Siren could not send Neva Volkman the Payout sent email to the collaborator yet and will try again. The mail engine gave no status code.');
    expect(lines).toHaveLength(3);
    expect(h.err()).toContain('3 of 39 notes. --limit 100 reads more.');
  });

  it('reads the whole feed of a type with --on and no id, and sends --search, --since and --limit', async () => {
    const h = signedIn([reply(200, [], { 'x-siren-estimated-count': '0' })], { env: { TZ: 'UTC' } });
    expect(await h.run(['notes', '--on', 'program', '--search', 'payout', '--since', '2026-11-20T00:00:00Z', '--limit', '5']), h.err()).toBe(0);
    expect(queryOf(h)).toMatchObject({ sourceType: 'program', search: 'payout', from: '2026-11-20 00:00:00', number: '5' });
    expect(queryOf(h)).not.toHaveProperty('sourceId');
    expect(h.out()).toBe('');
    expect(h.err()).toContain('No notes match.');
  });

  it("refuses two --on, since Siren reads one record's notes at a time, and sends nothing", async () => {
    const h = signedIn([]);
    expect(await h.run(['notes', '--on', 'collaborator:1', '--on', 'program:123'])).toBe(1);
    expect(h.err()).toContain("Siren reads one record's notes at a time");
    expect(h.paths()).toEqual([]);
  });

  it('refuses a type Siren keeps no notes on, naming the ones it does, and an --on missing', async () => {
    const h = signedIn([]);
    expect(await h.run(['notes', '--on', 'webhook:4'])).toBe(2);
    expect(h.err()).toContain('collaborator, obligation, conversion');
    expect(await h.run(['notes'])).toBe(2);
    expect(h.err()).toContain('--on collaborator:1');
    expect(h.paths()).toEqual([]);
  });

  it("prints Siren's answer with --json", async () => {
    const h = signedIn([feed]);
    expect(await h.run(['notes', '--on', 'collaborator:1', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual(recorded.collaboratorNotes);
  });
});

describe('siren <resource> note <id> and siren notes add', () => {
  it('adds a note to a record in one short command, on a live organization without --live', async () => {
    const h = signedInLive([reply(201, { id: 512, body: 'Called about the March payout' })]);
    expect(await h.run(['collaborators', 'note', '1', 'Called about the March payout']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /notes']);
    expect(bodyOf(h)).toEqual({ sourceType: 'collaborator', sourceId: 1, body: 'Called about the March payout' });
    expect(h.out()).toContain('Noted on collaborator 1 as note 512.');
    expect(h.err()).toContain('siren notes --on collaborator:1');
    // The same organization refuses a write that isn't liveSafe without --live, and sends nothing for it.
    expect(await h.run(['programs', 'delete', '4']), h.err()).toBe(1);
    expect(h.err()).toContain('--live');
    expect(h.paths()).toEqual(['POST /notes']);
  });

  it('takes the text from standard input with --stdin, and maps a two-word resource to its type', async () => {
    const h = signedIn([reply(201, { id: 9, body: 'Long text' })], { stdin: 'Long text\n' });
    expect(await h.run(['collaborator-groups', 'note', '5', '--stdin']), h.err()).toBe(0);
    expect(bodyOf(h)).toEqual({ sourceType: 'collaborator_group', sourceId: 5, body: 'Long text' });
    const added = signedIn([reply(201, { id: 10, body: 'x' })]);
    expect(await added.run(['notes', 'add', 'program:4', 'x']), added.err()).toBe(0);
    expect(bodyOf(added)).toEqual({ sourceType: 'program', sourceId: 4, body: 'x' });
  });

  it('refuses an empty note, and text both typed and on --stdin, before sending', async () => {
    const h = signedIn([], { stdin: '' });
    expect(await h.run(['collaborators', 'note', '1', '--stdin'])).toBe(2);
    expect(await h.run(['collaborators', 'note', '1', 'typed', '--stdin'])).toBe(2);
    expect(h.paths()).toEqual([]);
  });
});

describe('siren notes edit and delete', () => {
  it('edits with the revision it was given, and deletes with --yes', async () => {
    const h = signedInLive([reply(200, { id: 42, body: 'New' }), reply(200, { id: 42 })]);
    expect(await h.run(['notes', 'edit', '42', 'New', '--revision', 'abc']), h.err()).toBe(0);
    expect(h.paths()[0]).toBe('PUT /notes/42');
    expect(bodyOf(h)).toEqual({ body: 'New', revision: 'abc' });
    expect(await h.run(['notes', 'delete', '42', '--yes']), h.err()).toBe(0);
    expect(h.paths()[1]).toBe('DELETE /notes/42');
    expect(h.out()).toContain('Deleted note 42.');
  });

  it('sends no delete without --yes when there is no terminal to ask in', async () => {
    const h = signedIn([]);
    expect(await h.run(['notes', 'delete', '42'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('--yes');
  });
});
