import { CallbackAccessTokenSource } from '../../auth/callback-access-token-source';
import { createHttpTransport } from '../../client';
import { NotFoundError, SirenError } from '../../errors';
import { parseJsonBody } from '../../http';
import { contextOf } from '../context';
import type { CommandContext, CommandInput } from '../context';
import { currenciesFor, currencyScale, moneyText, resolveCurrencyDefinition, toShownAmount, toStoredAmount } from '../money';
import type { CurrencyDefinition } from '../money';
import { clean, styleFor, wrapWords } from '../style';
import { CliRefusal, CliUsageError } from '../targets';
import { readJsonObject } from './condition-sets';
import { TestActivityClient, orgLabel, simulationReport } from './trigger-client';

/*
 * `siren simulate`: a scenario run through the organization's own setup
 * that keeps nothing, on Siren's POST /simulations/scenario (Siren PR 1253).
 * It takes Beacon's scenario document, `{recipe?, actions}`, from a file or
 * standard input, or writes one from flags. Design:
 * review/cli-dx/simulate-redesign.md in the run folder.
 *
 * The tool never picks a participant. A sale needs --referred-by, a
 * --coupon, or --direct for a visit nobody referred, because any default
 * reads as "this person always earns".
 *
 * A Siren without the scenario route gets the older POST /simulations/sale
 * for a referred sale written from flags, and a clear refusal for anything
 * else.
 */

/** One `--line`: the fields Siren's sale_triggered takes for a line item. */
interface LineItem {
  name: string;
  description: string;
  type: string;
  quantity: number;
  value: number;
  attributes?: Record<string, unknown>;
}

interface Action {
  type: string;
  as: string;
  payload: Record<string, unknown>;
}

/** How many people a --referred-by search reads. */
const SEARCH_PAGE = 25;

/** The refusal when the registry can't be read, so a stored amount can't be worked out. */
function unreadCurrencies(what: string): CliRefusal {
  return new CliRefusal("The tool can't read this organization's currencies.", {
    why: `Siren answered no currency registry, so the tool can't tell how many decimal places ${what} has, and won't guess.`,
    fixText: 'Give each --line its amount as value= in stored units, such as value=2500 for $25.00, or try again in a moment.',
  });
}

const LINE_KEYS = ['name', 'sku', 'type', 'qty', 'price', 'value', 'category'];

/** `sku=TEE name="Tee shirt" qty=2 price=25.00` as its key and value pairs. */
function linePairs(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const rest = text.replace(/([A-Za-z]+)=("([^"]*)"|'([^']*)'|(\S+))/g, (_whole, key: string, _value, double?: string, single?: string, bare?: string) => {
    pairs.push([key, double ?? single ?? bare ?? '']);
    return '';
  });
  if (rest.trim() !== '') throw new CliUsageError(`--line takes key=value pairs, such as "sku=TEE qty=2 price=25.00", and ${JSON.stringify(rest.trim())} isn't one.`);
  return pairs;
}

/** A --line as a line item. `price` is in the currency's units, `value` in Siren's stored units. */
function lineOf(text: string, definition: CurrencyDefinition | undefined): LineItem {
  const fields = new Map<string, string>();
  for (const [key, value] of linePairs(text)) {
    if (!LINE_KEYS.includes(key)) throw new CliUsageError(`--line takes ${LINE_KEYS.join(', ')}, and ${key} isn't one.`);
    fields.set(key, value);
  }
  const quantity = fields.get('qty') ?? '1';
  if (!/^[1-9]\d*$/.test(quantity)) throw new CliUsageError(`qty takes a whole number of 1 or more, and ${JSON.stringify(quantity)} isn't one.`);
  const price = fields.get('price');
  const stored = fields.get('value');
  if (price !== undefined && stored !== undefined) throw new CliUsageError('A --line takes price or value, not both.');
  if (price === undefined && stored === undefined) throw new CliUsageError('A --line needs a price, such as price=25.00, or value=2500 in stored units.');
  if (price !== undefined && !/^-?\d+(\.\d+)?$/.test(price)) throw new CliUsageError(`price takes an amount such as 25.00, and ${JSON.stringify(price)} isn't one.`);
  if (stored !== undefined && !/^-?\d+$/.test(stored)) throw new CliUsageError(`value takes a whole number of stored units, such as 2500, and ${JSON.stringify(stored)} isn't one.`);
  const name = fields.get('name') ?? fields.get('sku') ?? 'Item';
  const attributes: Record<string, unknown> = {};
  if (fields.has('sku')) attributes.sku = fields.get('sku');
  if (fields.has('category')) attributes.categories = [fields.get('category')];
  return {
    name,
    description: name,
    type: fields.get('type') ?? 'product',
    quantity: Number(quantity),
    value: price !== undefined ? toStoredAmount(price, definition) : Number(stored),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
}

function transportOf(input: CommandInput, run: CommandContext) {
  return createHttpTransport({
    accessToken: new CallbackAccessTokenSource(
      () => run.accessToken(),
      () => run.refresh(),
    ),
    httpClient: input.io.httpClient,
    baseUrl: run.target.baseUrl,
  });
}

type Transport = ReturnType<typeof transportOf>;

/** The organization's currencies, read once an hour, or undefined. */
async function currencies(input: CommandInput, run: CommandContext, transport: Transport): Promise<CurrencyDefinition[] | undefined> {
  return currenciesFor(input.io.configDir, `${run.target.baseUrl} ${run.current().orgId}`, input.io.now(), async () => parseJsonBody(await transport.request({ method: 'GET', path: '/registries/currencies', retriable: true })));
}

/** The export key of the collaborator --referred-by names: an id, a key, or an email or name Siren finds once. */
async function collaboratorKey(given: string, signIn: () => Promise<Transport>): Promise<string> {
  if (/^\d+$/.test(given)) return `collaborator_${given}`;
  if (/^collaborator_\d+$/.test(given)) return given;
  const transport = await signIn();
  const body = await parseJsonBody(await transport.request({ method: 'GET', path: '/collaborators', query: { s: given, number: String(SEARCH_PAGE) }, retriable: true }));
  const items = (Array.isArray(body) ? body : typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : []) as Array<Record<string, unknown>>;
  const wanted = given.trim().toLowerCase();
  const same = (value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === wanted;
  // An email names one person. A name can name several, and a full page may hide another, so either asks for an email or id.
  const byEmail = items.filter((item) => same(item.email));
  if (byEmail.length === 1) return `collaborator_${clean(String(byEmail[0]!.id))}`;
  const found = items.filter((item) => same(item.fullName) || same(item.nickname) || same(item.name));
  if (found.length === 0) throw new CliRefusal(`No collaborator matches ${clean(given)}.`, { why: '--referred-by takes an id, an export key such as collaborator_12, or an email or name that names one person.', fixText: 'Check the spelling, or give the id siren collaborators list shows.' });
  if (found.length > 1 || items.length >= SEARCH_PAGE) {
    const why = found.length > 1 ? `${found.length} collaborators are named ${clean(given)}: ${found.map((item) => clean(String(item.id))).join(', ')}.` : `Siren found ${SEARCH_PAGE} or more people for ${clean(given)}, so another may have the same name.`;
    throw new CliRefusal(`${clean(given)} may not name one person.`, { why, fixText: 'Give their email or id with --referred-by.' });
  }
  return `collaborator_${clean(String(found[0]!.id))}`;
}

/** What the flags wrote, and whether the older sale route could run it. */
interface Written {
  document: { actions: Action[] };
  /** The collaborator id and total of a plain referred sale, which the older route can run. */
  plainSale?: { collaboratorId: number; total: number; definition: CurrencyDefinition | undefined };
}

/** The scenario the flags describe, or `CliRefusal` when they name nobody. */
async function writeScenario(input: CommandInput, signIn: () => Promise<Transport>, currencyOf: () => Promise<CurrencyDefinition | undefined>): Promise<Written> {
  const { values } = input;
  const referredBy = typeof values['referred-by'] === 'string' ? values['referred-by'] : undefined;
  const coupon = typeof values.coupon === 'string' ? values.coupon : undefined;
  const close = typeof values.close === 'string' ? values.close : undefined;
  const direct = values.direct === true;
  const lines = texts(values.line);
  if (referredBy !== undefined && direct) throw new CliUsageError('Give --referred-by or --direct, not both.');
  // Read every line first, so a typo is named before anything is sent.
  for (const line of lines) lineOf(line, undefined);
  const named = referredBy !== undefined || coupon !== undefined || direct;
  if (lines.length === 0 && named) throw new CliUsageError('Describe the sale with --line, such as --line "sku=TEE qty=2 price=25.00".');
  if (lines.length > 0 && !named) {
    throw new CliRefusal("Can't simulate a sale nobody referred.", {
      why: 'The tool never picks a collaborator, since any default reads as the one who always earns.',
      fixText: 'Name who referred it with --referred-by <id or email>, add the --coupon they gave, or pass --direct for a sale nobody referred.',
    });
  }
  if (lines.length === 0 && close === undefined) {
    throw new CliUsageError('Give a scenario file, or describe a sale with --referred-by and --line, or close a distributor with --close <id>.');
  }

  const actions: Action[] = [];
  let collaborator: string | undefined;
  let items: LineItem[] = [];
  let definition: CurrencyDefinition | undefined;
  if (lines.length > 0) {
    if (lines.some((line) => /(^|\s)price=/.test(line))) {
      definition = await currencyOf();
      if (definition === undefined) throw unreadCurrencies('price=');
    }
    items = lines.map((line) => lineOf(line, definition));
    collaborator = referredBy === undefined ? undefined : await collaboratorKey(referredBy, signIn);
    actions.push({ type: 'site_visited', as: 'visit', payload: collaborator === undefined ? {} : { collaborator } });
    if (coupon !== undefined) actions.push({ type: 'coupon_used', as: 'coupon', payload: { code: coupon, opportunity: '@visit' } });
    actions.push({ type: 'sale_triggered', as: 'sale', payload: { opportunity: '@visit', source: 'simulation', lineItems: items } });
  }
  if (close !== undefined) {
    if (!/^(?:distributor_)?\d+$/.test(close)) throw new CliUsageError(`--close takes a distributor's id or export key, such as 5 or distributor_5, and ${JSON.stringify(close)} isn't one.`);
    actions.push({ type: 'distribution_completed', as: 'close', payload: { distributorKey: close.startsWith('distributor_') ? close : `distributor_${close}` } });
  }
  const plain = collaborator !== undefined && coupon === undefined && close === undefined;
  return {
    document: { actions },
    ...(plain ? { plainSale: { collaboratorId: Number(collaborator!.slice('collaborator_'.length)), total: items.reduce((sum, item) => sum + item.value * item.quantity, 0), definition } } : {}),
  };
}

/**
 * `siren simulate [<scenario.json|->]`: runs the scenario, undoes every
 * write, and prints the transaction, conversions, obligations, why and what
 * was skipped. It changes nothing, so a live organization serves it
 * without `--live`.
 */
export async function simulate(input: CommandInput): Promise<number> {
  const { values, io } = input;
  const run = contextOf(input);
  const given = input.args[0];
  const flagged = ['referred-by', 'coupon', 'close', 'line', 'direct'].some((flag) => values[flag] !== undefined);
  if (given !== undefined && flagged) throw new CliUsageError('Give a scenario file or flags that write one, not both. --print-scenario shows what the flags write.');

  let transport: Transport | undefined;
  const signIn = async () => {
    if (transport === undefined) {
      await run.signedIn();
      transport = transportOf(input, run);
    }
    return transport;
  };
  let definitions: CurrencyDefinition[] | undefined;
  let read = false;
  const registry = async () => {
    if (!read) {
      definitions = await currencies(input, run, await signIn());
      read = true;
    }
    return definitions;
  };

  const written = given === undefined ? await writeScenario(input, signIn, async () => resolveCurrencyDefinition(null, await registry())) : undefined;
  const document = written?.document ?? (await readJsonObject(input, given!, 'a scenario', 'actions, a list, and a recipe if you want one'));
  if (values['print-scenario'] === true) {
    io.stdout(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
  }

  const http = await signIn();
  let result: Record<string, unknown>;
  try {
    // A 422 carries the whole result with each recipe problem in validation.errors, so it is an answer to print.
    result = (await parseJsonBody(await http.request({ method: 'POST', path: '/simulations/scenario', body: document, retriable: false, answers: [422] }))) as Record<string, unknown>;
  } catch (error) {
    const missing = error instanceof NotFoundError && /^(?:siren: )?not found\.?$/i.test(error.message.trim());
    if (missing && written?.plainSale !== undefined) return olderSale(input, run, written.plainSale, async () => resolveCurrencyDefinition(null, await registry()));
    if (missing) {
      throw new CliRefusal("This Siren doesn't have scenario simulation yet.", {
        why: 'It answers no /simulations/scenario route. Its older sale simulation takes one referred sale from --referred-by and --line, and no file, coupon or close.',
        fixText: 'Run a referred sale from flags here, or point the tool at a newer Siren with --base-url.',
      });
    }
    if (error instanceof SirenError && error.statusCode !== undefined) {
      throw new CliRefusal(error.statusCode === 501 ? "This Siren can't simulate here." : 'Siren refused the scenario.', {
        why: clean(error.message.replace(/^Siren: /, '')),
        fixText: error.statusCode === 501 ? 'Simulate on Siren Cloud, which undoes the run.' : 'Fix the scenario, then run it again. --print-scenario shows what the flags write.',
        detail: [`HTTP status: ${error.statusCode}`],
      });
    }
    throw error;
  }

  const invalid = ((result.validation ?? {}) as { valid?: unknown }).valid === false;
  const failed = invalid || (Array.isArray(result.actions) && result.actions.some((action) => typeof action === 'object' && action !== null && typeof (action as { error?: unknown }).error === 'string'));
  if (values.json === true) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return failed ? 1 : 0;
  }
  const report = scenarioReport(orgLabel(run), result, holdsMoneyIn(result) ? await registry() : undefined);
  io.stdout(`${report.join('\n')}\n`);
  return failed ? 1 : 0;
}

/** A referred sale on a Siren with only the older route: one total, through POST /simulations/sale. */
async function olderSale(input: CommandInput, run: CommandContext, sale: NonNullable<Written['plainSale']>, currencyOf: () => Promise<CurrencyDefinition | undefined>): Promise<number> {
  // The older route takes the total in the currency's units, so value= lines need the organization's scale.
  const definition = sale.definition ?? (await currencyOf());
  if (definition === undefined) throw unreadCurrencies('the total');
  const amount = toShownAmount(sale.total, definition).toFixed(currencyScale(definition));
  input.io.stderr('siren: This Siren has no scenario simulation, so this is its older sale simulation: one total, with no line items.\n');
  const answer = await new TestActivityClient(run).simulate({ collaboratorId: sale.collaboratorId, amount });
  if (input.values.json === true) input.io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
  else input.io.stdout(simulationReport(styleFor(input.io, 'stdout', {}), run, answer));
  return 0;
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)) : [];
}

function holdsMoneyIn(result: Record<string, unknown>): boolean {
  const ledgers = (result.ledgers ?? {}) as Record<string, unknown>;
  return list(ledgers.transactions).length > 0 || list(ledgers.obligations).length > 0 || list(result.distributions).length > 0;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function and(parts: readonly string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Siren's code as words: `awaiting_conversion_approval` as `awaiting conversion approval`. */
function words(code: unknown): string {
  return clean(String(code ?? '')).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
}

function capital(text: string): string {
  return text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** Rows whose columns line up, two spaces apart, the last column as long as it is. */
function aligned(rows: ReadonlyArray<readonly string[]>, indent = '  '): string[] {
  const widths: number[] = [];
  for (const row of rows) row.slice(0, -1).forEach((cell, at) => (widths[at] = Math.max(widths[at] ?? 0, [...cell].length)));
  return rows.map((row) => `${indent}${row.map((cell, at) => (at < row.length - 1 ? cell.padEnd(widths[at]!) : cell)).join('  ')}`.trimEnd());
}

/** Text wrapped inside 80 columns under `indent`. */
function wrapped(text: string, indent = '  '): string[] {
  return wrapWords(clean(text), 80 - indent.length).map((line) => `${indent}${line}`);
}

/** The run as Siren's screens say it: transaction, conversions, obligations, why, skipped, distributions, failures. */
export function scenarioReport(org: string, result: Record<string, unknown>, definitions: CurrencyDefinition[] | undefined): string[] {
  const ledgers = (result.ledgers ?? {}) as Record<string, unknown>;
  const transactions = list(ledgers.transactions);
  const conversions = list(ledgers.conversions);
  const obligations = list(ledgers.obligations);
  const distributions = list(result.distributions);
  const money = (amount: unknown, units: unknown) => moneyText(amount, typeof units === 'string' ? units : null, definitions) ?? clean(String(amount ?? ''));
  const lines: string[] = [];

  if (transactions.length > 0) {
    const items = transactions.flatMap((transaction) => list(transaction.lineItems));
    const units = items.find((item) => typeof item.units === 'string')?.units;
    const total = items.reduce((sum, item) => sum + Number(item.value ?? 0) * Number(item.quantity ?? 1), 0);
    const sale = transactions.length === 1 ? `A ${money(total, units)} sale` : `${transactions.length} sales of ${money(total, units)} in all`;
    const made = and([plural(transactions.length, 'transaction'), plural(conversions.length, 'conversion'), plural(obligations.length, 'obligation')]);
    lines.push(...wrapped(`${sale} in ${org}, would make ${made}.`, ''));
  } else if (distributions.length === 0) {
    lines.push(...wrapped(`The scenario would make nothing in ${org}.`, ''));
  }

  for (const transaction of transactions) {
    lines.push('', `Transaction ${clean(String(transaction.id ?? ''))}`);
    lines.push(
      ...aligned(
        list(transaction.lineItems).map((item) => {
          const quantity = Number(item.quantity ?? 1);
          return [clean(String(item.name ?? 'Item')), `${quantity} x ${money(item.value, item.units)}`, money(Number(item.value ?? 0) * quantity, item.units)];
        }),
      ),
    );
    const units = list(transaction.lineItems).find((item) => typeof item.units === 'string')?.units;
    for (const program of list(transaction.programs)) {
      const rate = program.percent === null || program.percent === undefined ? '' : `, at ${clean(String(program.percent))}%`;
      lines.push(...wrapped(`${clean(String(program.programName ?? 'A program'))} counted ${money(program.baseAmount, units)} of it${rate}.`));
      for (const line of list(program.lines)) {
        if (line.counted === true) continue;
        lines.push(...wrapped(`${clean(String(line.name ?? 'A line'))}: ${clean(String(line.message ?? words(line.reason)))}`, '    '));
      }
    }
  }

  if (conversions.length > 0) {
    lines.push('', 'Conversions');
    lines.push(...aligned(conversions.map((conversion) => [clean(String(conversion.collaboratorName ?? 'Nobody')), clean(String(conversion.programName ?? '')), capital(words(conversion.status))])));
  }
  if (obligations.length > 0) {
    lines.push('', 'Obligations');
    lines.push(
      ...aligned(
        obligations.map((obligation) => {
          const state = capital(words(obligation.status));
          const hold = obligation.holdReason ? `, ${words(obligation.holdReason)}` : '';
          return [money(obligation.value, obligation.awardType ?? obligation.units), `owed to ${clean(String(obligation.collaboratorName ?? 'nobody'))}`, `${state}${hold}`];
        }),
      ),
    );
  }

  for (const distribution of distributions) {
    const name = clean(String(distribution.distributorName ?? `distributor ${distribution.distributorId ?? ''}`));
    const pot = (distribution.pot ?? {}) as Record<string, unknown>;
    const units = distribution.units;
    lines.push('');
    if (distribution.closed === true) {
      lines.push(...wrapped(`Closing ${name} would pay out ${money(distribution.allocated ?? 0, units)} of a ${money(pot.value ?? 0, units)} pot.`, transactions.length > 0 ? '' : ''));
    } else {
      lines.push(...wrapped(`${name}'s open period, as it stands with this scenario's activity:`, ''));
    }
    lines.push(
      ...aligned(
        list(distribution.recipients).map((recipient) => {
          const outcome = recipient.outcome === 'nothing' ? `nothing: ${clean(String(recipient.message ?? words(recipient.reason)))}` : clean(String(recipient.outcome ?? ''));
          return recipient.outcome === 'nothing' ? [clean(String(recipient.collaboratorName ?? '')), outcome] : [clean(String(recipient.collaboratorName ?? '')), money(recipient.amount, units), outcome];
        }),
      ).flatMap((line) => ([...line].length <= 80 ? [line] : wrapWords(line.trim(), 76).map((part, at) => (at === 0 ? `  ${part}` : `      ${part}`)))),
    );
    const left = Number(distribution.unallocated ?? 0);
    if (distribution.closed === true && left > 0) lines.push(...wrapped(`${money(left, units)} stays in the pot.`));
  }

  const why = list(result.why);
  if (why.length > 0) lines.push('', 'Why', ...why.flatMap((entry) => wrapped(String(entry.message ?? ''))));
  const skipped = list(result.skipped);
  if (skipped.length > 0) lines.push('', 'Skipped', ...skipped.flatMap((entry) => wrapped(String(entry.message ?? ''))));

  const failures = list(result.actions)
    .map((action, at) => ({ action, at }))
    .filter(({ action }) => typeof action.error === 'string');
  if (failures.length > 0) {
    lines.push('', 'Actions Siren refused');
    for (const { action, at } of failures) lines.push(...wrapped(`Action ${at + 1}, ${clean(String(action.label ?? ''))} (${clean(String(action.type ?? ''))}): ${clean(String(action.error))}`));
  }
  const errors = ((result.validation ?? {}) as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const row = (problem: unknown) => {
      if (typeof problem === 'string') return problem;
      const { path, message } = (problem ?? {}) as { path?: unknown; message?: unknown };
      return typeof message === 'string' ? `${typeof path === 'string' && path !== '' ? `${path}: ` : ''}${message}` : JSON.stringify(problem);
    };
    lines.push('', 'Recipe problems', ...errors.flatMap((problem) => wrapped(row(problem))));
  }

  lines.push('', 'Nothing was written.');
  return lines;
}
