import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index';
import { Siren } from '../src/client';
import { AppHandlerError } from '../src/errors';
import { appRequestFromRecord } from '../src/testing';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * The pass 4 re-check, folded in (review/sdk-dx/pass-4-recheck-fold-spec.md),
 * with the dead methods removed (pass-4-followups-spec.md section 3).
 *
 * Siren feat/apps at d1661413a3 serves no `/api-keys` route in any form and
 * no `POST /webhooks`. Keys moved to `POST /apps/{key}/key`,
 * `POST /apps/{key}/key/rotate` and `DELETE /apps/{key}/key`
 * (AddAppApiKey.php, RotateAppApiKey.php, RevokeAppApiKey.php), and the
 * scope list to `GET /apps/scopes` (ListAppScopes.php), which answers
 * ApiKeyScopePolicy::issuableGroups() as the old scope list did. The
 * `webhook-subscriptions:*` scopes are retired: ApiKeyRecordScopes.php keeps
 * their names for older keys and leaves them out of DEFINITIONS.
 */

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const CHANGELOG = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const OPENAPI = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
const SECRET = 'a-secret-for-the-pass-4-fold';

/** The text under `heading`, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no "${heading}"`);
  const level = heading.split(' ')[0]!.length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ');

/** Every `answers.on(...)` registration in the README's code, as its text. */
function handlerSamples(): string[] {
  const blocks = [...README.matchAll(/```(?:js|ts|javascript|typescript)\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const samples: string[] = [];
  for (const block of blocks) {
    let from = 0;
    for (;;) {
      const start = block.indexOf('answers.on(', from);
      if (start === -1) break;
      let depth = 0;
      let quote: string | undefined;
      let end = start + 'answers.on'.length;
      for (; end < block.length; end += 1) {
        const char = block[end]!;
        if (quote !== undefined) {
          if (char === '\\') end += 1;
          else if (char === quote) quote = undefined;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) break;
      }
      samples.push(block.slice(start, end + 1));
      from = end + 1;
    }
  }
  return samples;
}

/*
 * The functions a README handler sample may call. A write records something,
 * calls another system or pays, so the sample must read `test` first and
 * return before it. A read-only one does none of those. A sample that calls
 * a function on neither list fails until someone puts it on one.
 */
const WRITES = ['addToCrm', 'noteShare', 'payOnce'];
const READ_ONLY = ['Number', 'String', 'Boolean', 'isRefunded', 'isStaff'];
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'async', 'await', 'typeof', 'function']);

describe('must 1: README samples that write check test first', () => {
  const samples = handlerSamples();

  it('finds the handler samples, the CRM tell among them', () => {
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.some((sample) => sample.includes('addToCrm('))).toBe(true);
  });

  it('knows every function a handler sample calls', () => {
    for (const sample of samples) {
      const calls = [...sample.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!);
      for (const name of calls) {
        if (NOT_CALLS.has(name)) continue;
        expect(WRITES.includes(name) || READ_ONLY.includes(name), `${name}() in:\n${sample}`).toBe(true);
      }
    }
  });

  it('returns on a test request before each write', () => {
    let writing = 0;
    for (const sample of samples) {
      const first = Math.min(...WRITES.map((name) => sample.search(new RegExp(`(?<![.\\w$])${name}\\s*\\(`))).filter((at) => at >= 0));
      if (!Number.isFinite(first)) continue;
      writing += 1;
      expect(sample.slice(0, first), sample).toMatch(/if \((request\.)?test\) return\b/);
    }
    expect(writing).toBeGreaterThanOrEqual(4);
  });

  it('names test beside isAsk in the request fields', () => {
    const paragraph = README.split(/\n\s*\n/).find((text) => text.includes('Every request has `isAsk`'));
    expect(paragraph).toBeDefined();
    expect(paragraph!).toMatch(/`isAsk`[^.]*`test`|`test`[^.]*`isAsk`/);
  });
});

describe('must 2: Develop on your machine works on the first run', () => {
  const develop = oneLine(section(README, '## Develop on your machine'));

  it('says nothing reads .env.sandbox by itself', () => {
    expect(oneLine(README)).not.toMatch(/\.env\.sandbox`?, which the handler reads/);
    expect(develop).toMatch(/Nothing reads `\.env\.sandbox` by itself/);
  });

  it('takes the key from apply, the secret from listen, and loads the file when the app starts', () => {
    const apply = develop.indexOf('siren apps apply');
    const listen = develop.indexOf('siren listen --forward-to localhost:3000/siren');
    const start = develop.indexOf('node --env-file=.env.sandbox app.js');
    const trigger = develop.indexOf('siren trigger ask <app> <feature>');
    expect([apply, listen, start, trigger].every((at) => at >= 0), develop).toBe(true);
    expect(apply).toBeLessThan(listen);
    expect(listen).toBeLessThan(start);
    expect(start).toBeLessThan(trigger);
    expect(develop).toContain('SIREN_API_KEY');
    expect(develop).toContain('SIREN_SIGNING_SECRET');
    expect(develop).toMatch(/own terminal/);
    expect(develop).toMatch(/[Rr]estart the app whenever listen says it saved a new secret/);
  });

  it('says what trigger does on a live Siren, and that the url-less apply comes with the next CLI release', () => {
    expect(develop).toMatch(/`--live` and a yes, and it refuses a payout method/);
    expect(develop).toMatch(/next release[^.]*`siren apps apply`[^.]*no `url`|no `url`[^.]*next release/);
  });

  it('says it in the Test requests section too', () => {
    expect(oneLine(section(README, '### Test requests'))).toMatch(/`--live` and a yes, and it refuses a payout method/);
  });
});

describe('should 1: replay reads a saved request', () => {
  const replay = oneLine(section(README, '### Replay a stored request'));

  it('saves it with the command-line tool and reads the file', () => {
    expect(replay).toContain('siren apps requests <id> --json > request.json');
    // This package ships --json on apps requests, so the README no longer calls it a next-release flag (SDK pass 5).
    expect(replay).not.toMatch(/next CLI release/);
    expect(replay).toContain("readFileSync('request.json'");
    expect(replay).not.toContain('apps.requests.retrieve(');
  });

  it('throws AppHandlerError for a stored request with no feature key', () => {
    const record = { id: 'apr_9f2c4e0b7a1d4c3e8b6f5a2d1c0e9b8a', kind: 'distributionResolver', mode: 'ask', feature: 'app:12', data: {} };
    expect(() => appRequestFromRecord(record, { secret: SECRET })).toThrow(AppHandlerError);
    expect(() => appRequestFromRecord(JSON.stringify(record), { secret: SECRET })).toThrow(/siren apps show <app>/);
  });
});

/*
 * `siren apps requests <id> --json` on pkt/apps-cli-dx at 9645ffb
 * (src/cli/commands/requests.ts, printRequestJson) prints Siren's request
 * detail as it came, plus `appKey` and `featureKey`, both null when the app
 * is gone, and `sends`. The fixture is that shape.
 */
describe('should 1: the replay helper reads what requests --json saves', () => {
  const saved = readFileSync(new URL('./fixtures/apps-cli/request-json.json', import.meta.url), 'utf8');
  const body = (request: { rawBody: string }) => JSON.parse(request.rawBody) as Record<string, unknown>;

  it('takes the feature key and app key from the saved file, as an object or its text', () => {
    for (const record of [saved, JSON.parse(saved) as unknown]) {
      const sent = body(appRequestFromRecord(record, { secret: SECRET }));
      expect(sent.id).toBe('apr_9f2c4e0b7a1d4c3e8b6f5a2d1c0e9b8a');
      expect(sent.app).toBe('acme-split');
      expect(sent.feature).toEqual({ kind: 'distributionResolver', key: 'split-by-score', id: 'app:12' });
      expect(sent.answerBy).toBe('2026-11-20T15:00:00+00:00');
      expect('test' in sent).toBe(false);
      expect(sent.data).toEqual((JSON.parse(saved) as { data: unknown }).data);
    }
  });

  it('falls back to { key } when the app is gone, and says so when it is missing', () => {
    const gone = { ...(JSON.parse(saved) as Record<string, unknown>), appKey: null, featureKey: null, sends: [] };
    expect(body(appRequestFromRecord(gone, { secret: SECRET, key: 'split-by-score' })).feature).toEqual({
      kind: 'distributionResolver',
      key: 'split-by-score',
      id: 'app:12',
    });
    expect(() => appRequestFromRecord(gone, { secret: SECRET })).toThrow(AppHandlerError);
    expect(() => appRequestFromRecord(gone, { secret: SECRET })).toThrow(/featureKey is null/);
  });

  it('replays it through simulate() as the README shows', async () => {
    const siren = new Siren({ accessToken: 't', baseUrl: BASE, httpClient: new FakeHttpClient([]), maxRetries: 0 });
    const answers = siren.apps.requestHandler({ signingSecret: SECRET });
    answers.on('distributionResolver', 'split-by-score', ({ data }) => ({
      outcome: 'allocated',
      units: data.pool.units,
      shares: siren.apps.splitPool(data.pool, data.metrics.map((metric) => [metric.metricId, metric.score])),
    }));
    const { answer, error } = await answers.simulate(appRequestFromRecord(saved, { secret: SECRET, baseUrl: BASE }));
    expect(error).toBeNull();
    expect(answer).toEqual({ outcome: 'allocated', units: 'USD', shares: { 41: 6000, 43: 4000 } });
  });
});

describe('the dead methods are gone', () => {
  const client = () => {
    const http = new FakeHttpClient([reply(200, { key: 'acme', rawKey: 'sk_test_0123456789abcdef' })]);
    return { http, siren: new Siren({ accessToken: 't', baseUrl: BASE, httpClient: http, maxRetries: 0 }) };
  };

  it('has no apiKeys resource and no webhooks.subscriptions.create()', () => {
    const { siren } = client();
    expect('apiKeys' in siren).toBe(false);
    expect('create' in siren.webhooks.subscriptions).toBe(false);
    expect('ApiKeysResource' in sdk).toBe(false);
  });

  it('drops the retired webhook scopes from both scope lists', () => {
    expect(Object.values(sdk.ApiKeyScope)).not.toContain('webhook-subscriptions:read');
    expect(Object.values(sdk.ApiKeyScope)).not.toContain('webhook-subscriptions:manage');
    expect(Object.values(sdk.ApiKeyRecordScope)).not.toContain('webhook-subscriptions:read');
    expect(Object.values(sdk.ApiKeyRecordScope)).not.toContain('webhook-subscriptions:manage');
    expect(sdk.API_KEY_RECORD_SCOPES.some((scope) => scope.startsWith('webhook-subscriptions:'))).toBe(false);
  });

  it('drops the types only the removed calls used', () => {
    const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    for (const name of ['ApiKey', 'CreatedApiKey', 'CreateApiKeyParams', 'CreatedWebhookSubscription', 'CreateWebhookSubscriptionParams']) {
      expect(types, name).not.toMatch(new RegExp(`export interface ${name}\\b`));
      expect(index, name).not.toMatch(new RegExp(`\\b${name},`));
    }
  });

  it('sends each app key call and the scope list to its route', async () => {
    const runs: Array<[string, (siren: Siren) => Promise<unknown>]> = [
      ['POST /apps/acme/key', (siren) => siren.apps.createKey('acme')],
      ['POST /apps/acme/key/rotate', (siren) => siren.apps.rotateKey('acme')],
      ['DELETE /apps/acme/key', (siren) => siren.apps.revokeKey('acme')],
    ];
    for (const [route, run] of runs) {
      const { http, siren } = client();
      await run(siren).catch(() => undefined);
      expect(http.requests.map((request) => `${request.method} ${new URL(request.url).pathname.replace('/siren/v1', '')}`)).toEqual([route]);
    }
  });

  it("reads GET /apps/scopes as Siren's ApiKeyScopePolicy::issuableGroups() answers it", async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/api-key-scopes.json', import.meta.url), 'utf8')) as {
      _source: string;
      body: Record<string, unknown[]>;
    };
    expect(fixture._source).toContain('GET /apps/scopes');
    expect(Object.keys(fixture.body)).not.toContain('webhook-subscriptions');
    const http = new FakeHttpClient([reply(200, fixture.body)]);
    const siren = new Siren({ accessToken: 't', baseUrl: BASE, httpClient: http, maxRetries: 0 });
    expect(await siren.apps.scopes()).toEqual(fixture.body);
    expect(http.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['GET /siren/v1/apps/scopes']);
  });

  it('drops the removed operations from openapi.yaml', () => {
    expect(OPENAPI).not.toMatch(/^ {2}\/api-keys/m);
    for (const id of ['createWebhookSubscription', 'createApiKey', 'listApiKeys', 'listApiKeyScopes', 'revokeApiKey']) {
      expect(OPENAPI, id).not.toContain(`operationId: ${id}`);
    }
    expect(OPENAPI).not.toContain('GET /api-keys/scopes');
  });

  it('names what replaces them in the Unreleased Breaking notes', () => {
    const unreleased = section(CHANGELOG, '## [Unreleased]');
    const breaking = oneLine(section(unreleased, '### Breaking'));
    const line = breaking.split(/ - /).find((item) => item.includes('`siren.apiKeys`'));
    expect(line, breaking).toBeDefined();
    for (const name of [
      'webhooks.subscriptions.create()',
      'apps.declare()',
      'siren apps apply',
      'apps.createKey()',
      'apps.rotateKey()',
      'apps.revokeKey()',
      'siren apps rotate-key',
      'apps.scopes()',
      'apps.update()',
    ]) {
      expect(line!, name).toContain(name);
    }
  });
});
