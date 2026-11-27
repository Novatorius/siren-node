import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * CLI review round 1, findings C10 and C16: every hint a record command
 * prints runs as printed. Each test takes the hint from the refusal, runs
 * it through the same fakes, and checks it is no usage error (exit 2).
 */

const LIVE = 'https://live.example.com/siren/v1';
const envelope = (items: unknown[]) => ({ items, total: items.length, page: 1, perPage: 10, totalPages: 1 });
const signedIn = (replies: Parameters<typeof harness>[0]) => {
  const h = harness(replies, { env: { TZ: 'UTC' } });
  h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'uat-org' }) });
  return h;
};
const signedInLive = (replies: Parameters<typeof harness>[0]) => {
  const h = harness(replies, { edition: 'production', env: { SIREN_BASE_URL: LIVE, TZ: 'UTC' } });
  h.signedIn({ [LIVE]: session({ edition: 'production', baseUrl: LIVE, orgSlug: 'uat-org' }) });
  return h;
};

/** The words of a `siren …` hint, split as a shell would split them, without `siren`. */
function argvOf(hint: string): string[] {
  const words = [...hint.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((match) => (match[1] !== undefined ? match[1].replace(/'\\''/g, "'") : match[2]!));
  expect(words[0]).toBe('siren');
  return words.slice(1);
}

/** The command a refusal says to run: the text after "Run " up to the words about it. */
function hintOf(err: string): string {
  const flat = err.replace(/\s+/g, ' ');
  const found = /Run (siren .+?)(?: to | lists | for |\.$|\. )/.exec(flat);
  expect(found, flat).not.toBeNull();
  return found![1]!.replace(/\.$/, '');
}

describe('hints run as printed (C10)', () => {
  it('keeps every -d flag in the --live hint for a live write', async () => {
    const h = signedInLive([]);
    expect(await h.run(['collaborators', 'update', '99999', '-d', 'nickname=x'])).toBe(1);
    const hint = hintOf(h.err());
    expect(hint).toBe('siren collaborators update 99999 -d nickname=x --live');
    const again = signedInLive([reply(200, { id: 99999, nickname: 'x' })]);
    expect(await again.run(argvOf(hint)), again.err()).toBe(0);
    expect(JSON.parse(String(again.http.requests[0]!.body))).toEqual({ nickname: 'x' });
  });

  it('quotes a -d value with spaces, so the hint is one shell word for it', async () => {
    const h = signedInLive([]);
    expect(await h.run(['collaborators', 'update', '4', '-d', "nickname=Ana's shop"])).toBe(1);
    const hint = hintOf(h.err());
    expect(hint).toBe("siren collaborators update 4 -d 'nickname=Ana'\\''s shop' --live");
    const again = signedInLive([reply(200, { id: 4 })]);
    expect(await again.run(argvOf(hint)), again.err()).toBe(0);
    expect(JSON.parse(String(again.http.requests[0]!.body))).toEqual({ nickname: "Ana's shop" });
  });

  it('points get /nope at siren resources, never at the same failing call', async () => {
    const h = signedIn([reply(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' })]);
    expect(await h.run(['get', '/nope'])).toBe(1);
    expect(h.err()).toContain('Siren has no route at GET /nope.');
    const hint = hintOf(h.err());
    expect(hint).toBe('siren resources');
    const again = signedIn([]);
    expect(await again.run(argvOf(hint)), again.err()).toBe(0);
  });

  it("names a missing record as siren explain does, and its list hint runs", async () => {
    const h = signedIn([reply(404, { error: { message: 'Collaborator not found.', code: 'not_found' } })]);
    expect(await h.run(['collaborators', 'get', '99999'])).toBe(1);
    expect(h.err()).toContain('Siren has no collaborator 99999 in uat-org.');
    const hint = hintOf(h.err());
    expect(hint).toBe('siren collaborators list');
    const again = signedIn([reply(200, envelope([]))]);
    expect(await again.run(argvOf(hint)), again.err()).toBe(0);
  });

  it("leaves out the transport's generic 404 words, which only repeat the headline", async () => {
    const h = signedIn([reply(404, {})]);
    expect(await h.run(['collaborators', 'get', '99999'])).toBe(1);
    expect(h.err()).toContain('Siren has no collaborator 99999 in uat-org. So there is nothing to show.');
    expect(h.err()).not.toContain('Request failed');
  });

  it('offers a failed write again with its -d flags and --dry-run', async () => {
    const h = signedIn([reply(500, { error: { message: 'Something went wrong.', code: 'internal' } })]);
    expect(await h.run(['collaborators', 'update', '7', '-d', 'nickname=x'])).toBe(1);
    const hint = hintOf(h.err());
    expect(hint).toBe('siren collaborators update 7 -d nickname=x --dry-run');
    const again = signedIn([]);
    expect(await again.run(argvOf(hint)), again.err()).toBe(0);
    expect(again.out()).toContain('Would send PUT');
    expect(again.out()).toContain('"nickname":"x"');
  });

  it('runs the --fields a typo hint names', async () => {
    const records = [{ id: 1, status: 'active', fullName: 'Ana', email: 'ana@example.com' }];
    const h = signedIn([reply(200, envelope(records))]);
    expect(await h.run(['collaborators', 'list', '--fields', 'id,emial'])).toBe(2);
    const fields = /Did you mean --fields (\S+)\?/.exec(h.err())?.[1];
    expect(fields).toBe('id,email');
    const again = signedIn([reply(200, envelope(records))]);
    expect(await again.run(['collaborators', 'list', '--fields', fields!]), again.err()).toBe(0);
    expect(again.out()).toContain('ana@example.com');
  });

  it("runs the help a refused -d value points to, and it lists that field's values", async () => {
    const h = signedIn([]);
    expect(await h.run(['conversions', 'update', '7', '-d', 'status=done'])).toBe(2);
    const help = /(siren conversions update --help)/.exec(h.err())?.[1];
    expect(help).toBeDefined();
    const again = signedIn([]);
    expect(await again.run(argvOf(help!))).toBe(0);
    expect(again.out()).toContain('status=');
  });
});

describe('a near resource name (C16)', () => {
  it('suggests collaborators list for colaborators list', async () => {
    const h = harness([]);
    expect(await h.run(['colaborators', 'list'])).toBe(2);
    expect(h.err()).toContain('Did you mean "collaborators list"?');
    const again = signedIn([reply(200, envelope([]))]);
    expect(await again.run(['collaborators', 'list']), again.err()).toBe(0);
  });

  it('still suggests a command over a resource for a command typo', async () => {
    const h = harness([]);
    expect(await h.run(['lgin'])).toBe(2);
    expect(h.err()).toContain('Did you mean "login"?');
  });
});
