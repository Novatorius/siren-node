import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { AppErrorCode, ConflictError, SirenError, UnexpectedResponseError, appErrorCode } from '../src/errors';
import { FeatureKind } from '../src/taxonomy';
import { AppsResource, RESERVED_APP_KEYS } from '../src/resources/apps';
import type { DeclareAppParams } from '../src/record-types';
import { FakeHttpClient, reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, pathOf, transportOver } from './record-fakes';
import { APP_KEY, PartAnswers, PlanFields, appRecord, itemPage, payoutKind } from './apps-siren-answers';

/*
 * Acceptance tests for slice C6 item 1, the apps resource as the container
 * of its key, its address and its features. Contract:
 * docs/architecture/apps-sdk-container.md, and Siren's
 * docs/architecture/apps-own-parts.md on `int/preview-apps` at a22547327.
 * The answers are Siren's, from test/apps-siren-answers.ts, which names the
 * Siren file and lines each copies.
 */

const KEY = APP_KEY;
const RAW_KEY = `sk_test_${'1b'.repeat(32)}`;
const SECRET = '9c'.repeat(32);
const app = appRecord();
const keyOnly = appRecord({ url: null, events: [], address: null, features: [] });

function apps(replies: Parameters<typeof transportOver>[0]) {
  const over = transportOver(replies);
  return { ...over, apps: new AppsResource(over.transport) };
}

async function refused(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the call answered instead of refusing');
}

describe('apps-sdk-container: declaring from a file', () => {
  it('declares a key-only app with no url, and answers its raw key with no signing secret', async () => {
    const { http, apps: resource } = apps([reply(201, { ...keyOnly, rawKey: RAW_KEY })]);
    const declared = await resource.declare(KEY, { name: 'Acme', scopes: ['records:programs:read'] });
    expect(bodyOf(http.requests[0])).toEqual({ name: 'Acme', scopes: ['records:programs:read'] });
    expect(declared.created).toBe(true);
    expect(declared).toMatchObject({ rawKey: RAW_KEY });
    expect(declared).not.toHaveProperty('signingSecret');
  });

  it('answers created: false with the signing secret when a later declaration adds the address', async () => {
    const { apps: resource } = apps([reply(200, { ...app, signingSecret: SECRET })]);
    const declared = await resource.declare(KEY, { name: 'Acme', url: 'https://acme.example/siren' });
    expect(declared.created).toBe(false);
    expect(declared.signingSecret).toBe(SECRET);
  });

  it('refuses the old payout kind, items in place of features, and a reserved key, before sending', async () => {
    const feature = { kind: FeatureKind.PayoutMethod, key: 'ledger', name: 'Ledger', currencies: ['USD'] };
    const cases: Array<[string, DeclareAppParams, RegExp]> = [
      [KEY, { name: 'Acme', url: 'https://acme.example', features: [{ ...feature, kind: 'fulfillmentMethod' as never }] }, /payoutMethod/],
      [KEY, { name: 'Acme', url: 'https://acme.example', items: [feature] } as never, /does not take items\. Siren calls an app's features "features" now\. Send them under features\./],
      ...RESERVED_APP_KEYS.map((reserved): [string, DeclareAppParams, RegExp] => [reserved, { name: 'Acme' }, /never requests, events, scopes, kinds/]),
    ];
    for (const [key, params, message] of cases) {
      const { http, apps: resource } = apps([reply(200, app)]);
      const error = await refused(() => resource.declare(key, params));
      expect(error, JSON.stringify([key, params])).toBeInstanceOf(SirenError);
      expect((error as Error).message).toMatch(message);
      expect(http.requests).toHaveLength(0);
    }
  });

  it('sends features with no url, since a sandbox takes them for siren listen and live refuses them', async () => {
    const { http, apps: resource } = apps([reply(200, app)]);
    await resource.declare(KEY, { name: 'Acme', features: [{ kind: FeatureKind.PayoutMethod, key: 'l', name: 'L', currencies: ['USD'] }] });
    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0])).not.toHaveProperty('url');
  });

  it('sends FeatureKind.PayoutMethod as payoutMethod, the value Siren stores, and has no old alias', async () => {
    expect(FeatureKind.PayoutMethod).toBe('payoutMethod');
    expect(Object.keys(FeatureKind)).not.toContain('FulfillmentMethod');
    const { http, apps: resource } = apps([reply(200, app)]);
    await resource.declare(KEY, { name: 'Acme', url: 'https://acme.example', features: [{ kind: FeatureKind.PayoutMethod, key: 'l', name: 'L', currencies: ['USD'] }] });
    expect((bodyOf(http.requests[0]) as { features: Array<{ kind: string }> }).features[0]?.kind).toBe('payoutMethod');
  });
});

describe('apps-sdk-container: the dashboard doors', () => {
  it('makes an app with POST /apps once, answering the secrets of the parts it made', async () => {
    const { http, apps: resource } = apps([reply(201, { ...app, source: 'dashboard', rawKey: RAW_KEY, signingSecret: SECRET })]);
    const made = await resource.create({ name: 'Acme Ledger', scopes: [], url: 'https://acme.example/siren', events: ['obligation.approved'] });
    expect(http.requests[0]?.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/apps');
    expect(bodyOf(http.requests[0])).toEqual({ name: 'Acme Ledger', scopes: [], url: 'https://acme.example/siren', events: ['obligation.approved'] });
    expect(made).toMatchObject({ source: 'dashboard', rawKey: RAW_KEY, signingSecret: SECRET });
    await expectSentOnce((transport) => new AppsResource(transport).create({ name: 'A', scopes: [] }), reply(201, { ...keyOnly, rawKey: RAW_KEY }));
  });

  it('refuses features, an unknown field and a missing name on create, before sending', async () => {
    for (const params of [
      { name: 'A', scopes: [], features: [] },
      { name: 'A', scopes: [], key: 'acme' },
      { scopes: [] },
    ]) {
      const { http, apps: resource } = apps([reply(201, app)]);
      const error = await refused(() => resource.create(params as never));
      expect(error, JSON.stringify(params)).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
    const { apps: resource } = apps([reply(201, app)]);
    expect(((await refused(() => resource.create({ name: 'A', features: [] } as never))) as Error).message).toContain('apps.features.create()');
  });

  it('changes only the fields sent with PATCH once, carries url: null, and refuses features before sending', async () => {
    const { http, apps: resource } = apps([reply(200, { ...app, description: 'Changed.' })]);
    expect((await resource.update(KEY, { description: 'Changed.', url: null })).description).toBe('Changed.');
    expect(http.requests[0]?.method).toBe('PATCH');
    expect(pathOf(http.requests[0])).toBe(`/apps/${KEY}`);
    expect(bodyOf(http.requests[0])).toEqual({ description: 'Changed.', url: null });
    await expectSentOnce((transport) => new AppsResource(transport).update(KEY, { name: 'B' }), reply(200, app));

    const bad = apps([reply(200, app)]);
    expect(await refused(() => bad.apps.update(KEY, { features: [] } as never))).toBeInstanceOf(SirenError);
    expect(bad.http.requests).toHaveLength(0);
  });
});

describe('apps-sdk-container: the key and the signing secret', () => {
  it('makes a key once with the scopes given, and answers its raw key', async () => {
    const { http, apps: resource } = apps([reply(201, { ...app, rawKey: RAW_KEY })]);
    expect((await resource.createKey(KEY, { scopes: ['records:programs:read'] })).rawKey).toBe(RAW_KEY);
    expect(http.requests[0]?.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe(`/apps/${KEY}/key`);
    expect(bodyOf(http.requests[0])).toEqual({ scopes: ['records:programs:read'] });
    await expectSentOnce((transport) => new AppsResource(transport).createKey(KEY), reply(201, { ...app, rawKey: RAW_KEY }));

    const exists = apps([PartAnswers.keyExists()]);
    const error = await refused(() => exists.apps.createKey(KEY));
    expect(error).toBeInstanceOf(ConflictError);
    expect(appErrorCode(error)).toBe(AppErrorCode.KeyExists);
  });

  it('rotates the key and the secret apart, each once, each answering only its own secret', async () => {
    const { http, apps: resource } = apps([reply(200, { ...app, rawKey: RAW_KEY }), reply(200, { ...app, signingSecret: SECRET })]);
    const key = await resource.rotateKey(KEY);
    const secret = await resource.rotateSecret(KEY);
    expect(http.requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      `POST /apps/${KEY}/key/rotate`,
      `POST /apps/${KEY}/secret/rotate`,
    ]);
    expect(key.rawKey).toBe(RAW_KEY);
    expect(secret.signingSecret).toBe(SECRET);
    await expectSentOnce((transport) => new AppsResource(transport).rotateKey(KEY), reply(200, { ...app, rawKey: RAW_KEY }));
    await expectSentOnce((transport) => new AppsResource(transport).rotateSecret(KEY), reply(200, { ...app, signingSecret: SECRET }));
    expect('rotate' in resource).toBe(false);
  });

  it('throws UnexpectedResponseError when a key or secret route answers without its secret', async () => {
    const runs: Array<(resource: AppsResource) => Promise<unknown>> = [
      (resource) => resource.createKey(KEY),
      (resource) => resource.rotateKey(KEY),
      (resource) => resource.rotateSecret(KEY),
    ];
    for (const run of runs) {
      const { apps: resource } = apps([reply(200, app)]);
      expect(await refused(() => run(resource)), run.toString()).toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it('revokes the key once with DELETE and answers the address-only app', async () => {
    const addressOnly = appRecord({ apiKey: null, apiKeyPrefix: null, scopes: [], features: [] });
    const { http, apps: resource } = apps([reply(200, addressOnly)]);
    expect((await resource.revokeKey(KEY)).apiKey).toBeNull();
    expect(http.requests[0]?.method).toBe('DELETE');
    expect(pathOf(http.requests[0])).toBe(`/apps/${KEY}/key`);
    await expectSentOnce((transport) => new AppsResource(transport).revokeKey(KEY), reply(200, addressOnly));
  });
});

describe('apps-sdk-container: the address', () => {
  it('sends a test once and reads the delivery log as a read', async () => {
    const result = { delivered: true, httpStatus: 200, error: null, eventType: 'webhook.test' };
    const { http, apps: resource } = apps([reply(200, result), reply(200, [])]);
    expect(await resource.test(KEY)).toEqual(result);
    expect(await resource.deliveries(KEY)).toEqual([]);
    expect(http.requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([`POST /apps/${KEY}/test`, `GET /apps/${KEY}/deliveries`]);
    await expectSentOnce((transport) => new AppsResource(transport).test(KEY), reply(200, result));
    await expectRetried((transport) => new AppsResource(transport).deliveries(KEY), reply(200, []));

    const odd = apps([reply(200, { sent: true }), reply(200, [1])]);
    expect(await refused(() => odd.apps.test(KEY))).toBeInstanceOf(UnexpectedResponseError);
    expect(await refused(() => odd.apps.deliveries(KEY))).toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('apps-sdk-container: one feature', () => {
  it('adds, reads, changes and removes one feature by its routes', async () => {
    const page = itemPage();
    const { http, apps: resource } = apps([
      reply(201, page),
      reply(200, page),
      reply(200, { ...page, name: 'Ledger' }),
      reply(200, { archived: true, feature: page }),
      reply(200, { archived: false, feature: null }),
    ]);
    const made = await resource.features.create(KEY, { kind: 'payoutMethod', key: 'acme-ledger', name: 'Acme ledger', currencies: ['USD'] });
    expect(made.usedBy).toEqual([{ record: 'autofulfiller', id: 'USD' }]);
    expect((await resource.features.retrieve(KEY, 12)).uses).toBe(1);
    expect((await resource.features.update(KEY, 12, { name: 'Ledger' })).name).toBe('Ledger');
    expect(await resource.features.delete(KEY, 12)).toEqual({ archived: true, feature: page });
    expect(await resource.features.delete(KEY, 12)).toEqual({ archived: false, feature: null });
    expect(http.requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      `POST /apps/${KEY}/features`,
      `GET /apps/${KEY}/features/12`,
      `PATCH /apps/${KEY}/features/12`,
      `DELETE /apps/${KEY}/features/12`,
      `DELETE /apps/${KEY}/features/12`,
    ]);
    expect(bodyOf(http.requests[2])).toEqual({ name: 'Ledger' });
    await expectSentOnce((transport) => new AppsResource(transport).features.create(KEY, { kind: 'payoutMethod', key: 'l', name: 'L', currencies: ['USD'] }), reply(201, page));
    await expectRetried((transport) => new AppsResource(transport).features.retrieve(KEY, 12), reply(200, page));
    await expectSentOnce((transport) => new AppsResource(transport).features.update(KEY, 12, { name: 'L' }), reply(200, page));
    await expectSentOnce((transport) => new AppsResource(transport).features.delete(KEY, 12), reply(200, { archived: false, feature: null }));
  });

  it('creates a feature with no key, sending no key field, so Siren makes it from the name (AP-R76)', async () => {
    for (const params of [
      { kind: 'postConversionAction' as const, name: 'Tell the CRM' },
      { kind: 'postConversionAction' as const, key: undefined, name: 'Tell the CRM' },
    ]) {
      const { http, apps: resource } = apps([reply(201, itemPage({ kind: 'postConversionAction', key: 'tell-the-crm-2', name: 'Tell the CRM' }))]);
      const made = await resource.features.create(KEY, params);
      expect(made.key).toBe('tell-the-crm-2');
      expect(http.requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([`POST /apps/${KEY}/features`]);
      expect(bodyOf(http.requests[0])).toEqual({ kind: 'postConversionAction', name: 'Tell the CRM' });
      expect(Object.keys(bodyOf(http.requests[0]) as object)).not.toContain('key');
    }
  });

  it("refuses a change to a feature's kind or key, the old payout kind, and a bad id, before sending", async () => {
    const runs: Array<[(resource: AppsResource) => Promise<unknown>, RegExp]> = [
      [(resource) => resource.features.update(KEY, 12, { kind: 'postConversionAction' } as never), /never change/],
      [(resource) => resource.features.update(KEY, 12, { key: 'other' } as never), /never change/],
      [(resource) => resource.features.create(KEY, { kind: 'fulfillmentMethod' as never, key: 'l', name: 'L' }), /payoutMethod/],
      [(resource) => resource.features.create(KEY, { kind: 'payoutMethod', key: 'l' } as never), /needs a name/],
      [(resource) => resource.features.retrieve(KEY, 0), /id/],
      [(resource) => resource.features.delete('kinds', 12), /never requests/],
    ];
    for (const [run, message] of runs) {
      const { http, apps: resource } = apps([reply(200, itemPage())]);
      const error = await refused(() => run(resource));
      expect(error, run.toString()).toBeInstanceOf(SirenError);
      expect((error as Error).message).toMatch(message);
      expect(http.requests).toHaveLength(0);
    }
  });

  it("raises Siren's refusal of a first feature on an app that lacks a part with its code and the part", async () => {
    const { apps: resource } = apps([PartAnswers.itemsNeedKeyAndAddress()]);
    const error = await refused(() => resource.features.create(KEY, { kind: 'postConversionAction', key: 'n', name: 'N' }));
    expect(error).toBeInstanceOf(ConflictError);
    expect(appErrorCode(error)).toBe(AppErrorCode.FeaturesNeedKeyAndAddress);
    expect((error as ConflictError).data).toMatchObject({ missing: ['address'] });
  });

  it('throws UnexpectedResponseError for a feature answer of the wrong shape', async () => {
    const { apps: resource } = apps([reply(201, { ok: true }), reply(200, { archived: 'yes', feature: null })]);
    expect(await refused(() => resource.features.create(KEY, { kind: 'postConversionAction', key: 'n', name: 'N' }))).toBeInstanceOf(UnexpectedResponseError);
    expect(await refused(() => resource.features.delete(KEY, 12))).toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('apps-sdk-container: the catalogs and the plan fields', () => {
  it('reads the events, scopes and kinds catalogs, each retried', async () => {
    const events = [{ event: 'obligation.approved', category: 'Obligations', label: 'An obligation was approved' }];
    const scopes = { 'records:programs': [{ scope: 'records:programs:read', resource: 'records:programs', action: 'read', label: 'Read programs' }] };
    const { http, apps: resource } = apps([reply(200, events), reply(200, scopes), reply(200, [payoutKind()])]);
    expect(await resource.events()).toEqual(events);
    expect(await resource.scopes()).toEqual(scopes);
    expect(await resource.kinds()).toEqual([payoutKind()]);
    expect(http.requests.map(pathOf)).toEqual(['/apps/events', '/apps/scopes', '/apps/kinds']);
    await expectRetried((transport) => new AppsResource(transport).events(), reply(200, events));
    await expectRetried((transport) => new AppsResource(transport).scopes(), reply(200, scopes));
    await expectRetried((transport) => new AppsResource(transport).kinds(), reply(200, [payoutKind()]));

    const odd = apps([reply(200, { events }), reply(200, { programs: 'read' }), reply(200, [{ term: 'x' }])]);
    expect(await refused(() => odd.apps.events())).toBeInstanceOf(UnexpectedResponseError);
    expect(await refused(() => odd.apps.scopes())).toBeInstanceOf(UnexpectedResponseError);
    expect(await refused(() => odd.apps.kinds())).toBeInstanceOf(UnexpectedResponseError);
  });

  it('reads an app and the kinds as Siren answers them on Plus: an outward feature and the events need Pro', async () => {
    const onPlus = appRecord({
      events: ['obligation.approved'],
      features: appRecord().features.map((feature) => ({ ...feature, ...PlanFields.needsPro() })),
      eventsAccess: PlanFields.needsPro(),
    });
    const http = new FakeHttpClient([reply(200, onPlus), reply(200, [payoutKind()])]);
    const siren = new Siren({ accessToken: 'session-token', baseUrl: 'https://siren.invalid/siren/v1', httpClient: http });
    const read = await siren.apps.retrieve(KEY);
    expect(read.features.map((feature) => [feature.kind, feature.entitled, feature.requiredCapability, feature.requiredPlan])).toEqual([
      ['postConversionAction', false, 'outbound-apps', 'pro'],
      ['payoutMethod', false, 'outbound-apps', 'pro'],
    ]);
    expect(read.eventsAccess).toEqual({ entitled: false, requiredCapability: 'outbound-apps', requiredPlan: 'pro' });
    expect(read.apiKey?.lastFour).toBe('0a0a');
    expect(read.address?.status).toBe('active');
    expect(read).not.toHaveProperty('webhookSubscriptionId');
    const [kind] = await siren.apps.kinds();
    expect([kind?.direction, kind?.entitled, kind?.requiredPlan]).toEqual(['out', false, 'pro']);
    expect(http.requests.map((request) => request.headers.Authorization ?? request.headers.authorization)).toEqual([
      'Bearer session-token',
      'Bearer session-token',
    ]);
  });
});
