import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recordView } from '../src/cli/record-view';
import { runCli } from '../src/cli/run';
import { Style } from '../src/cli/style';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * The record view (review/cli-dx/lean-output.md in the run folder, section
 * 1), on answers recorded from the PR 1250 preview.
 */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/records/collaborator-and-program.json', import.meta.url), 'utf8')) as {
  collaborator: Record<string, unknown>;
  program: Record<string, unknown>;
};
const UTC = { env: { TZ: 'UTC' } };
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');

describe('siren collaborators get, as a record view', () => {
  it('puts the name in the headline, lists programs and distributors as sections, and reads no notes (review round 1: notes are an operator job)', async () => {
    const h = harness([reply(200, recorded.collaborator)], UTC);
    h.signedIn();
    expect(await h.run(['collaborators', 'get', '1']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /collaborators/1']);
    expect(h.out()).toBe(
      [
        'collaborator 1 · Neva Volkman',
        '',
        '  status        active',
        '  email         nevavolkman2715@example.com',
        '  nickname      nevavolkman2715',
        '  referralCode  KHK',
        // A timestamp keeps its time (review of PR 94).
        '  created       Nov 25, 2026 18:57 UTC',
        '  fields        none',
        '',
        '  programs (2)',
        '    1  Referral Program',
        '    2  Creator Program',
        '',
        '  distributors (1)',
        '    1  Partner Revenue Share',
        '',
      ].join('\n'),
    );
    // Through a pipe, Next goes to standard error, so standard output is the record alone.
    expect(h.err()).toContain('siren programs get 1');
    expect(h.err()).not.toContain('note');
  });

  it('keeps every line within 80 columns in a terminal, and puts Next on standard output there', async () => {
    const h = harness([reply(200, recorded.collaborator)], UTC);
    h.signedIn();
    expect(await runCli(['collaborators', 'get', '1'], { ...h.io, stdoutTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(0);
    const shown = strip(h.out());
    for (const line of shown.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    expect(shown).toContain('Next\n  1  siren programs get 1');
    expect(shown).not.toContain('[{');
  });

  it('prints the record and nothing else with --json', async () => {
    const h = harness([reply(200, recorded.collaborator)], UTC);
    h.signedIn();
    expect(await h.run(['collaborators', 'get', '1', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual(recorded.collaborator);
    expect(h.paths()).toEqual(['GET /collaborators/1']);
  });
});

describe('siren programs get, as a record view', () => {
  it('names a reference by its name, lays a nested object out as dotted rows, and drops a modified date equal to created', async () => {
    const h = harness([reply(200, recorded.program)], UTC);
    h.signedIn();
    expect(await h.run(['programs', 'get', '1']), h.err()).toBe(0);
    const out = h.out();
    expect(out.split('\n')[0]).toBe('program 1 · Referral Program');
    expect(out).toMatch(/\n {2}incentiveType +Percentage of Transaction \(saleTransactionPercentage\)\n/);
    expect(out).toMatch(/\n {2}incentiveTypeArgs\.transactionPercent +10\n/);
    expect(out).toMatch(/\n {2}created +Nov 25, 2026 18:57 UTC\n/);
    expect(out).not.toContain('modified');
    expect(out).not.toContain('notes (');
  });
});

describe('recordView', () => {
  const plain = new Style({ tty: false, env: {} });

  it('shows the first 10 of a long list, then how many more and where to see them', () => {
    const programs = Array.from({ length: 47 }, (_, at) => ({ id: at + 1, name: `Program ${at + 1}` }));
    const view = recordView(plain, { id: 3, name: 'Ana', programs }, { what: 'collaborator', words: 'collaborators', zone: 'UTC' });
    const lines = view.lines.join('\n');
    expect(lines).toContain('  programs (47)\n    1   Program 1\n');
    expect(lines).toContain('    10  Program 10\n    and 37 more. siren collaborators get 3 --json lists them all.');
    expect(lines).not.toContain('Program 11');
  });

  it('prints none for an empty list or object, joins a list of plain values, and adds up to two short fields to an item', () => {
    const view = recordView(plain, { id: 1, title: 'T', tags: [], meta: {}, codes: ['A', 'B'], items: [{ id: 4, label: 'Four', status: 'active', units: 'USD', note: 'x'.repeat(60) }] }, { what: 'thing', words: 'things', zone: 'UTC' });
    const text = view.lines.join('\n');
    expect(text.split('\n')[0]).toBe('thing 1 · T');
    expect(text).toContain('  tags   none');
    expect(text).toContain('  meta   none');
    expect(text).toContain('  codes  A, B');
    expect(text).toContain('    4  Four  active  USD');
    expect(text).not.toContain('xxxx');
  });

  it('names the command for a section that is a resource, and nothing for one that is not', () => {
    const view = recordView(plain, { id: 1, name: 'N', programs: [{ id: 7, name: 'P' }], widgets: [{ id: 2, name: 'W' }] }, { what: 'collaborator', words: 'collaborators', zone: 'UTC', resources: ['programs'] });
    expect(view.next).toEqual(['programs get 7']);
  });
});

describe('Siren dates', () => {
  it('reads a date without a zone as UTC, as Siren stores it, whatever the machine zone', async () => {
    const { day, minute, sirenDate } = await import('../src/cli/record-view');
    expect(sirenDate('2026-11-24 16:10:00').toISOString()).toBe('2026-11-24T16:10:00.000Z');
    expect(sirenDate('2026-11-24T16:10:00+02:00').toISOString()).toBe('2026-11-24T14:10:00.000Z');
    expect(minute('2026-11-24 23:30:00', 'UTC')).toBe('Nov 24 23:30');
    expect(day('2026-11-24 23:30:00', 'UTC')).toBe('Nov 24, 2026');
    expect(day('2026-11-24', 'UTC')).toBe('Nov 24, 2026');
  });
});
