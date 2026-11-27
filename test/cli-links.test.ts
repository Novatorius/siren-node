import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIST_PAGES, RECORD_PAGES, appOrigin, recordLink, recordPath, recordTypeOf, resourceTypeOf } from '../src/cli/links';
import { RESOURCE_COMMANDS } from '../src/cli/resources.generated';
import { runCli } from '../src/cli/run';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * Links into Siren's app, built from the one map in src/cli/links.ts, and
 * `siren open`. The route list is a copy of the routes in Siren's Cloud app
 * router. Its fixture says where it came from and how to refresh it.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/app-routes/cloud-app-routes.json', import.meta.url), 'utf8')) as { source: string; routes: string[] };
const APP = 'https://sandbox.sirenaffiliates.com';
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { env: { TZ: 'UTC' }, ...options });
  h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'uat-org' }) });
  return h;
};

/** True when the app's router has a route that `path` matches, reading `:name` as one segment. */
function routed(path: string): boolean {
  const given = path.split('?')[0]!.split('/').filter(Boolean);
  return fixture.routes.some((route) => {
    const parts = route.split('/').filter(Boolean);
    return parts.length === given.length && parts.every((part, at) => part.startsWith(':') || part === given[at]);
  });
}

describe("the map of record pages in Siren's app", () => {
  it("opens every record type on a route in the Cloud app's router", () => {
    expect(fixture.source).toContain('frontend/src/platform/saas/App.tsx');
    for (const type of [...Object.keys(RECORD_PAGES), ...Object.keys(LIST_PAGES)]) expect(routed(recordPath(type, '7')), `${type}: ${recordPath(type, '7')}`).toBe(true);
  });

  it('opens a record on its read-only view where the app has one, never its editor', () => {
    for (const type of ['collaborator', 'program', 'program_group', 'collaborator_group', 'distributor', 'condition_set']) expect(recordPath(type, 7)).toMatch(/\/7\/view$/);
    expect(recordPath('conversion', 5640)).toBe('/conversions/5640');
  });

  it('opens a payout on its fulfillment, and on the fulfillments list when it names none, since the app has no payout page', () => {
    expect(fixture.routes).not.toContain('/payouts/:id');
    expect(recordPath('payout', 613, { fulfillmentId: 39 })).toBe('/fulfillments/39');
    expect(recordPath('payout', 613, { fulfillmentId: null })).toBe('/fulfillments');
    expect(recordPath('application', 4)).toBe('/applications');
  });

  it('puts only a plain id in an address, and opens the list for anything else', () => {
    expect(recordPath('program', '7/../../evil')).toBe('/programs');
    expect(recordPath('conversion', 'NaN')).toBe('/conversions');
  });

  it('gives each generated resource with a page its record type', () => {
    const typed = RESOURCE_COMMANDS.filter((resource) => resource.ops.get !== undefined && resourceTypeOf(resource.name) !== undefined).map((resource) => resource.name);
    expect(typed.sort()).toEqual(['applications', 'collaborator-groups', 'collaborators', 'conversions', 'customers', 'distributors', 'engagements', 'fulfillments', 'obligations', 'payouts', 'program-groups', 'programs', 'transactions']);
    expect(recordTypeOf('collaborator-groups')).toBe('collaborator_group');
    expect(recordTypeOf('sale')).toBe('transaction');
    expect(recordTypeOf('webhook')).toBeUndefined();
  });

  it("finds Siren's app beside its API, with api. read as app., and SIREN_APP_URL wins", () => {
    expect(appOrigin('https://api.sirenaffiliates.com/siren/v1', {})).toBe('https://app.sirenaffiliates.com');
    expect(appOrigin(SANDBOX_BASE_URL, {})).toBe(APP);
    expect(appOrigin('https://siren-pr-1254-cloud.tunnel.novatori.us/siren/v1', {})).toBe('https://siren-pr-1254-cloud.tunnel.novatori.us');
    expect(appOrigin('https://api.example.com/siren/v1', { SIREN_APP_URL: 'https://dash.example.com/' })).toBe('https://dash.example.com');
    expect(recordLink(SANDBOX_BASE_URL, {}, 'acme two', 'program', 4)).toBe(`${APP}/programs/4/view?org=acme%20two`);
  });
});

describe('siren open', () => {
  it('prints the page and opens nothing through a pipe', async () => {
    const h = signedIn([]);
    expect(await h.run(['open', 'collaborator', '208']), h.err()).toBe(0);
    expect(h.out()).toBe(`${APP}/collaborators/208/view?org=uat-org\n`);
    expect(h.opened).toEqual([]);
    expect(h.paths()).toEqual([]);
  });

  it('opens the page in the browser when standard output is a terminal, and says so', async () => {
    const h = signedIn([]);
    expect(await runCli(['open', 'conversion:5640'], { ...h.io, stdoutTty: true }), h.err()).toBe(0);
    expect(h.opened).toEqual([`${APP}/conversions/5640?org=uat-org`]);
    expect(h.err()).toContain('Opened it in your browser.');
    const none = signedIn([], { opens: false });
    expect(await runCli(['open', 'program', '4'], { ...none.io, stdoutTty: true }), none.err()).toBe(0);
    expect(none.err()).toContain("Couldn't start a browser here");
  });

  it('reads a payout to open the fulfillment that holds it, and opens an application on the list', async () => {
    const h = signedIn([reply(200, { id: 613, fulfillmentId: 39, status: 'unpaid' })]);
    expect(await h.run(['open', 'payout', '613']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /payouts/613']);
    expect(h.out()).toBe(`${APP}/fulfillments/39?org=uat-org\n`);
    expect(h.err()).toContain('the fulfillment that holds payout 613');
    const list = signedIn([]);
    expect(await list.run(['open', 'applications']), list.err()).toBe(0);
    expect(list.out()).toBe(`${APP}/applications?org=uat-org\n`);
  });

  it('refuses a type with no page and an id that is not one, before sending', async () => {
    const h = signedIn([]);
    expect(await h.run(['open', 'webhook', '4'])).toBe(2);
    expect(h.err()).toContain('It takes collaborator, program');
    expect(await h.run(['open', 'collaborator'])).toBe(2);
    expect(await h.run(['open', 'collaborator', '../1'])).toBe(2);
    expect(h.paths()).toEqual([]);
  });
});

describe("a record view's page", () => {
  it('ends a payout view with its fulfillment, and adds url to its --json', async () => {
    const payout = { id: 613, status: 'unpaid', value: 21870, currency: 'EUR', collaboratorId: 208, fulfillmentId: 39 };
    const h = signedIn([reply(200, payout), reply(200, [])]);
    expect(await h.run(['payouts', 'get', '613']), h.err()).toBe(0);
    expect(h.out().trimEnd().split('\n').at(-1)).toBe(`${APP}/fulfillments/39?org=uat-org`);
    const json = signedIn([reply(200, payout)]);
    expect(await json.run(['payouts', 'get', '613', '--json']), json.err()).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ ...payout, url: `${APP}/fulfillments/39?org=uat-org` });
  });

  it('adds no page to a record the app has none for, such as a webhook', async () => {
    const h = signedIn([reply(200, { id: 4, url: 'https://hooks.example.com/siren', status: 'active' })]);
    expect(await h.run(['webhooks', 'get', '4', '--json']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ id: 4, url: 'https://hooks.example.com/siren', status: 'active' });
  });
});
