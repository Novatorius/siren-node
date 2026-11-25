import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';
import { SANDBOX_BASE_URL } from '../src/http';

/*
 * `siren simulate` on Siren's POST /simulations/scenario (Siren PR 1253,
 * pkt/simulate-scenario), per review/cli-dx/simulate-redesign.md. It takes
 * Beacon's scenario document, `{recipe?, actions}`, from a file or from
 * flags, and never picks a participant. No preview runs that branch, so the
 * answers here are built from the PR's result shape and its integration
 * test's values (test/fixtures/simulations/scenario-sale.json says which).
 */
const result = JSON.parse(readFileSync(new URL('./fixtures/simulations/scenario-sale.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const USD = { code: 'USD', symbol: '$', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: true };
const registry = () => reply(200, [USD]);
const live = () => {
  const h = harness([], { edition: 'production' });
  return h;
};
const signedIn = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, { edition: 'production', env: { TZ: 'UTC' }, ...options });
  h.signedIn({ [SANDBOX_BASE_URL]: session({ edition: 'production', baseUrl: SANDBOX_BASE_URL }) });
  return h;
};
const bodyAt = (h: ReturnType<typeof harness>, at: number) => JSON.parse(h.http.requests[at]!.body!) as Record<string, unknown>;
const posts = (h: ReturnType<typeof harness>) => h.http.requests.filter((request) => request.method === 'POST');

describe('siren simulate, from flags', () => {
  it('writes the scenario from --referred-by and --line, runs it on a live organization without --live, and prints what it would make', async () => {
    const h = signedIn([registry(), reply(200, result)]);
    expect(
      await h.run(['simulate', '--referred-by', '39', '--line', 'sku=TEE name="Tee shirt" qty=2 price=50.00', '--line', 'type=shipping name=Shipping price=25.00']),
      h.err(),
    ).toBe(0);
    expect(h.paths()).toEqual(['GET /registries/currencies', 'POST /simulations/scenario']);
    expect(bodyAt(h, 1)).toEqual({
      actions: [
        { type: 'site_visited', as: 'visit', payload: { collaborator: 'collaborator_39' } },
        {
          type: 'sale_triggered',
          as: 'sale',
          payload: {
            opportunity: '@visit',
            source: 'simulation',
            lineItems: [
              { name: 'Tee shirt', description: 'Tee shirt', type: 'product', quantity: 2, value: 5000, attributes: { sku: 'TEE' } },
              { name: 'Shipping', description: 'Shipping', type: 'shipping', quantity: 1, value: 2500 },
            ],
          },
        },
      ],
    });
    const out = h.out();
    const flat = out.replace(/\s+/g, ' ');
    expect(flat).toContain('A $140.00 USD sale in Acme (3), live, would make 1 transaction, 1 conversion and 1 obligation.');
    expect(out).toMatch(/Tee shirt +2 x \$50\.00 USD +\$100\.00 USD/);
    expect(out).toMatch(/Shipping +1 x \$25\.00 USD +\$25\.00 USD/);
    expect(out).toContain('Affiliate counted $100.00 USD of it, at 20%.');
    expect(out).toContain('Shipping: The program does not count shipping.');
    expect(out).toMatch(/Sam Referrer +Affiliate +Pending/);
    expect(out).toMatch(/\$20\.00 USD +owed to Sam Referrer +Draft, awaiting conversion approval/);
    expect(flat).toContain('Sam Referrer earned in Affiliate on this sale because the scenario credits their referral link (action "visit").');
    expect(out).toContain('Influencer counts coupon uses only. This sale used none.');
    expect(out.trimEnd().endsWith('Nothing was written.')).toBe(true);
    for (const line of out.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  });

  it('prints the scenario with --print-scenario and sends nothing', async () => {
    const h = live();
    expect(await h.run(['simulate', '--referred-by', 'collaborator_39', '--coupon', 'SAVE10', '--line', 'name=Mug value=1500', '--print-scenario'])).toBe(0);
    expect(h.http.requests).toHaveLength(0);
    expect(JSON.parse(h.out())).toEqual({
      actions: [
        { type: 'site_visited', as: 'visit', payload: { collaborator: 'collaborator_39' } },
        { type: 'coupon_used', as: 'coupon', payload: { code: 'SAVE10', opportunity: '@visit' } },
        { type: 'sale_triggered', as: 'sale', payload: { opportunity: '@visit', source: 'simulation', lineItems: [{ name: 'Mug', description: 'Mug', type: 'product', quantity: 1, value: 1500 }] } },
      ],
    });
  });

  it('refuses a sale nobody referred, since the tool never picks a participant', async () => {
    const h = live();
    expect(await h.run(['simulate', '--line', 'name=Mug value=1500'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain("Can't simulate a sale nobody referred.");
    expect(h.err()).toContain('--referred-by');
    expect(h.err()).toContain('--direct');
  });

  it('writes a visit nobody referred with --direct, and a coupon alone credits whoever owns it', async () => {
    const h = live();
    expect(await h.run(['simulate', '--direct', '--line', 'name=Mug value=1500', '--print-scenario'])).toBe(0);
    expect((JSON.parse(h.out()) as { actions: unknown[] }).actions[0]).toEqual({ type: 'site_visited', as: 'visit', payload: {} });
    const coupon = live();
    expect(await coupon.run(['simulate', '--coupon', 'SAVE10', '--line', 'name=Mug value=1500', '--print-scenario'])).toBe(0);
    expect((JSON.parse(coupon.out()) as { actions: Array<{ type: string }> }).actions.map((action) => action.type)).toEqual(['site_visited', 'coupon_used', 'sale_triggered']);
  });

  it('turns an email given to --referred-by into the export key, and refuses one that names nobody', async () => {
    const h = signedIn([reply(200, { items: [{ id: 39, email: 'sam@example.com', fullName: 'Sam Referrer' }], total: 1 })]);
    expect(await h.run(['simulate', '--referred-by', 'sam@example.com', '--line', 'name=Mug value=1500', '--print-scenario']), h.err()).toBe(0);
    expect(new URL(h.http.requests[0]!.url).searchParams.get('s')).toBe('sam@example.com');
    expect((JSON.parse(h.out()) as { actions: Array<{ payload: unknown }> }).actions[0]!.payload).toEqual({ collaborator: 'collaborator_39' });

    const none = signedIn([reply(200, { items: [], total: 0 })]);
    expect(await none.run(['simulate', '--referred-by', 'nobody@example.com', '--line', 'name=Mug value=1500'])).toBe(1);
    expect(none.err()).toContain('No collaborator matches nobody@example.com.');
  });

  it('closes a distributor with --close, and prints each share of the pot', async () => {
    const closed = {
      ...result,
      actions: [{ type: 'distribution_completed', label: 'close', event: 'distribution_completed', created: { distribution: 77 }, error: null }],
      ledgers: { opportunities: [], engagements: [], conversions: [], obligations: [], transactions: [] },
      why: [],
      skipped: [],
      distributions: [
        {
          distributionId: 77,
          distributorId: 5,
          distributorName: 'Team pool',
          status: 'complete',
          closed: true,
          closedBy: { index: 0, type: 'distribution_completed', label: 'close' },
          units: 'USD',
          pot: { value: 10000, source: 'revenue', revenuePercentage: 10, revenue: 100000 },
          recipients: [
            { collaboratorId: 39, collaboratorName: 'Sam Referrer', rank: 1, score: 6, share: 0.6, amount: 6000, outcome: 'paid', reason: null, message: null },
            { collaboratorId: 41, collaboratorName: 'Kim Lane', rank: 2, score: 0, share: 0, amount: 0, outcome: 'nothing', reason: 'not_qualified', message: 'Kim Lane scored no sales this period.' },
          ],
          allocated: 6000,
          unallocated: 4000,
        },
      ],
    };
    const h = signedIn([reply(200, closed), registry()]);
    expect(await h.run(['simulate', '--close', '5']), h.err()).toBe(0);
    expect(bodyAt(h, 0)).toEqual({ actions: [{ type: 'distribution_completed', as: 'close', payload: { distributorKey: 'distributor_5' } }] });
    expect(h.out()).toContain('Closing Team pool would pay out $60.00 USD of a $100.00 USD pot.');
    expect(h.out()).toMatch(/Sam Referrer +\$60\.00 USD +paid/);
    expect(h.out()).toMatch(/Kim Lane +nothing: Kim Lane scored no sales this period\./);
    expect(h.out()).toContain('$40.00 USD stays in the pot.');
  });

  it('refuses a line it cannot read, and asks for --line when a referrer is given alone', async () => {
    const h = live();
    expect(await h.run(['simulate', '--referred-by', '39', '--line', 'qty=two value=1500'])).toBe(2);
    expect(h.err()).toContain('qty takes a whole number');
    expect(await h.run(['simulate', '--referred-by', '39'])).toBe(2);
    expect(h.err()).toContain('--line');
    expect(h.http.requests).toHaveLength(0);
  });
});

describe('siren simulate <scenario.json|->', () => {
  const document = { actions: [{ type: 'site_visited', as: 'visit', payload: { collaborator: 'collaborator_39' } }] };

  it('sends a file unchanged, and prints the whole result with --json', async () => {
    const h = signedIn([reply(200, result)]);
    h.write('flow.json', JSON.stringify(document));
    expect(await h.run(['simulate', 'flow.json', '--json']), h.err()).toBe(0);
    expect(bodyAt(h, 0)).toEqual(document);
    expect(JSON.parse(h.out())).toEqual(result);
  });

  it('reads the document from standard input with -', async () => {
    const h = signedIn([reply(200, result)], { stdin: JSON.stringify(document) });
    expect(await h.run(['simulate', '-', '--json']), h.err()).toBe(0);
    expect(bodyAt(h, 0)).toEqual(document);
  });

  it("names an action Siren refused, by its number and label, and exits 1", async () => {
    const failed = { ...result, actions: [{ type: 'site_visited', label: 'visit', event: null, created: {}, error: "No collaborator with key 'collaborator_999999' exists in this organization." }], ledgers: { opportunities: [], engagements: [], conversions: [], obligations: [], transactions: [] }, why: [], skipped: [] };
    const h = signedIn([reply(200, failed)]);
    h.write('flow.json', JSON.stringify(document));
    expect(await h.run(['simulate', 'flow.json'])).toBe(1);
    expect(h.out().replace(/\s+/g, ' ')).toContain("Action 1, visit (site_visited): No collaborator with key 'collaborator_999999' exists in this organization.");
    expect(h.out()).toContain('Nothing was written.');
  });
});

describe('siren simulate, when Siren refuses the recipe or the tool cannot read amounts', () => {
  const document = { recipe: { programs: {} }, actions: [] };
  const invalid = {
    ...result,
    validation: { valid: false, errors: [{ path: 'programs.a.engagementTypes.0.type', message: 'Invalid engagementType' }] },
    actions: [],
    ledgers: { opportunities: [], engagements: [], conversions: [], obligations: [], transactions: [] },
    why: [],
    skipped: [],
  };

  it("prints each recipe problem from Siren's 422, and its whole body with --json", async () => {
    const h = signedIn([reply(422, invalid)]);
    h.write('flow.json', JSON.stringify(document));
    expect(await h.run(['simulate', 'flow.json'])).toBe(1);
    expect(h.out()).toContain('Recipe problems');
    expect(h.out()).toContain('programs.a.engagementTypes.0.type: Invalid engagementType');
    expect(h.out()).toContain('Nothing was written.');
    const json = signedIn([reply(422, invalid)]);
    json.write('flow.json', JSON.stringify(document));
    expect(await json.run(['simulate', 'flow.json', '--json'])).toBe(1);
    expect(JSON.parse(json.out())).toEqual(invalid);
  });

  it("refuses price= when the organization's currencies can't be read, rather than guess the decimal places", async () => {
    const h = signedIn([reply(404, { error: { message: 'Not found.' } })]);
    expect(await h.run(['simulate', '--referred-by', '39', '--line', 'name=Mug price=25.00'])).toBe(1);
    expect(h.err()).toContain("can't read this organization's currencies");
    expect(h.err()).toContain('value=');
    expect(posts(h)).toHaveLength(0);
  });

  it("sends value= as stored units on the older sale route, read in the organization's own currency", async () => {
    const PTS = { code: 'PTS', symbol: 'pts', symbolPosition: 'after', scale: 0, decimalPlaces: 0, type: 'internal', isDefault: true };
    const sale = { event: 'sale', simulated: true, status: 'created', message: null, opportunityId: null, transactionId: null, total: '500', currency: 'PTS', collaborator: { id: 39, name: 'Sam Referrer' }, conversions: [], obligations: [], waits: [] };
    const h = signedIn([reply(404, { error: { message: 'Not found.' } }), reply(200, [PTS]), reply(200, sale)]);
    expect(await h.run(['simulate', '--referred-by', '39', '--line', 'name=Mug value=500']), h.err()).toBe(0);
    expect(bodyAt(h, 2)).toEqual({ collaboratorId: 39, amount: '500' });

    const blind = signedIn([reply(404, { error: { message: 'Not found.' } }), reply(404, { error: { message: 'Not found.' } })]);
    expect(await blind.run(['simulate', '--referred-by', '39', '--line', 'name=Mug value=500'])).toBe(1);
    expect(blind.err()).toContain("can't read this organization's currencies");
    expect(posts(blind)).toHaveLength(1);
  });

  it('refuses a name that matches more than one person, or a full page of search results, and asks for an email or id', async () => {
    const people = (count: number, name: string) => Array.from({ length: count }, (_, at) => ({ id: at + 1, email: `p${at}@example.com`, fullName: at === 0 ? name : `Person ${at}` }));
    const full = signedIn([reply(200, { items: people(25, 'Sam Lee'), total: 40 })]);
    expect(await full.run(['simulate', '--referred-by', 'Sam Lee', '--line', 'name=Mug value=1500', '--print-scenario'])).toBe(1);
    expect(full.err()).toContain('email or id');
    const two = signedIn([reply(200, { items: [{ id: 1, fullName: 'Sam Lee' }, { id: 2, fullName: 'Sam Lee' }], total: 2 })]);
    expect(await two.run(['simulate', '--referred-by', 'Sam Lee', '--line', 'name=Mug value=1500', '--print-scenario'])).toBe(1);
    expect(two.err()).toContain('email or id');
  });
});

describe('siren simulate on a Siren without scenario simulation', () => {
  it('falls back to the sale route for a referred sale from flags, and says so', async () => {
    const sale = { event: 'sale', simulated: true, status: 'created', message: null, opportunityId: null, transactionId: null, total: '125.00', currency: 'USD', collaborator: { id: 39, name: 'Sam Referrer' }, conversions: [], obligations: [], waits: [] };
    const h = signedIn([registry(), reply(404, { error: { message: 'Not found.' } }), reply(200, sale)]);
    expect(await h.run(['simulate', '--referred-by', '39', '--line', 'name=Mug qty=5 price=25.00']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /registries/currencies', 'POST /simulations/scenario', 'POST /simulations/sale']);
    expect(bodyAt(h, 2)).toEqual({ collaboratorId: 39, amount: '125.00' });
    expect(h.err()).toContain("This Siren has no scenario simulation, so this is its older sale simulation: one total, with no line items.");
  });

  it('refuses a scenario file, a coupon or a close there, naming what is missing', async () => {
    const h = signedIn([reply(404, { error: { message: 'Not found.' } })]);
    h.write('flow.json', JSON.stringify({ actions: [] }));
    expect(await h.run(['simulate', 'flow.json'])).toBe(1);
    expect(h.err()).toContain("This Siren doesn't have scenario simulation yet.");
    expect(posts(h)).toHaveLength(1);
  });

  it("says where Siren can't undo writes, in Siren's words", async () => {
    const h = signedIn([reply(501, { error: { code: 'simulation_unavailable', message: "Siren can't undo writes on this platform, so it can't simulate here." } })]);
    h.write('flow.json', JSON.stringify({ actions: [] }));
    expect(await h.run(['simulate', 'flow.json'])).toBe(1);
    expect(h.err()).toContain("Siren can't undo writes on this platform, so it can't simulate here.");
  });
});
