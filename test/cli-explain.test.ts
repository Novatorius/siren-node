import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rewardState } from '../src/cli/commands/explain';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * siren explain <type> <id>: why a sale paid what it did, from Siren's GET
 * /notes/chain. The chains are recorded from Siren PR 1254's preview in
 * uat-org: an approved conversion whose reward is owed (5640), a pending one
 * with a draft reward (5514), a reward in a payout not paid yet (5362), a
 * paid reward (3904), a sale no engagement claimed (7514), and a sale three
 * programs each rewarded (7516).
 */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/records/activity-and-chains.json', import.meta.url), 'utf8')) as Record<string, any>;
const REGISTRY = [
  { code: 'EUR', name: 'Euro', symbol: '€', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: true },
  { code: 'USD', name: 'US Dollar', symbol: '$', symbolPosition: 'before', scale: 2, decimalPlaces: 2, type: 'monetary', isDefault: false },
  { code: 'PTS', name: 'Points', symbol: 'pts', symbolPosition: 'after', scale: 0, decimalPlaces: 0, type: 'internal', isDefault: false },
];
const APP = 'https://sandbox.sirenaffiliates.com';
const queryOf = (h: ReturnType<typeof harness>, at: number) => Object.fromEntries(new URL(h.http.requests[at]!.url).searchParams);
const signedIn = (replies: Parameters<typeof harness>[0]) => {
  const h = harness(replies, { env: { TZ: 'UTC' } });
  h.signedIn({ [SANDBOX_BASE_URL]: session({ orgSlug: 'uat-org' }) });
  return h;
};
const chain = (key: string) => [reply(200, recorded[key]), reply(200, REGISTRY)];
/** Program 16 as GET /programs/16 answers it on the preview: 18% of each sale. */
const PROGRAM_16 = { id: 16, name: 'EU Partner Program', status: 'active', units: 'EUR', incentiveType: { id: 'saleTransactionPercentage', name: 'Percentage of Transaction' }, incentiveTypeArgs: { activeConversionTypes: '["sale","renewal"]', transactionPercent: '18' } };
/** The sale's notes as GET /notes answers them on the preview, newest first. */
const SALE_NOTES = {
  items: [
    { id: 14334, renderedContent: 'Conversion for sale (€109.00 EUR) in EU Partner Program approved by admin@siren-uat.local', creationSource: 'conversion' },
    { id: 14302, renderedContent: 'Sale (€109.00 EUR) is in a currency that distributor Team bonus does not pay in, so those lines were left out of its pool. Siren does not convert currencies.', creationSource: 'transaction' },
  ],
  total: 2,
};
const REQUEST = { id: 'apr_1a2b3c4d5e6f708192a3b4c5d6e7f809', appId: 4, feature: 'app:11', kind: 'postConversionAction', mode: 'tell', subject: { type: 'conversion', id: '5640' }, status: 'delivered', sendCount: 1, answerBy: null, answeredBy: null, answeredAt: null, lastError: null, createdAt: '2026-11-26T15:24:00+00:00' };
const OTHER = { ...REQUEST, id: 'apr_ffff3c4d5e6f708192a3b4c5d6e7f809', subject: { type: 'conversion', id: '1' } };
/** Every read explain makes for conversion 5640, in the order it sends them. */
const full = () => [reply(200, recorded.chainApprovedConversion5640), reply(200, REGISTRY), reply(200, PROGRAM_16), reply(200, SALE_NOTES), reply(200, [REQUEST, OTHER]), reply(200, [{ id: 4, key: 'acme-payouts' }])];

describe('siren explain', () => {
  it('says an approved conversion is owed and not paid, step by step, with the rule, the sale\'s notes and the app requests it caused', async () => {
    const h = signedIn(full());
    expect(await h.run(['explain', 'conversion', '5640']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['GET /notes/chain', 'GET /registries/currencies', 'GET /programs/16', 'GET /notes', 'GET /apps/requests', 'GET /apps']);
    expect(queryOf(h, 0)).toEqual({ recordType: 'conversion', recordId: '5640' });
    expect(queryOf(h, 3)).toMatchObject({ sourceType: 'transaction', sourceId: '7517' });
    expect(h.out()).toBe(
      [
        'conversion 5640 · sale 7517, Steinzeug Set, €109.00 EUR',
        '',
        '  This sale earned €19.62 EUR for Paolo Ricci (collaborator 208). It is approved and owed, not paid yet.',
        // Review round 1: the rule or rate behind the amount.
        '  EU Partner Program (program 16) pays 18% of each sale, and 18% of €109.00 EUR is €19.62 EUR.',
        '',
        '  1  engagement 41287  Paolo Ricci (collaborator 208) on EU Partner Program (program 16), won the sale',
        '  2  conversion 5640   sale conversion, complete, approved by admin@siren-uat.local',
        '  3  reward 5888       €19.62 EUR to Paolo Ricci (collaborator 208): approved and owed, not paid yet',
        '',
        // Review round 1: Siren's own notes from the sale, and not the ones that repeat the steps.
        'Siren noted on the sale',
        '  Sale (€109.00 EUR) is in a currency that distributor Team bonus does not pay in, so those lines were left out of its pool. Siren does not convert currencies.',
        '',
        // Review round 1: the app requests about the sale's records, with the id siren apps requests takes.
        'Apps',
        '  1a2b3c4d  acme-payouts · Post-conversion action · delivered · about conversion 5640',
        '  siren apps requests 1a2b3c4d shows one.',
        '',
        `${APP}/conversions/5640?org=uat-org`,
        '',
      ].join('\n'),
    );
    expect(h.err()).toContain('siren explain conversion 5640 --chain shows the whole chain');
  });

  it('never calls a pending conversion with a draft reward paid or owed', async () => {
    const h = signedIn(chain('chainPendingConversion5514'));
    expect(await h.run(['explain', 'conversion', '5514']), h.err()).toBe(0);
    expect(h.out()).toContain('This sale has a draft reward of €33.66 EUR for Paolo Ricci (collaborator 208), waiting for its conversion to be approved. Nothing is owed or paid yet.');
    expect(h.out()).toContain('sale conversion, pending, waiting for approval');
    expect(h.out()).toContain('€33.66 EUR to Paolo Ricci (collaborator 208): a draft, waiting for its conversion to be approved, so not owed or paid yet');
    expect(h.out()).not.toMatch(/has been paid|This sale paid|approved and owed|in payout/);
  });

  it('says a reward in a payout not marked paid is not paid yet, and names the payout', async () => {
    const h = signedIn(chain('chainRewardInUnpaidPayout5362'));
    expect(await h.run(['explain', 'reward', '5362']), h.err()).toBe(0);
    expect(queryOf(h, 0)).toEqual({ recordType: 'obligation', recordId: '5362' });
    expect(h.out()).toContain("This sale earned €5.22 EUR for Paolo Ricci (collaborator 208). It is in a payout that hasn't been paid yet.");
    expect(h.out()).toContain("€5.22 EUR to Paolo Ricci (collaborator 208): in payout 613, which hasn't been paid yet");
  });

  it('shows the whole chain with --chain, from the opportunity and the sale to the paid payout and its fulfillment', async () => {
    const h = signedIn(chain('chainPaidReward3904'));
    expect(await h.run(['explain', 'obligation', '3904', '--chain']), h.err()).toBe(0);
    const out = h.out().split('\n');
    expect(out[2]).toBe('  This sale paid €5.22 EUR to Paolo Ricci (collaborator 208).');
    expect(out.slice(4, 10)).toEqual([
      '  1  opportunity 25624  active, opened Jul 7, 2026',
      '  2  sale 4646          Kerze Zeder, €29.00 EUR, complete',
      '  3  engagement 27143   Paolo Ricci (collaborator 208) on EU Partner Program (program 16), won the sale',
      '  4  conversion 3740    sale conversion, complete',
      '  5  reward 3904        €5.22 EUR to Paolo Ricci (collaborator 208): paid in payout 464',
      '  6  payout 464         €83.34 EUR, paid, in fulfillment 30, paid Aug 1, 2026',
    ]);
    expect(h.err()).not.toContain('--chain');
  });

  it('says why a sale nothing claimed earned nothing, and takes sale for a transaction', async () => {
    const h = signedIn(chain('chainEmptySale7514'));
    expect(await h.run(['explain', 'sale', '7514']), h.err()).toBe(0);
    expect(queryOf(h, 0)).toEqual({ recordType: 'transaction', recordId: '7514' });
    expect(h.out()).toContain('sale 7514 · Leinendecke, €79.00 EUR');
    expect(h.out()).toContain('This sale earned no reward, because Siren has no opportunity on record for it, so no engagement could claim it.');
  });

  it('adds each currency on its own when one sale rewards in money and points', async () => {
    const h = signedIn(chain('chainThreeProgramsSale7516'));
    expect(await h.run(['explain', 'transaction:7516']), h.err()).toBe(0);
    expect(h.out()).toContain('This sale has a draft reward of $34.70 USD and 150 pts for Rosa Delgado (collaborator 25)');
    expect(h.out()).toContain('150 pts to Rosa Delgado (collaborator 25)');
  });

  it("shows a losing engagement and Siren's reason only with --chain", async () => {
    const lost = structuredClone(recorded.chainApprovedConversion5640);
    lost.chains[0].paths.push({
      engagement: { id: 41200, status: 'active', collaborator: { id: 39, name: 'Marcus Bell' }, program: { id: 16, name: 'EU Partner Program' }, couponCode: null },
      state: 'lost',
      ending: null,
      conversions: [],
      obligations: [],
      reason: { key: 'engagement_superseded', text: 'A later engagement by Paolo Ricci won the sale.' },
    });
    const plain = signedIn([reply(200, lost), reply(200, REGISTRY)]);
    expect(await plain.run(['explain', 'conversion', '5640']), plain.err()).toBe(0);
    expect(plain.out()).not.toContain('Marcus Bell');
    const whole = signedIn([reply(200, lost), reply(200, REGISTRY)]);
    expect(await whole.run(['explain', 'conversion', '5640', '--chain']), whole.err()).toBe(0);
    expect(whole.out()).toContain('engagement 41200   Marcus Bell (collaborator 39) on EU Partner Program (program 16), lost. A later engagement by Paolo Ricci won the sale.');
  });

  it('prints the summary, state, money with its text, and each step with its page as JSON (review round 1, C4)', async () => {
    const h = signedIn(chain('chainPendingConversion5514'));
    expect(await h.run(['explain', 'conversion', '5514', '--json']), h.err()).toBe(0);
    expect(h.paths().slice(0, 2)).toEqual(['GET /notes/chain', 'GET /registries/currencies']);
    const body = JSON.parse(h.out());
    expect(body).toMatchObject({
      record: { type: 'conversion', id: 5514, url: `${APP}/conversions/5514?org=uat-org` },
      sale: { id: 7343, amount: 18700, currency: 'EUR', formatted: '€187.00 EUR', url: `${APP}/transactions/7343?org=uat-org` },
      state: 'unpaid',
      earned: [{ amount: 3366, currency: 'EUR', formatted: '€33.66 EUR' }],
      rewards: { paid: [], inPayout: [], owed: [], draft: [{ amount: 3366, currency: 'EUR', formatted: '€33.66 EUR' }] },
    });
    // The words never hold the stored integer as the amount.
    expect(body.summary).toContain('€33.66 EUR');
    expect(JSON.stringify(body.steps)).not.toMatch(/\b3366 EUR\b/);
    expect(body.rules).toEqual([]);
    expect(body.steps.map((step: { type: string; id: number }) => `${step.type} ${step.id}`)).toEqual(['engagement 40455', 'conversion 5514', 'obligation 5760']);
    expect(body.steps[2]).toMatchObject({ status: 'draft', url: `${APP}/obligations/5760?org=uat-org` });
  });

  it('leaves out a part whose read fails, and never says no app was sent a request when it could not read them', async () => {
    const h = signedIn([reply(200, recorded.chainApprovedConversion5640), reply(200, REGISTRY), reply(200, PROGRAM_16), reply(200, SALE_NOTES), reply(403, { error: { message: 'Forbidden.' } }), reply(200, [])]);
    expect(await h.run(['explain', 'conversion', '5640']), h.err()).toBe(0);
    expect(h.out()).toContain('pays 18% of each sale');
    expect(h.out()).not.toContain('Apps');
    expect(h.out()).not.toContain('sent no app');
  });

  it('says a pending conversion waits for approval before a post-conversion action fires', async () => {
    const h = signedIn([reply(200, recorded.chainPendingConversion5514), reply(200, REGISTRY), reply(200, PROGRAM_16), reply(200, { items: [] }), reply(200, []), reply(200, [])]);
    expect(await h.run(['explain', 'conversion', '5514']), h.err()).toBe(0);
    expect(h.out().replace(/\s+/g, ' ')).toContain('Siren sent no app a request about this sale. A post-conversion action waits until the conversion is approved.');
  });

  it('says when this Siren has no chain route, and when it has no such record', async () => {
    const old = signedIn([reply(404, { error: { message: 'Not found.' } })]);
    expect(await old.run(['explain', 'conversion', '5640'])).toBe(1);
    expect(old.err()).toContain("This Siren doesn't have sale chains yet.");
    const missing = signedIn([reply(404, { error: { message: 'No record found with that ID.' } })]);
    expect(await missing.run(['explain', 'conversion', '99'])).toBe(1);
    expect(missing.err()).toContain('Siren has no conversion 99 in uat-org.');
    expect(missing.err()).toContain('siren conversions list to see them');
  });

  it('refuses a type the chain does not start from, and a missing id, before sending', async () => {
    const h = signedIn([]);
    expect(await h.run(['explain', 'program', '4'])).toBe(2);
    expect(h.err()).toContain('It takes transaction, conversion, obligation, engagement.');
    expect(await h.run(['explain', 'conversion'])).toBe(2);
    expect(await h.run(['explain', 'conversion', 'abc'])).toBe(2);
    expect(h.paths()).toEqual([]);
  });
});

describe('where a reward stands', () => {
  it('is paid only once it sits in a payout marked paid', () => {
    expect(rewardState('complete', 'paid')).toBe('paid');
    expect(rewardState('complete', 'unpaid')).toBe('inPayout');
    expect(rewardState('complete', undefined)).toBe('inPayout');
    expect(rewardState('approved', undefined)).toBe('owed');
    expect(rewardState('draft', undefined)).toBe('draft');
    expect(rewardState('rejected', undefined)).toBe('rejected');
  });
});
