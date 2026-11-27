import { NotFoundError } from '../../errors';
import { parseJsonBody } from '../../http';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { recordLink } from '../links';
import { currenciesFor, moneyText } from '../money';
import type { CurrencyDefinitions } from '../money';
import { orgScope } from '../org';
import { day } from '../record-view';
import { clean, hanging, styleFor, wrapWords } from '../style';
import { CliRefusal } from '../targets';
import { gated } from './condition-sets';
import { recordArgs } from './open';

/*
 * `siren explain <type> <id>`: why a sale, a conversion or a reward paid
 * what it did. It reads Siren's GET /notes/chain with recordType and
 * recordId, the read behind the record flow graph in Siren's app, and words
 * what it finds. Siren did every calculation. The command only reads, and it
 * never calls a reward paid until it sits in a payout marked paid.
 */

/** The records the chain route starts from. A sale is a transaction and a reward an obligation. */
export const EXPLAIN_TYPES = ['transaction', 'conversion', 'obligation', 'engagement'] as const;

/** Where a reward stands. */
type RewardState = 'paid' | 'inPayout' | 'owed' | 'draft' | 'rejected';

/** A reward's state in words, for its step, with the payout it sits in. */
function stateWords(state: RewardState, payoutId: unknown): string {
  const payout = payoutId == null ? 'a payout' : `payout ${clean(String(payoutId))}`;
  switch (state) {
    case 'paid':
      return `paid in ${payout}`;
    case 'inPayout':
      return `in ${payout}, which hasn't been paid yet`;
    case 'owed':
      return 'approved and owed, not paid yet';
    case 'draft':
      return 'a draft, waiting for its conversion to be approved, so not owed or paid yet';
    default:
      return "rejected, so it won't be paid";
  }
}

/** Why a sale with nothing to draw earned nothing, by Siren's `emptySale.reason`. */
const EMPTY_SALE: Readonly<Record<string, string>> = {
  no_engagement: 'its opportunity has no engagement',
  no_engagement_before_sale: 'every engagement came after the sale',
  no_opportunity: 'Siren has no opportunity on record for it, so no engagement could claim it',
  unknown_tracking_id: "it names an opportunity Siren doesn't have",
  engagements_unreadable: "this sign-in can't read the engagements behind its conversions",
  unknown: "the chain was cut short, so Siren can't say",
};

/** How a win that no longer stands ended, by Siren's `ending`. */
const ENDINGS: Readonly<Record<string, string>> = {
  rejected: 'turned down',
  reversed: 'approved, then rejected',
  order_ended: 'cancelled before approval, because the order ended',
  reversed_by_order: 'approved, then reversed because the order ended',
  partly_refunded: 'cancelled, because a partial refund brought the reward to nothing',
  deleted: 'the reward was deleted',
};

/**
 * Where a reward stands. Siren pays approved rewards into payouts, so a
 * reward is paid only once it sits in a payout marked paid.
 */
export function rewardState(status: string, payoutStatus: string | undefined): RewardState {
  switch (status) {
    case 'approved':
      return 'owed';
    case 'complete':
      return payoutStatus === 'paid' ? 'paid' : 'inPayout';
    case 'rejected':
    case 'cancelled':
    case 'deleted':
      return 'rejected';
    default:
      return 'draft';
  }
}

/** One step of the explanation: a record, what it says, and where it opens. */
export interface ExplainStep {
  type: string | null;
  id: number | null;
  status: string | null;
  text: string;
  url: string | null;
  /** True for a step only --chain shows: the sale, the opportunity, engagements that didn't win and what they led to, payouts and other notes. */
  chainOnly: boolean;
}

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((row): row is Row => typeof row === 'object' && row !== null && !Array.isArray(row)) : []);
const object = (value: unknown): Row | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : undefined);
const text = (value: unknown): string => clean(String(value ?? ''));

/** A name with its record type and id beside it: `Paolo Ricci (collaborator 208)`. */
function named(row: Row | undefined, type: string): string {
  if (row === undefined) return `a ${type}`;
  const name = typeof row.name === 'string' && row.name !== '' ? clean(row.name) : `a ${type}`;
  return `${name} (${type} ${text(row.id)})`;
}

/** Sums by currency, as `€19.62 EUR and 1,745 pts`. */
function sumsText(sums: ReadonlyMap<string, number>, definitions: CurrencyDefinitions): string {
  return [...sums].map(([currency, amount]) => money(amount, currency, definitions)).join(' and ');
}

/** An amount as the tool prints money, or the stored integer and code when the currency can't be read. */
function money(amount: unknown, currency: unknown, definitions: CurrencyDefinitions): string {
  const code = typeof currency === 'string' ? currency : null;
  return moneyText(amount, code, definitions) ?? `${text(amount)}${code === null ? '' : ` ${clean(code)}`}`;
}

/** What one chain answer says, worked out once for the text and for --json. */
export interface Explanation {
  sale: { id: number; name: string | null; amount: number | null; currency: string | null; status: string | null } | null;
  state: 'none' | 'unpaid' | 'partly_paid' | 'paid';
  summary: string;
  earned: Array<{ amount: number; currency: string }>;
  rewards: Record<Exclude<RewardState, 'rejected'>, Array<{ amount: number; currency: string }>>;
  steps: ExplainStep[];
  capped: boolean;
}

/** The explanation of Siren's chain answer. `link` builds a record's address in the app. */
export function explain(chain: unknown, definitions: CurrencyDefinitions, link: (type: string, id: unknown, extra?: { fulfillmentId?: unknown }) => string, zone: string | undefined): Explanation {
  const answer = object(chain) ?? {};
  const steps: ExplainStep[] = [];
  const by: Record<RewardState, Map<string, number>> = { paid: new Map(), inPayout: new Map(), owed: new Map(), draft: new Map(), rejected: new Map() };
  const earners: string[] = [];
  const winners: string[] = [];
  let sale: Explanation['sale'] = null;
  const step = (type: string | null, id: unknown, status: string | null, words: string, chainOnly: boolean, extra: { fulfillmentId?: unknown } = {}) => {
    const shown = typeof id === 'number' || (typeof id === 'string' && id !== '') ? Number(id) : null;
    steps.push({ type, id: shown, status, text: words, url: type === null || shown === null ? null : link(type, shown, extra), chainOnly });
  };
  const saleWords = (t: Row) =>
    [
      typeof t.name === 'string' && t.name !== '' ? clean(t.name) : 'a sale',
      t.amount == null ? 'no amount' : money(t.amount, t.currency, definitions),
      text(t.status),
      ...(t.isTest === true ? ['a test sale'] : []),
      ...(typeof t.refunded === 'string' && t.refunded !== '' ? [`refunded ${clean(t.refunded)}`] : []),
    ].join(', ');

  const empty = object(answer.emptySale);
  if (empty !== undefined) {
    const t = object(empty.transaction);
    if (t !== undefined) {
      sale = { id: Number(t.id), name: typeof t.name === 'string' ? t.name : null, amount: typeof t.amount === 'number' ? t.amount : null, currency: typeof t.currency === 'string' ? t.currency : null, status: typeof t.status === 'string' ? t.status : null };
      step('transaction', t.id, typeof t.status === 'string' ? t.status : null, saleWords(t), false);
    }
  }

  for (const c of rows(answer.chains)) {
    const payouts = new Map(rows(c.payouts).map((p) => [String(p.id), p]));
    const opportunity = object(c.opportunity);
    if (opportunity !== undefined && opportunity.id != null) step('opportunity', opportunity.id, typeof opportunity.status === 'string' ? opportunity.status : null, `${text(opportunity.status)}${typeof opportunity.dateCreated === 'string' ? `, opened ${day(opportunity.dateCreated, zone)}` : ''}`, true);
    for (const t of rows(c.transactions)) {
      sale ??= { id: Number(t.id), name: typeof t.name === 'string' ? t.name : null, amount: typeof t.amount === 'number' ? t.amount : null, currency: typeof t.currency === 'string' ? t.currency : null, status: typeof t.status === 'string' ? t.status : null };
      step('transaction', t.id, typeof t.status === 'string' ? t.status : null, saleWords(t), true);
    }
    for (const p of rows(c.paths)) {
      const e = object(p.engagement) ?? {};
      const collaborator = object(e.collaborator);
      const who = named(collaborator, 'collaborator');
      const program = object(e.program);
      const state = text(p.state);
      const won = state === 'won';
      if (won) winners.push(who);
      const reason = object(p.reason);
      const ending = typeof p.ending === 'string' ? ENDINGS[p.ending] ?? p.ending.replace(/_/g, ' ') : undefined;
      const outcome = won ? 'won the sale' : state === 'open' ? 'still open, the sale may not have happened yet' : state === 'reversed' ? `won, then ${ending ?? 'reversed'}` : state === 'lost' ? 'lost' : state;
      step(
        'engagement',
        e.id,
        typeof e.status === 'string' ? e.status : null,
        [
          `${who}${program === undefined ? '' : ` on ${named(program, 'program')}`}${typeof e.couponCode === 'string' && e.couponCode !== '' ? ` with coupon ${clean(e.couponCode)}` : ''}, ${outcome}`,
          ...(reason !== undefined && typeof reason.text === 'string' && reason.text !== '' ? [clean(reason.text)] : []),
        ].join('. '),
        !won,
      );
      for (const v of rows(p.conversions)) {
        const decided = object(v.decidedBy);
        const status = text(v.status);
        const words = [
          `${text(v.type) || 'a'} conversion, ${status === 'pending' ? 'pending, waiting for approval' : status}`,
          ...(decided !== undefined && typeof decided.name === 'string' && decided.name !== '' ? [`${status === 'rejected' ? 'rejected' : 'approved'} by ${clean(decided.name)}`] : []),
          ...(v.reversed === true ? ['since reversed'] : []),
        ].join(', ');
        const why = object(v.reason);
        step('conversion', v.id, status || null, `${words}${why !== undefined && typeof why.text === 'string' && why.text !== '' ? `. ${clean(why.text)}` : ''}`, !won);
      }
      for (const o of rows(p.obligations)) {
        const payout = o.payoutId == null ? undefined : payouts.get(String(o.payoutId));
        const rewardIs = rewardState(text(o.status), typeof payout?.status === 'string' ? payout.status : undefined);
        const amount = typeof o.value === 'number' ? o.value : undefined;
        const currency = typeof o.currency === 'string' ? o.currency : undefined;
        if (amount !== undefined && currency !== undefined) {
          by[rewardIs].set(currency, (by[rewardIs].get(currency) ?? 0) + amount);
          if (rewardIs !== 'rejected') earners.push(who);
        }
        step('obligation', o.id, text(o.status) || null, `${amount === undefined ? 'no amount' : money(amount, currency, definitions)} to ${who}: ${stateWords(rewardIs, o.payoutId)}`, !won);
      }
    }
    for (const p of rows(c.payouts)) {
      const parts = [
        money(p.value, p.currency, definitions),
        text(p.status),
        ...(p.fulfillmentId != null ? [`in fulfillment ${text(p.fulfillmentId)}`] : []),
        ...(typeof p.datePaid === 'string' ? [`paid ${day(p.datePaid, zone)}`] : []),
        ...(typeof p.waitingReason === 'string' && p.waitingReason !== '' ? [`waiting: ${clean(p.waitingReason).replace(/_/g, ' ')}`] : []),
        ...(typeof p.failureReason === 'string' && p.failureReason !== '' ? [`failed: ${clean(p.failureReason)}`] : []),
      ];
      step('payout', p.id, typeof p.status === 'string' ? p.status : null, parts.join(', '), true, { fulfillmentId: p.fulfillmentId });
    }
    for (const r of rows(c.otherReasons)) if (typeof r.text === 'string' && r.text !== '') step(null, null, null, clean(r.text), true);
  }

  const earned = new Map<string, number>();
  for (const state of ['paid', 'inPayout', 'owed', 'draft'] as const) for (const [currency, amount] of by[state]) earned.set(currency, (earned.get(currency) ?? 0) + amount);
  const unique = [...new Set(earners)];
  const to = unique.join(' and ');
  const standing = (['paid', 'inPayout', 'owed', 'draft'] as const).filter((state) => by[state].size > 0);
  const state: Explanation['state'] = earned.size === 0 ? 'none' : by.paid.size === 0 ? 'unpaid' : standing.length === 1 ? 'paid' : 'partly_paid';

  let summary: string;
  if (empty !== undefined) {
    const reason = text(empty.reason);
    summary = `This sale earned no reward, because ${EMPTY_SALE[reason] ?? reason.replace(/_/g, ' ')}.`;
  } else if (earned.size === 0) {
    const rejected = by.rejected.size > 0;
    summary = rejected
      ? `This sale's rewards were rejected, so it pays nothing.`
      : winners.length === 0
        ? 'This sale earned no reward, since no engagement won it.'
        : `This sale earned no reward for ${[...new Set(winners)].join(' and ')}. The steps say why.`;
  } else if (state === 'paid') {
    summary = `This sale paid ${sumsText(by.paid, definitions)} to ${to}.`;
  } else if (standing.length === 1 && standing[0] === 'draft') {
    summary = `This sale has a draft reward of ${sumsText(by.draft, definitions)} for ${to}, waiting for its conversion to be approved. Nothing is owed or paid yet.`;
  } else {
    const parts = [
      ...(by.paid.size > 0 ? [`${sumsText(by.paid, definitions)} has been paid`] : []),
      ...(by.inPayout.size > 0 ? [`${sumsText(by.inPayout, definitions)} is in a payout that hasn't been paid yet`] : []),
      ...(by.owed.size > 0 ? [`${sumsText(by.owed, definitions)} is approved and owed, not paid yet`] : []),
      ...(by.draft.size > 0 ? [`${sumsText(by.draft, definitions)} is a draft reward, waiting for its conversion to be approved`] : []),
    ];
    const tail = standing.length === 1 ? { inPayout: "It is in a payout that hasn't been paid yet.", owed: 'It is approved and owed, not paid yet.' }[standing[0] as 'inPayout' | 'owed'] : `${parts.join('. ').replace(/^./, (first) => first.toUpperCase())}.${state === 'unpaid' ? ' Nothing has been paid yet.' : ''}`;
    summary = `This sale earned ${sumsText(earned, definitions)} for ${to}. ${tail}`;
  }

  const list = (sums: Map<string, number>) => [...sums].map(([currency, amount]) => ({ amount, currency }));
  return {
    sale,
    state,
    summary,
    earned: list(earned),
    rewards: { paid: list(by.paid), inPayout: list(by.inPayout), owed: list(by.owed), draft: list(by.draft) },
    steps,
    capped: answer.capped === true,
  };
}

const CHAIN = { name: 'sale chains', route: '/notes/chain' };

/** `siren explain <type> <id> [--chain]`. */
export async function explainRecord(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const { type, id } = recordArgs(input.args, EXPLAIN_TYPES, 'siren explain') as { type: (typeof EXPLAIN_TYPES)[number]; id: string };
  const session = await run.signedIn();
  const scope = await orgScope(run, input, session, 'explain');
  let chain: unknown;
  try {
    chain = await parseJsonBody(await scope.http.request({ method: 'GET', path: '/notes/chain', query: { recordType: type, recordId: id }, retriable: true }));
  } catch (error) {
    if (error instanceof NotFoundError && !/^(?:siren: )?not found\.?$/i.test(error.message.trim())) {
      const plural = type === 'transaction' ? 'transactions' : `${type}s`;
      throw new CliRefusal(`Siren has no ${type} ${id} in ${clean(scope.orgSlug)}.`, { why: `It answered 404: ${clean(error.message.replace(/^Siren: /, ''))}`, fix: run.command(`${plural} list`), fixWords: 'to see them' });
    }
    throw gated(error, CHAIN);
  }
  const definitions =
    values.json === true
      ? undefined
      : await currenciesFor(io.configDir, `${run.target.baseUrl} ${scope.orgId}`, io.now(), async () => parseJsonBody(await scope.http.request({ method: 'GET', path: '/registries/currencies', retriable: true })));
  const link = (recordType: string, recordId: unknown, extra: { fulfillmentId?: unknown } = {}) => recordLink(run.target.baseUrl, io.env, scope.orgSlug, recordType, String(recordId), extra);
  const explained = explain(chain, definitions, link, io.env.TZ);
  const wantsChain = values.chain === true;
  const steps = explained.steps.filter((one) => wantsChain || !one.chainOnly);
  const url = link(type, id);

  if (values.json === true) {
    run.print(JSON.stringify({ record: { type, id: Number(id), url }, sale: explained.sale === null ? null : { ...explained.sale, url: link('transaction', explained.sale.id) }, state: explained.state, summary: explained.summary, earned: explained.earned, rewards: explained.rewards, capped: explained.capped, steps: steps.map(({ chainOnly: _chainOnly, ...rest }) => rest) }, null, 2));
    return 0;
  }

  const out = styleFor(io, 'stdout', values);
  const err = styleFor(io, 'stderr', values);
  const s = explained.sale;
  const saleWords = s === null ? '' : `${s.name === null ? 'a sale' : clean(s.name)}, ${s.amount === null ? 'no amount' : money(s.amount, s.currency, definitions)}`;
  const headline = s === null ? `${type} ${id}` : type === 'transaction' && String(s.id) === id ? `${type} ${id} · ${saleWords}` : `${type} ${id} · transaction ${s.id}, ${saleWords}`;
  const width = out.width;
  const lines = [out.bold(out.rich ? hanging('', headline, '  ', width) : headline), '', ...(out.rich ? wrapWords(explained.summary, width - 2).map((line) => `  ${line}`) : [`  ${explained.summary}`])];
  if (steps.length > 0) {
    const labels = steps.map((one) => (one.type === null ? 'note' : `${one.type} ${one.id ?? ''}`.trim()));
    const labelWidth = Math.max(...labels.map((label) => label.length));
    const numberWidth = String(steps.length).length;
    lines.push('');
    for (const [at, one] of steps.entries()) {
      const lead = `  ${String(at + 1).padStart(numberWidth)}  ${labels[at]!.padEnd(labelWidth)}  `;
      if (!out.rich) {
        lines.push(`${lead}${one.text}`);
        continue;
      }
      const [first = '', ...rest] = wrapWords(one.text, Math.max(20, width - lead.length));
      lines.push(`  ${String(at + 1).padStart(numberWidth)}  ${out.bold(labels[at]!.padEnd(labelWidth))}  ${first}`, ...rest.map((line) => `${' '.repeat(lead.length)}${line}`));
    }
  }
  lines.push('', url);
  run.print(lines.join('\n'));
  const tip = (words: string) => io.stderr(`${err.rich ? err.dim(words) : words}\n`);
  if (explained.capped) tip('Siren cut this chain short, since the sale had more engagements than it reads at once.');
  if (!wantsChain && explained.steps.some((one) => one.chainOnly)) tip(`${run.command(`explain ${type} ${id} --chain`)} shows the whole chain, from the sale and every engagement that competed for it to the payout.`);
  return 0;
}
