import { describe, expect, it } from 'vitest';
import { reply } from './http-fakes';
import { BASE, bodyOf } from './record-fakes';
import { harness, session } from './cli-fakes';
import { SANDBOX_BASE_URL } from '../src/http';
import { requestRow } from './apps-siren-answers';

/*
 * `siren trigger`, `trigger ask`, `apps test`, `fixtures` and `simulate`.
 * Contract: contract/devtools-trigger.md in the run folder, section 4. The
 * Siren routes they call are POST /test-activity, GET
 * /test-activity/sales/{id}, POST /simulations/sale and POST
 * /apps/{key}/features/{feature}/test, on Siren's pkt/devtools-trigger.
 */

const REQUEST = 'apr_9c60190a4501399d0ae55f041c237b39';

/** What POST /test-activity answers for a sale, as TestActivityResult::toArray() builds it. */
function sale(overrides: Record<string, unknown> = {}) {
  return {
    event: 'sale',
    simulated: false,
    status: 'created',
    message: 'The sale was recorded.',
    opportunityId: 615,
    transactionId: 3307,
    total: { value: 4999, units: 'USD' },
    collaborator: { id: 42, name: 'Sam Lee' },
    conversions: [
      { id: 1042, type: 'sale', status: 'pending', programId: 3, programName: 'Partner program', collaboratorId: 42, collaboratorName: 'Sam Lee', obligationId: 2210, waitsOn: null },
    ],
    obligations: [{ id: 2210, collaboratorId: 42, collaboratorName: 'Sam Lee', programId: 3, value: 750, units: 'USD', status: 'pending', holdReason: null }],
    waits: [],
    ...overrides,
  };
}

const wait = (status: string) => ({
  requestKey: REQUEST,
  app: 'acme-crm',
  appName: 'Acme CRM',
  feature: 'split-the-pool',
  featureName: 'Split the pool',
  kind: 'metricFilter',
  status,
  programId: 3,
});

/** What GET /apps/{key} answers, Siren listing the features as `items`. */
function app(items: Array<{ key: string; kind: string }>) {
  return { key: 'acme-crm', name: 'Acme CRM', items };
}

function live() {
  return { [BASE]: session({ edition: 'production', baseUrl: BASE }) };
}

describe('siren trigger <event>', () => {
  it('records a sale on a sandbox and prints who earns what', async () => {
    const h = harness([reply(201, sale())]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale', '--collaborator', '42', '--program', '3', '--amount', '49.99', '--currency', 'USD']), h.err()).toBe(0);

    expect(h.paths()).toEqual(['POST /test-activity']);
    expect(bodyOf(h.http.requests[0])).toEqual({ event: 'sale', collaboratorId: 42, programId: 3, amount: '49.99', currency: 'USD' });
    const out = h.out();
    expect(out).toContain('Sale recorded in Acme (3), sandbox');
    expect(out).toMatch(/Transaction\s+3307 · \$49\.99 USD/);
    expect(out).toMatch(/Collaborator\s+Sam Lee \(42\)/);
    expect(out).toMatch(/Conversion\s+1042 · sale in Partner program · pending/);
    expect(out).toMatch(/Earns\s+Sam Lee {2,}\$7\.50 USD {2,}pending/);
    expect(out).toContain('siren trigger refund --transaction 3307');
    for (const line of out.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  });

  it('sends each --add as a field, JSON when it reads as JSON, and refuses one with no =', async () => {
    const h = harness([reply(201, sale())]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale', '--add', 'source=shopify', '--add', 'items.0.quantity=2', '--add', 'note={"a":1}'])).toBe(0);
    expect(bodyOf(h.http.requests[0])).toEqual({ event: 'sale', fields: { source: 'shopify', 'items.0.quantity': 2, note: { a: 1 } } });

    const bad = harness([reply(201, sale())]);
    bad.signedIn();
    expect(await bad.run(['trigger', 'sale', '--add', 'source'])).toBe(2);
    expect(bad.err()).toContain('--add takes key=value');
    expect(bad.paths()).toEqual([]);
  });

  it('refuses a whole number flag that is not one, before sending', async () => {
    const h = harness([reply(201, sale())]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale', '--collaborator', 'sam'])).toBe(2);
    expect(h.paths()).toEqual([]);
  });

  it('runs on a sandbox only: a live target is refused with --live, and nothing is sent with the session', async () => {
    const h = harness([reply(201, sale())], { edition: 'production' });
    h.signedIn(live());
    expect(await h.run(['trigger', 'sale', '--base-url', BASE, '--live'])).toBe(1);
    expect(h.paths()).toEqual([]);
    expect(h.err()).toContain('runs on a sandbox only');
    expect(h.err()).toContain('siren login --sandbox');
  });

  it('waits on an app answer, reading the sale again every 2 seconds, then prints the reward', async () => {
    const h = harness([
      reply(201, sale({ obligations: [], waits: [wait('sent')] })),
      reply(200, sale({ status: null, message: null, waits: [wait('sent')], obligations: [] })),
      reply(200, sale({ status: null, message: null, waits: [wait('applied')] })),
    ]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /test-activity', 'GET /test-activity/sales/3307', 'GET /test-activity/sales/3307']);
    expect(h.err()).toContain('Waiting on Acme CRM › Split the pool');
    expect(h.out()).toMatch(/Earns\s+Sam Lee/);
    expect(h.out()).toMatch(/Answered\s+Acme CRM › Split the pool · applied/);
  });

  it('stops waiting at --wait and says what still waits, and --wait 0 never reads again', async () => {
    const open = sale({ obligations: [], waits: [wait('sent')] });
    const h = harness([reply(201, open), reply(200, open), reply(200, open), reply(200, { requests: [requestRow({ id: REQUEST })], total: 1 })]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale', '--wait', '4']), h.err()).toBe(0);
    // Then one idPrefix lookup, which finds the request by its short id, so the hint gives that (CLI pass 3).
    expect(h.paths()).toEqual(['POST /test-activity', 'GET /test-activity/sales/3307', 'GET /test-activity/sales/3307', 'GET /apps/requests']);
    expect(Object.fromEntries(new URL(h.http.requests[3]!.url).searchParams)).toEqual({ idPrefix: 'apr_9c60190a' });
    expect(h.out()).toMatch(/Waits\s+Acme CRM › Split the pool · sent/);
    expect(h.out()).toMatch(/siren apps requests 9c60190a +the ask a reward waits on/);

    // A Siren from before idPrefix answers its latest requests instead, so the hint keeps the whole id.
    const none = harness([reply(201, open), reply(200, { requests: [requestRow({ id: 'apr_1111111111111111111111111111aaaa' }), requestRow({ id: 'apr_2222222222222222222222222222bbbb' }), requestRow({ id: REQUEST })], total: 3 })]);
    none.signedIn();
    expect(await none.run(['trigger', 'sale', '--wait', '0'])).toBe(0);
    expect(none.paths()).toEqual(['POST /test-activity', 'GET /apps/requests']);
    expect(none.out()).toContain(`siren apps requests ${REQUEST}`);
  });

  it('prints the last body and nothing else with --json', async () => {
    const h = harness([reply(201, sale())]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual(sale());
    expect(h.err()).toBe('');
  });

  it('records a refund of a named sale, and a visit with its opportunity', async () => {
    const refund = harness([reply(201, sale({ event: 'refund', conversions: [{ ...sale().conversions[0], status: 'rejected' }] }))]);
    refund.signedIn();
    expect(await refund.run(['trigger', 'refund', '--transaction', '3307', '--amount', '10'])).toBe(0);
    expect(bodyOf(refund.http.requests[0])).toEqual({ event: 'refund', transactionId: 3307, amount: '10' });
    expect(refund.out()).toContain('Refund recorded in Acme (3), sandbox');

    const visit = harness([reply(200, sale({ event: 'visit', transactionId: null, total: null, conversions: [], obligations: [] }))]);
    visit.signedIn();
    expect(await visit.run(['trigger', 'visit', '--collaborator', '42'])).toBe(0);
    expect(visit.out()).toContain('Visit recorded in Acme (3), sandbox');
    expect(visit.out()).toMatch(/Opportunity\s+615/);
    expect(visit.out()).toContain('siren trigger sale --opportunity 615');
  });

  it("says why Siren made nothing, with Siren's message", async () => {
    const h = harness([reply(409, { error: { message: 'This organization has no active collaborator to credit.', code: 'no_collaborator' } })]);
    h.signedIn();
    expect(await h.run(['trigger', 'sale'])).toBe(1);
    expect(h.err()).toContain('This organization has no active collaborator to credit.');
  });
});

describe('siren trigger ask <app> <feature>', () => {
  it("sends the feature's sample as a test, waits for the answer, and prints it", async () => {
    const sent = requestRow({ id: REQUEST, kind: 'metricFilter', subject: { type: 'test', id: 'test_abc' }, status: 'sent' });
    const h = harness([
      reply(202, { test: true, request: { ...sent, data: {}, answer: null, answeredByUser: null } }),
      reply(200, { ...sent, status: 'sent', data: {}, answer: null, answeredByUser: null }),
      reply(200, { ...sent, status: 'applied', data: {}, answer: { outcome: 'suppress', reason: 'Refunded.' }, answeredByUser: null }),
      reply(200, { requests: [requestRow({ id: REQUEST })], total: 1 }),
    ]);
    h.signedIn();
    expect(await h.run(['trigger', 'ask', 'acme-crm', 'split-the-pool']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /apps/acme-crm/features/split-the-pool/test', `GET /apps/requests/${REQUEST}`, `GET /apps/requests/${REQUEST}`, 'GET /apps/requests']);
    expect(h.out()).toContain('siren apps requests 9c60190a');
    expect(h.out()).toMatch(/Request\s+apr_9c60190a4501399d0ae55f041c237b39/);
    expect(h.out()).toContain('Siren asked acme-crm › split-the-pool in Acme (3), sandbox (test)');
    expect(h.out()).toMatch(/Answer\s+\{"outcome":"suppress","reason":"Refunded\."\}/);
    expect(h.out()).toContain('Nothing acted on it.');
  });

  it('runs on a live organization with --live, saying the app gets a sample marked test, with --yes in place of the question', async () => {
    const sent = requestRow({ id: REQUEST, mode: 'tell', status: 'delivered' });
    const h = harness([reply(200, app([{ key: 'notify', kind: 'postConversionAction' }])), reply(202, { test: true, request: { ...sent, data: {}, answer: null, answeredByUser: null } }), reply(200, { requests: [requestRow({ id: REQUEST })], total: 1 })], { edition: 'production' });
    h.signedIn(live());
    expect(await h.run(['trigger', 'ask', 'acme-crm', 'notify', '--base-url', BASE, '--live', '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /apps/acme-crm', 'POST /apps/acme-crm/features/notify/test', 'GET /apps/requests']);
    expect(h.err()).toContain('acme-crm › notify receives a sample request marked test in Acme (3), live.');
    expect(h.out()).toContain('Siren told acme-crm › notify in Acme (3), live (test)');
  });

  it('asks before a live sample, and sends nothing unless the person says yes', async () => {
    const sent = requestRow({ id: REQUEST, mode: 'tell', status: 'delivered' });
    const yes = harness([reply(200, app([{ key: 'notify', kind: 'postConversionAction' }])), reply(202, { test: true, request: { ...sent, data: {}, answer: null, answeredByUser: null } }), reply(200, { requests: [requestRow({ id: REQUEST })], total: 1 })], { edition: 'production', interactive: true, typed: ['y'] });
    yes.signedIn(live());
    expect(await yes.run(['trigger', 'ask', 'acme-crm', 'notify', '--base-url', BASE, '--live']), yes.err()).toBe(0);
    expect(yes.prompts).toEqual(['Send it? [y/N] ']);
    expect(yes.paths()).toEqual(['GET /apps/acme-crm', 'POST /apps/acme-crm/features/notify/test', 'GET /apps/requests']);

    const no = harness([reply(200, app([{ key: 'notify', kind: 'postConversionAction' }]))], { edition: 'production', interactive: true, typed: [''] });
    no.signedIn(live());
    expect(await no.run(['trigger', 'ask', 'acme-crm', 'notify', '--base-url', BASE, '--live'])).toBe(1);
    expect(no.paths()).toEqual(['GET /apps/acme-crm']);
    expect(no.err()).toContain('Nothing was sent.');

    const script = harness([reply(200, { key: 'acme-crm', features: [{ key: 'notify', kind: 'postConversionAction' }] })], { edition: 'production' });
    script.signedIn(live());
    expect(await script.run(['trigger', 'ask', 'acme-crm', 'notify', '--base-url', BASE, '--live'])).toBe(1);
    expect(script.paths()).toEqual(['GET /apps/acme-crm']);
    expect(script.err()).toContain('trigger ask acme-crm notify --live --yes');
  });

  it('refuses a payout method on a live organization outright, even with --yes, and names a sandbox', async () => {
    const h = harness([reply(200, app([{ key: 'payout', kind: 'payoutMethod' }]))], { edition: 'production' });
    h.signedIn(live());
    expect(await h.run(['trigger', 'ask', 'acme-crm', 'payout', '--base-url', BASE, '--live', '--yes'])).toBe(1);
    expect(h.paths()).toEqual(['GET /apps/acme-crm']);
    expect(h.err()).toContain('acme-crm › payout is a payout method, so Siren sends it no sample in Acme (3), live.');
    expect(h.err()).toContain("An app that doesn't read the request's test flag could pay out on a sample.");
    expect(h.err()).toContain('siren login --sandbox');
  });

  it('sends a payout method its sample on a sandbox without asking', async () => {
    const sent = requestRow({ id: REQUEST, kind: 'payoutMethod', subject: { type: 'test', id: 'test_abc' }, status: 'pending' });
    const h = harness([reply(202, { test: true, request: { ...sent, data: {}, answer: null, answeredByUser: null } }), reply(200, { requests: [requestRow({ id: REQUEST })], total: 1 })]);
    h.signedIn();
    expect(await h.run(['trigger', 'ask', 'acme-crm', 'payout', '--wait', '0']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /apps/acme-crm/features/payout/test', 'GET /apps/requests']);
  });

  it("is a usage error without the app and the feature, and trigger alone needs an event", async () => {
    const h = harness([]);
    expect(await h.run(['trigger', 'ask', 'acme-crm'])).toBe(2);
    expect(await h.run(['trigger'])).toBe(2);
  });
});

describe('siren apps test <app>', () => {
  it("sends the address one test delivery and prints what it answered", async () => {
    const h = harness([reply(200, { delivered: true, httpStatus: 200, error: null, eventType: 'webhook.test' })]);
    h.signedIn();
    expect(await h.run(['apps', 'test', 'acme-crm']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /apps/acme-crm/test']);
    expect(h.out()).toContain('Siren reached acme-crm in Acme (3), sandbox');
    expect(h.out()).toMatch(/Reply\s+HTTP 200/);
  });

  it('exits 1 with the status and the error when the delivery failed', async () => {
    const h = harness([reply(200, { delivered: false, httpStatus: 500, error: 'Internal Server Error', eventType: 'webhook.test' })]);
    h.signedIn();
    expect(await h.run(['apps', 'test', 'acme-crm'])).toBe(1);
    expect(h.err()).toContain('HTTP 500');
    expect(h.err()).toContain('Internal Server Error');
  });
});

describe('siren fixtures <file>', () => {
  it('runs the steps in order, feeding one answer into the next, a whole reference keeping its type', async () => {
    const h = harness([reply(200, sale({ event: 'visit', transactionId: null, total: null, conversions: [], obligations: [] })), reply(201, sale()), reply(201, sale({ event: 'refund' }))]);
    h.signedIn();
    h.write(
      'flow.json',
      JSON.stringify({
        fixtures: [
          { name: 'visit', trigger: 'visit', params: { collaborator: 42 } },
          { name: 'sale', trigger: 'sale', params: { opportunity: '${visit:opportunityId}', amount: '49.99', wait: 0 } },
          { name: 'refund', trigger: 'refund', params: { transaction: '${sale:transactionId}', add: { note: 'order ${sale:transactionId}' } } },
        ],
      }),
    );
    expect(await h.run(['fixtures', 'flow.json']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests[0])).toEqual({ event: 'visit', collaboratorId: 42 });
    expect(bodyOf(h.http.requests[1])).toEqual({ event: 'sale', opportunityId: 615, amount: '49.99' });
    expect(bodyOf(h.http.requests[2])).toEqual({ event: 'refund', transactionId: 3307, fields: { note: 'order 3307' } });
  });

  it('reads the environment, prints each step, and answers --json with every result', async () => {
    const h = harness([reply(200, sale({ event: 'visit', transactionId: null, total: null, conversions: [], obligations: [] })), reply(201, sale())], { env: { SHOP: 'shopify' } });
    h.signedIn();
    h.write(
      'flow.json',
      JSON.stringify({
        fixtures: [
          { name: 'visit', trigger: 'visit' },
          { name: 'sale', trigger: 'sale', params: { opportunity: '${visit:opportunityId}', add: { source: '${.env:SHOP}' }, wait: 0 } },
        ],
      }),
    );
    expect(await h.run(['fixtures', 'flow.json']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests[1])).toEqual({ event: 'sale', opportunityId: 615, fields: { source: 'shopify' } });
    expect(h.out()).toContain('visit');
    expect(h.out()).toContain('Ran 2 fixtures in Acme (3), sandbox');

    const json = harness([reply(200, sale({ event: 'visit' })), reply(201, sale())]);
    json.signedIn();
    json.write('flow.json', JSON.stringify({ fixtures: [{ name: 'visit', trigger: 'visit' }, { name: 'sale', trigger: 'sale', params: { wait: 0 } }] }));
    expect(await json.run(['fixtures', 'flow.json', '--json'])).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ steps: [{ name: 'visit', trigger: 'visit', result: sale({ event: 'visit' }) }, { name: 'sale', trigger: 'sale', result: sale() }] });
  });

  it('stops before a step whose reference names nothing, having sent the steps before it', async () => {
    const h = harness([reply(201, sale())]);
    h.signedIn();
    h.write('flow.json', JSON.stringify({ fixtures: [{ name: 'sale', trigger: 'sale', params: { wait: 0 } }, { name: 'refund', trigger: 'refund', params: { transaction: '${sael:transactionId}' } }] }));
    expect(await h.run(['fixtures', 'flow.json'])).toBe(1);
    expect(h.paths()).toEqual(['POST /test-activity']);
    expect(h.err()).toContain('${sael:transactionId}');
  });

  it('refuses a file it cannot read, or a step with no name or trigger, before sending', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['fixtures', 'missing.json'])).toBe(1);
    h.write('bad.json', JSON.stringify({ fixtures: [{ trigger: 'sale' }] }));
    expect(await h.run(['fixtures', 'bad.json'])).toBe(1);
    expect(h.err()).toContain('fixtures.0.name');
    expect(h.paths()).toEqual([]);
  });

  it('runs on a sandbox only, unless every step is an ask', async () => {
    const h = harness([reply(201, sale())], { edition: 'production' });
    h.signedIn(live());
    h.write('flow.json', JSON.stringify({ fixtures: [{ name: 'sale', trigger: 'sale' }] }));
    expect(await h.run(['fixtures', 'flow.json', '--base-url', BASE, '--live'])).toBe(1);
    expect(h.paths()).toEqual([]);
  });

  it("checks an ask step's app and feature keys as trigger ask does, before sending it", async () => {
    for (const [params, words] of [
      [{ app: 'Acme CRM', feature: 'notify' }, 'Acme CRM'],
      [{ app: 'acme-crm', feature: 'Notify_All' }, 'Notify_All'],
      [{ app: 'acme-crm' }, 'A feature key'],
    ] as const) {
      const h = harness([]);
      h.signedIn();
      h.write('flow.json', JSON.stringify({ fixtures: [{ name: 'ask', trigger: 'ask', params }] }));
      expect(await h.run(['fixtures', 'flow.json'])).toBe(2);
      expect(h.err()).toContain(words);
      expect(h.paths()).toEqual([]);
    }
  });

  it('follows the live guard of trigger ask for each ask step', async () => {
    const sent = requestRow({ id: REQUEST, mode: 'tell', status: 'delivered' });
    const flow = JSON.stringify({
      fixtures: [
        { name: 'notify', trigger: 'ask', params: { app: 'acme-crm', feature: 'notify', wait: 0 } },
        { name: 'payout', trigger: 'ask', params: { app: 'acme-crm', feature: 'payout' } },
      ],
    });
    const h = harness(
      [
        reply(200, app([{ key: 'notify', kind: 'postConversionAction' }, { key: 'payout', kind: 'payoutMethod' }])),
        reply(202, { test: true, request: { ...sent, data: {}, answer: null, answeredByUser: null } }),
        reply(200, { requests: [requestRow({ id: REQUEST })], total: 1 }),
        reply(200, app([{ key: 'notify', kind: 'postConversionAction' }, { key: 'payout', kind: 'payoutMethod' }])),
      ],
      { edition: 'production' },
    );
    h.signedIn(live());
    h.write('flow.json', flow);
    expect(await h.run(['fixtures', 'flow.json', '--base-url', BASE, '--live', '--yes'])).toBe(1);
    expect(h.paths()).toEqual(['GET /apps/acme-crm', 'POST /apps/acme-crm/features/notify/test', 'GET /apps/requests', 'GET /apps/acme-crm']);
    expect(h.err()).toContain('acme-crm › notify receives a sample request marked test in Acme (3), live.');
    expect(h.err()).toContain('acme-crm › payout is a payout method');

    const script = harness([reply(200, app([{ key: 'notify', kind: 'postConversionAction' }]))], { edition: 'production' });
    script.signedIn(live());
    script.write('flow.json', flow);
    expect(await script.run(['fixtures', 'flow.json', '--base-url', BASE, '--live'])).toBe(1);
    expect(script.paths()).toEqual(['GET /apps/acme-crm']);
    expect(script.err()).toContain('fixtures flow.json --live --yes');
  });
});

describe('siren simulate', () => {
  it('runs a sale on a live organization without --live, and says it wrote nothing', async () => {
    const h = harness([reply(200, sale({ simulated: true, status: 'created' }))], { edition: 'production' });
    h.signedIn(live());
    expect(await h.run(['simulate', '--amount', '49.99', '--program', '3', '--base-url', BASE]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /simulations/sale']);
    expect(bodyOf(h.http.requests[0])).toEqual({ amount: '49.99', programId: 3 });
    expect(h.out()).toContain('A $49.99 USD sale would earn 1 reward in Acme (3), live');
    expect(h.out()).toContain('Nothing was written.');
    expect(h.out()).toMatch(/Programs\s+Partner program/);
    expect(h.out()).toMatch(/Sam Lee\s+\$7\.50 USD\s+pending/);
    expect(h.out()).not.toContain('3307');
  });

  it('prints the body with --json', async () => {
    const h = harness([reply(200, sale({ simulated: true }))]);
    h.signedIn();
    expect(await h.run(['simulate', '--json'])).toBe(0);
    expect(JSON.parse(h.out())).toEqual(sale({ simulated: true }));
  });
});

describe('what Siren sends, printed', () => {
  /** Siren's text with an escape sequence, a link and a bell in it, which must never reach the screen. */
  const sly = (text: string) => `${text}\u001b[2J\u001b]8;;https://evil.example\u0007\u009b1A`;
  /** No control character is left, only the line breaks, and no line passes 80 columns. */
  const clear = (text: string) => {
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    for (const line of text.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  };
  const slySession = () => ({ [SANDBOX_BASE_URL]: session({ orgName: sly('Acme') }) });
  const slySale = (overrides: Record<string, unknown> = {}) =>
    sale({
      message: sly('The sale was recorded.'),
      collaborator: { id: 42, name: sly('Sam Lee') },
      conversions: [{ id: 1042, type: sly('sale'), status: sly('pending'), programId: 3, programName: sly('Partner program'), collaboratorId: 42, collaboratorName: sly('Sam'), obligationId: 2210, waitsOn: null }],
      obligations: [
        { id: 2210, collaboratorId: 42, collaboratorName: sly('Sam Lee'), programId: 3, value: 750, units: 'USD', status: sly('pending'), holdReason: sly('fraud check') },
        { id: 2211, collaboratorId: 43, collaboratorName: 'Kim', programId: 4, value: 100, units: sly('pts'), status: 'pending', holdReason: null },
      ],
      waits: [{ ...wait('sent'), requestKey: sly(REQUEST), appName: sly('Acme CRM'), featureName: sly('Split the pool'), status: sly('sent') }],
      ...overrides,
    });

  it('cleans every value from Siren in trigger, simulate and fixtures', async () => {
    const h = harness([reply(201, slySale())]);
    h.signedIn(slySession());
    expect(await h.run(['trigger', 'sale', '--wait', '0']), h.err()).toBe(0);
    clear(h.out());
    expect(h.out()).toContain('Sale recorded in Acme (3), sandbox');
    expect(h.out()).toMatch(/Collaborator\s+Sam Lee \(42\)/);

    const sim = harness([reply(200, slySale({ simulated: true }))]);
    sim.signedIn(slySession());
    expect(await sim.run(['simulate']), sim.err()).toBe(0);
    clear(sim.out());
    expect(sim.out()).toMatch(/Programs\s+Partner program/);

    const steps = harness([reply(201, slySale()), reply(202, { test: true, request: { ...requestRow({ id: REQUEST, status: sly('applied') }), data: {}, answer: { note: sly('ok') }, answeredByUser: null } })]);
    steps.signedIn(slySession());
    steps.write('flow.json', JSON.stringify({ fixtures: [{ name: 'sale', trigger: 'sale', params: { wait: 0 } }, { name: 'ask', trigger: 'ask', params: { app: 'acme-crm', feature: 'notify', wait: 0 } }] }));
    expect(await steps.run(['fixtures', 'flow.json']), steps.err()).toBe(0);
    clear(steps.out());
    expect(steps.out()).toContain('Ran 2 fixtures in Acme (3), sandbox');
  });

  it('cleans the request in trigger ask, and the reply and error in apps test', async () => {
    const asked = { ...requestRow({ id: REQUEST, status: sly('applied') }), data: {}, answer: { reason: sly('Refunded.') }, lastError: sly('Timed out.'), answeredByUser: null };
    const h = harness([reply(202, { test: true, request: asked })]);
    h.signedIn(slySession());
    expect(await h.run(['trigger', 'ask', 'acme-crm', 'split-the-pool', '--wait', '0']), h.err()).toBe(0);
    clear(h.out());
    expect(h.out()).toMatch(/Error\s+Timed out\./);

    const ok = harness([reply(200, { delivered: true, httpStatus: 200, error: null, eventType: sly('webhook.test') })]);
    ok.signedIn(slySession());
    expect(await ok.run(['apps', 'test', 'acme-crm']), ok.err()).toBe(0);
    clear(ok.out());
    expect(ok.out()).toMatch(/Event\s+webhook\.test/);

    const failed = harness([reply(200, { delivered: false, httpStatus: 500, error: sly('Internal Server Error'), eventType: 'webhook.test' })]);
    failed.signedIn(slySession());
    expect(await failed.run(['apps', 'test', 'acme-crm'])).toBe(1);
    // A plain error is one line by design, so only its characters are checked.
    expect(failed.err()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(failed.err()).toContain('HTTP 500: Internal Server Error');
  });
});
