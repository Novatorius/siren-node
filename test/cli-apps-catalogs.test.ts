import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { capturedReply } from './cloud-captures';
import { reply } from './http-fakes';

/*
 * CLI pass 2, finding 5 (review/cli-dx/pass-2-review.md in the run
 * folder): a misspelled scope or event passed the file check, showed in
 * the plan, and failed only on apply, with no list of the right values.
 * Now apply and diff check each scope and event the app does not hold yet
 * against the lists the Siren they talk to serves, and name the nearest.
 * `siren apps scopes` and `siren apps events` print those lists, and the
 * schema offers them in an editor.
 */

const KEY = APP_KEY;
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const fixture = (name: string) => (JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { body: unknown }).body;
const SCOPES = fixture('api-key-scopes.json') as Record<string, Array<{ scope: string; label: string }>>;
const EVENTS = fixture('webhook-events.json') as Array<{ event: string; category: string; label: string }>;
const file = (app: Record<string, unknown>) =>
  JSON.stringify({ version: 1, apps: { [KEY]: { name: 'Acme', description: "Siren's example app.", url: '${SIREN_APP_URL}', ...app } } });

describe('apply and diff check scopes and events against the lists Siren serves', () => {
  it('refuses a misspelled scope before the plan, names the nearest, and sends nothing', async () => {
    const h = harness([capturedReply('apps-retrieve-404'), reply(200, SCOPES)], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file({ scopes: ['event:sales', 'records:programs:read'] }));
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.err()).toContain('siren.app.json: scopes: "event:sales" is not a scope an app\'s key may hold. Did you mean "event:sale"?');
    expect(h.err()).toContain('siren.app.json has a problem. Siren offers no such scope, so nothing was sent.');
    expect(h.err()).toContain('siren apps scopes');
    expect(h.out()).not.toContain('Plan');
    expect(h.paths()).toEqual([`GET /apps/${KEY}`, 'GET /apps/scopes']);
  });

  it('refuses an event Siren does not send, and lists the events of the same kind when none is close', async () => {
    const h = harness([capturedReply('apps-retrieve-404'), reply(200, EVENTS)], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file({ events: ['program.made'] }));
    expect(await h.run(['apps', 'diff'])).toBe(1);
    expect(h.err()).toContain('siren.app.json: events: Siren sends no event "program.made".');
    expect(h.err()).toMatch(/program\.created/);
    expect(h.err()).toContain('siren apps events');
    expect(h.paths()).toEqual([`GET /apps/${KEY}`, 'GET /apps/events']);
  });

  it('counts every problem, scopes and events together', async () => {
    const h = harness([capturedReply('apps-retrieve-404'), reply(200, SCOPES), reply(200, EVENTS)], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file({ scopes: ['event:sales'], events: ['sale.create', 'payout.paid'] }));
    expect(await h.run(['apps', 'diff'])).toBe(1);
    expect(h.err()).toContain('Did you mean "sale.created"?');
    expect(h.err()).not.toContain('"payout.paid"');
    expect(h.err()).toContain('siren.app.json has 2 problems. Siren offers no such scope or event, so nothing was sent.');
  });

  it('reads no list when every scope and event is one the app already holds, or is a wildcard', async () => {
    const held = appRecord({ events: ['sale.created'], scopes: ['records:programs:read'], apiKey: { ...appRecord().apiKey, scopes: ['records:programs:read'] } });
    const h = harness([reply(200, held)], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file({ scopes: ['records:programs:read', '*'], events: ['sale.created'] }));
    await h.run(['apps', 'diff']);
    expect(h.paths()).toEqual([`GET /apps/${KEY}`]);
  });

  it('leaves the check to Siren when it cannot read a list, as with a token that may not', async () => {
    const h = harness([capturedReply('apps-retrieve-404'), reply(403, { error: 'Forbidden', code: 'forbidden' })], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file({ scopes: ['records:programs:read'] }));
    expect(await h.run(['apps', 'diff']), h.err()).toBe(3);
    expect(h.out()).toContain('Plan');
  });
});

describe('siren apps scopes and siren apps events', () => {
  it('scopes: one line per scope with what it allows, and Siren\'s answer with --json', async () => {
    const h = harness([reply(200, SCOPES)]);
    h.signedIn();
    expect(await h.run(['apps', 'scopes']), h.err()).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^SCOPE\s+ALLOWS$/);
    expect(lines.some((line) => /^event:sale\s+Sale$/.test(line))).toBe(true);
    expect(lines.some((line) => /^records:programs:read\s+\S/.test(line))).toBe(true);
    expect(h.paths()).toEqual(['GET /apps/scopes']);

    const json = harness([reply(200, SCOPES)]);
    json.signedIn();
    expect(await json.run(['apps', 'scopes', '--json'])).toBe(0);
    expect(JSON.parse(json.out())).toEqual(SCOPES);
  });

  it('events: one line per event with its group and what it means, and Siren\'s answer with --json', async () => {
    const h = harness([reply(200, EVENTS)]);
    h.signedIn();
    expect(await h.run(['apps', 'events']), h.err()).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^EVENT\s+MEANS$/);
    expect(lines.some((line) => /^sale\.created\s+A sale was recorded$/.test(line))).toBe(true);
    expect(lines).toHaveLength(EVENTS.length + 1);

    const tty = harness([reply(200, EVENTS)]);
    tty.signedIn();
    expect(await runCli(['apps', 'events'], { ...tty.io, stdoutTty: true, env: { ...tty.io.env, TERM: 'xterm-256color' } })).toBe(0);
    for (const line of tty.out().split('\n')) expect(line.replace(/\u001b\[[\d;]*m/g, '').length).toBeLessThanOrEqual(80);

    const json = harness([reply(200, EVENTS)]);
    json.signedIn();
    expect(await json.run(['apps', 'events', '--json'])).toBe(0);
    expect(JSON.parse(json.out())).toEqual(EVENTS);
  });

  it('suggests apps scopes for apps scope', async () => {
    const h = harness([]);
    expect(await h.run(['apps', 'scope'])).toBe(2);
    expect(h.err()).toContain('"apps scopes"');
  });
});

describe('the schema offers the scopes and events in an editor', () => {
  const schema = JSON.parse(readFileSync(new URL('../siren.app.schema.json', import.meta.url), 'utf8')) as {
    definitions?: Record<string, unknown>;
    properties: { apps: { additionalProperties: { properties: Record<string, { items: { examples?: string[] } }> } } };
  };
  const app = schema.properties.apps.additionalProperties.properties;

  it('offers the scopes the SDK names, each one Siren issues, with every record, ledger and webhook scope among them', () => {
    const issued = Object.values(SCOPES).flat().map((entry) => entry.scope);
    const offered = app.scopes!.items.examples!;
    for (const scope of offered) expect(issued, scope).toContain(scope);
    for (const scope of issued.filter((one) => !one.startsWith('event:'))) expect(offered, scope).toContain(scope);
    expect(offered).toContain('event:sale');
  });

  it('offers every event Siren sends, and no other', () => {
    expect([...app.events!.items.examples!].sort()).toEqual(EVENTS.map((entry) => entry.event).sort());
  });
});
