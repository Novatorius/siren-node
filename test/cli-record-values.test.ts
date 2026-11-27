import { describe, expect, it } from 'vitest';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * CLI review round 1, findings C11, C16 and C20: the record commands list
 * the values a filter or body field takes, refuse another before sending,
 * and say where a read word differs from a write word.
 */

const envelope = (items: unknown[]) => ({ items, total: items.length, page: 1, perPage: 10, totalPages: 1 });

function signedIn(replies: Parameters<typeof harness>[0] = []) {
  const h = harness(replies);
  h.signedIn();
  return h;
}

describe('status filters take the words Siren stores (C11)', () => {
  it('lists a conversion status filter values in help and says approved reads complete', async () => {
    const h = signedIn();
    expect(await h.run(['conversions', 'list', '--help'])).toBe(0);
    const help = h.out().replace(/\s+/g, ' ');
    expect(help).toContain('--status <pending|complete|rejected|expired|deleted|approved>');
    expect(help).toContain('Siren stores an approved conversion as complete, so --status approved reads complete. A write takes approved.');
  });

  it('sends --status approved on conversions as complete, the word Siren stores', async () => {
    const h = signedIn([reply(200, envelope([]))]);
    expect(await h.run(['conversions', 'list', '--status', 'approved']), h.err()).toBe(0);
    expect(new URL(h.http.requests[0]!.url).searchParams.get('status')).toBe('complete');
  });

  it('refuses a status word Siren never stores, naming the ones it does, and sends nothing', async () => {
    const h = signedIn();
    expect(await h.run(['transactions', 'list', '--status', 'paid'])).toBe(2);
    expect(h.err()).toContain('--status takes complete, cancelled or refunded, and "paid" isn\'t one.');
    expect(h.http.requests).toHaveLength(0);
  });

  it('lists the obligation and collaborator statuses from the SDK taxonomy', async () => {
    for (const [resource, words] of [
      ['obligations', '--status <value> Sent as status: draft, pending, approved, rejected, complete, deleted, cancelled'],
      ['collaborators', '--status <active|inactive|pending|rejected|deleted|invited>'],
    ] as const) {
      const h = signedIn();
      expect(await h.run([resource, 'list', '--help'])).toBe(0);
      expect(h.out().replace(/\s+/g, ' ')).toContain(words);
    }
  });
});

describe('write help lists the body fields and their values (C20)', () => {
  it('lists every field conversions update takes, with status values and a real example', async () => {
    const h = signedIn();
    expect(await h.run(['conversions', 'update', '--help'])).toBe(0);
    const out = h.out();
    expect(out).toContain('FIELDS');
    expect(out.replace(/\s+/g, ' ')).toContain('status= One of pending, approved, rejected or expired. Siren reads an approved conversion back as complete.');
    expect(out).toMatch(/transactionId= +A whole number, or null to clear it\./);
    expect(out).toContain('$ siren conversions update 12 -d status=approved');
  });

  it('marks a required field and gives create an example of its type', async () => {
    const h = signedIn();
    expect(await h.run(['programs', 'create', '--help'])).toBe(0);
    expect(h.out()).toMatch(/name= +Text\. required\./);
    expect(h.out()).toContain('$ siren programs create -d status=active');
  });

  it('lists no Fields section on a read', async () => {
    const h = signedIn();
    expect(await h.run(['conversions', 'get', '--help'])).toBe(0);
    expect(h.out()).not.toContain('FIELDS');
  });
});

describe('a -d value a field does not take is refused before sending (C11)', () => {
  it('refuses status=complete on a conversion update and says to send approved', async () => {
    const h = signedIn();
    expect(await h.run(['conversions', 'update', '7', '-d', 'status=complete'])).toBe(2);
    expect(h.err().replace(/\s+/g, ' ')).toContain('status takes pending, approved, rejected or expired, and "complete" isn\'t one. Siren reads an approved conversion back as complete. Send status=approved to approve one. siren conversions update --help lists every field.');
    expect(h.http.requests).toHaveLength(0);
  });

  it('refuses the same value through a raw put on the generated route', async () => {
    const h = signedIn();
    expect(await h.run(['put', '/conversions/7', '-d', 'status=done'])).toBe(2);
    expect(h.err()).toContain('status takes pending, approved, rejected or expired, and "done" isn\'t one.');
    expect(h.http.requests).toHaveLength(0);
  });

  it('sends a value the field takes', async () => {
    const h = signedIn([reply(200, { id: 7, status: 'complete' })]);
    expect(await h.run(['conversions', 'update', '7', '-d', 'status=approved', '--json']), h.err()).toBe(0);
    expect(JSON.parse(String(h.http.requests[0]!.body))).toEqual({ status: 'approved' });
  });
});

describe('group help for sandbox and logs (C16)', () => {
  for (const argv of [['sandbox'], ['sandbox', '--help'], ['logs', '--help'], ['help', 'logs']]) {
    it(`siren ${argv.join(' ')} lists the group's commands`, async () => {
      const h = harness([]);
      expect(await h.run(argv), h.err()).toBe(0);
      expect(h.out()).toContain(`siren ${argv.at(-1) === '--help' ? argv[0] : argv.at(-1)} <command> [flags]`);
      expect(h.out()).toMatch(argv.includes('logs') ? /logs tail/ : /sandbox create/);
    });
  }
});
