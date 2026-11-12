import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditsResource,
  CustomCurrenciesResource,
  DistributorsResource,
  EngagementsResource,
  MappingsResource,
  OpportunitiesResource,
  SettingsResource,
  Siren,
} from '../src/index';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';
import { BASE, page, pathOf } from './record-fakes';

/*
 * Slice 4 acceptance tests for packet P10: the Siren client carries the
 * slice 4 resources. Slice 5 edits src/client.ts, and slice 3's P10 adds
 * its own fields there, so this P10 starts only after both merge.
 *
 * Every client here gets a FakeHttpClient, the reserved base URL
 * https://example.invalid, and a global fetch that fails the test when
 * called, so nothing leaves the machine.
 *
 * The fields are read with Reflect.get so this file compiles before P10 adds
 * them to the Siren class.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P10 implementer turns each into `it` and deletes this
 * paragraph.
 */

beforeEach(failOnGlobalFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function client(http: FakeHttpClient): Siren {
  return new Siren({ apiKey: TEST_API_KEY, httpClient: http, baseUrl: BASE });
}

describe('P10: the Siren client carries the slice 4 resources', () => {
  it.skip.each([
    ['opportunities', OpportunitiesResource],
    ['engagements', EngagementsResource],
    ['distributors', DistributorsResource],
    ['customCurrencies', CustomCurrenciesResource],
    ['credits', CreditsResource],
    ['mappings', MappingsResource],
    ['settings', SettingsResource],
  ] as const)('siren.%s is its resource', (field, type) => {
    expect(Reflect.get(client(new FakeHttpClient([reply(200, {})])), field)).toBeInstanceOf(type);
  });

  it.skip('sends a read from every slice 4 resource through the client the caller gave, with its key', async () => {
    const http = new FakeHttpClient([reply(200, page([]))]);
    const siren = client(http);

    await (Reflect.get(siren, 'opportunities') as OpportunitiesResource).list();
    await (Reflect.get(siren, 'engagements') as EngagementsResource).list();
    await (Reflect.get(siren, 'distributors') as DistributorsResource).list();
    await (Reflect.get(siren, 'customCurrencies') as CustomCurrenciesResource).list();
    await (Reflect.get(siren, 'credits') as CreditsResource).entries({ collaboratorId: 4 });
    await (Reflect.get(siren, 'mappings') as MappingsResource).list({ externalType: 'wordpress_user' });
    await (Reflect.get(siren, 'settings') as SettingsResource).collaborator();

    expect(http.requests.map((request) => pathOf(request))).toEqual([
      '/opportunities',
      '/engagements',
      '/distributors',
      '/currencies/custom',
      '/credit-entries',
      '/mappings',
      '/configs',
    ]);
    for (const request of http.requests) {
      expect(new URL(request.url).origin).toBe(new URL(BASE).origin);
      expect(request.headers['Authorization']).toBe(`Bearer ${TEST_API_KEY}`);
    }
  });

  it.skip('keeps one instance of each resource per client', () => {
    const siren = client(new FakeHttpClient([reply(200, {})]));

    for (const field of ['opportunities', 'engagements', 'distributors', 'customCurrencies', 'credits', 'mappings', 'settings']) {
      expect(Reflect.get(siren, field), field).toBe(Reflect.get(siren, field));
      expect(Reflect.get(siren, field), field).toBeDefined();
    }
  });
});
