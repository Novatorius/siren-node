/*
 * Siren's own checks on an app's answer, so `answers.simulate()` refuses
 * in a test what Siren's answer route would refuse with 422
 * `app_answer_invalid`, in Siren's words. Each rule is ported from Siren's
 * feat/apps at 6d2abd936a, and the file and method sit beside it. The live
 * handler does not run these: it posts the answer, and Siren decides.
 *
 * Siren decodes the answer with PHP's json_decode into arrays, so a JSON
 * object and a JSON list are both "arrays" to it, and a list is an array
 * whose keys run 0, 1, 2 and on. The helpers below read a value as PHP
 * does. Two checks need Siren's own records and are left to Siren: whether
 * a collaborator in a calculation's results is still in the organization,
 * and whether a collaborator group was too large to ask about. Keys are
 * read in JavaScript's order, which puts whole-number keys first, so when
 * an answer breaks two key rules at once the message may name another key
 * than Siren's.
 */

/** The most bytes of JSON Siren takes as an answer (AppRequestService::MAX_ANSWER_BYTES). */
const MAX_ANSWER_BYTES = 16384;
/** The most results a calculation's answer holds (AppMetricCalculationAnswerHandler::MAX_RESULTS, AppEngagementCalculationAnswerHandler::MAX_RESULTS). */
const MAX_RESULTS = 50;
/** The longest reason a filter's suppress answer gives (AppMetricFilterAnswerHandler::MAX_REASON, AppEngagementFilterAnswerHandler::MAX_REASON). */
const MAX_FILTER_REASON = 200;
/** The longest payout reference and failure reason (AppPayoutQuestion::MAX_REFERENCE, MAX_REASON). */
const MAX_REFERENCE = 191;
const MAX_PAYOUT_REASON = 500;

type Rule = (question: Record<string, unknown>, answer: Record<string, unknown>) => string | undefined;

/**
 * Why Siren refuses `answer` to a `kind` ask about `question`, in Siren's
 * words, or undefined when Siren takes it. `answer` is the answer as JSON
 * would send it. A kind Siren has no rule for here is left to Siren.
 */
export function sirenAnswerProblem(kind: string, question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  // AppRequestService::answer(): the size, before the kind's own check.
  if (phpJsonLength(answer) > MAX_ANSWER_BYTES) return `The answer is larger than ${MAX_ANSWER_BYTES} bytes of JSON.`;
  const rule = Object.prototype.hasOwnProperty.call(RULES, kind) ? RULES[kind] : undefined;
  return rule?.(question, answer);
}

const RULES: Record<string, Rule> = {
  distributionResolver: distributionProblem,
  incentiveResolver: rewardProblem,
  incentiveType: incentiveTypeProblem,
  payoutMethod: (_question, answer) => payoutProblem(answer),
  metricCalculation: (_question, answer) => resultsProblem(answer, 'scores'),
  engagementCalculation: (_question, answer) => resultsProblem(answer, 'engagements'),
  metricFilter: (_question, answer) => filterProblem(answer),
  engagementFilter: (_question, answer) => filterProblem(answer),
  programGroupSorter: groupOrderProblem,
  transactionFilter: transactionFilterProblem,
  collaboratorGroupStructure: groupStructureProblem,
};

/** lib/Apps/Service/Resolvers/AppDistributionQuestion.php, unfitness(), rules 1 to 9. */
function distributionProblem(question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  const offer = field(question, 'pool');
  const units = phpString(field(offer, 'units') ?? '');
  const currency = field(offer, 'currency');
  const asked = rows(question, 'metrics').map((row) => phpInt(field(row, 'metricId')));

  if (answer.outcome !== 'allocated') return 'outcome must be allocated';
  if (answer.units !== units) return `units must be ${units}, the units of the pool`;
  const shares = answer.shares;
  if (!isPhpArray(shares)) return 'shares must be an object of metric id to amount';
  const pairs = entries(shares);
  for (const [metricId] of pairs) {
    if (!asked.includes(keyInt(metricId)) || !isIntKey(metricId)) return `shares names metric ${metricId}, which this distribution does not hold`;
  }
  for (const [metricId, amount] of pairs) {
    if (!isInt(amount)) return `the share for metric ${metricId} must be a whole number of the smallest unit`;
  }
  for (const [metricId, amount] of pairs) {
    if ((amount as number) < 0) return `the share for metric ${metricId} must not be below 0`;
  }
  const scale = phpInt(field(currency, 'scale') ?? 0);
  const places = phpInt(field(currency, 'decimalPlaces') ?? scale);
  const step = 10 ** Math.max(0, scale - places);
  for (const [metricId, amount] of pairs) {
    if ((amount as number) % step !== 0) {
      return `the share for metric ${metricId} must be a multiple of ${step}, as ${units} amounts have no smaller part`;
    }
  }
  const held = new Set(pairs.map(([metricId]) => metricId));
  for (const metricId of asked) {
    if (!held.has(String(metricId))) return `shares has no amount for metric ${metricId}, and every metric needs one, 0 included`;
  }
  const sum = pairs.reduce((total, [, amount]) => total + (amount as number), 0);
  const pool = phpInt(field(offer, 'value') ?? 0);
  if (sum > pool) return `the shares add up to ${sum}, more than the pool of ${pool}`;
  return undefined;
}

/** lib/Apps/Service/Rewards/AppRewardQuestion.php, validate() and conversionIds(). */
function rewardProblem(question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  if (answer.outcome !== 'rewards') return 'The answer\'s outcome must be "rewards".';
  const units = phpString(field(field(question, 'pool'), 'units') ?? '');
  if (answer.units !== units) return `The answer's units must be "${units}", the units of the pool Siren offered.`;
  const rewards = answer.rewards;
  if (!isPhpArray(rewards) || (entries(rewards).length > 0 && isPhpList(rewards))) {
    return "The answer's rewards must be an object with one key per conversion id in the question.";
  }
  const asked = idsOf(question, 'conversions', 'conversionId');
  const pool = phpInt(field(field(question, 'pool'), 'value') ?? 0);
  const pairs = entries(rewards);
  for (const [key, value] of pairs) {
    if (!asked.includes(keyInt(key)) || !isIntKey(key)) return `The answer names conversion ${key}, which the question does not hold.`;
    if (value !== null && (!isInt(value) || value < 0)) {
      return `The reward for conversion ${key} must be null or a whole number at or above 0, in the stored integer form.`;
    }
    if (value !== null && (value as number) > pool) return `The reward for conversion ${key} is ${value as number}, more than the pool of ${pool} Siren offered.`;
  }
  const held = new Set(pairs.map(([key]) => key));
  for (const id of asked) {
    if (!held.has(String(id))) {
      return `The answer has no reward for conversion ${id}. Give every conversion of the question a key, null for one the app did not choose.`;
    }
  }
  return undefined;
}

/** lib/Apps/Service/IncentiveTypes/AppIncentiveTypeQuestion.php, validate() and askedEngagementIds(). */
function incentiveTypeProblem(question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  const outcome = answer.outcome;
  if (outcome === 'none') {
    const extra = Object.keys(answer).filter((key) => key !== 'outcome');
    return extra.length === 0 ? undefined : `An answer of "none" carries nothing else, and this one has ${extra.join(', ')}.`;
  }
  if (outcome !== 'award') return 'The answer\'s outcome must be "award" or "none".';
  const units = phpString(field(field(question, 'program'), 'units') ?? '');
  if (answer.units !== units) return `The answer's units must be "${units}", the program's units.`;
  if (!isInt(answer.pool) || answer.pool < 0) return "The answer's pool must be a whole number at or above 0, in the stored integer form.";
  const ids = answer.engagementIds;
  if (!isPhpArray(ids) || !isPhpList(ids) || entries(ids).length === 0) {
    return "The answer's engagementIds must be a list of at least one engagement id from the question.";
  }
  const asked = idsOf(question, 'engagements', 'engagementId');
  const seen = new Set<number>();
  for (const [, id] of entries(ids)) {
    if (!isInt(id) || !asked.includes(id)) {
      return `The answer names engagement ${isScalar(id) ? phpString(id) : JSON.stringify(id)}, which the question does not hold.`;
    }
    if (seen.has(id)) return `The answer names engagement ${id} more than once.`;
    seen.add(id);
  }
  const extra = Object.keys(answer).filter((key) => !['outcome', 'units', 'pool', 'engagementIds'].includes(key));
  return extra.length === 0 ? undefined : `The answer has fields Siren does not read: ${extra.join(', ')}.`;
}

/** lib/Apps/Service/Payouts/AppPayoutQuestion.php, validate(). */
function payoutProblem(answer: Record<string, unknown>): string | undefined {
  const outcome = answer.outcome;
  if (outcome === 'paid') {
    const reference = answer.reference;
    if (typeof reference !== 'string' || phpTrim(reference) === '') return 'A paid answer names the payment\'s reference in your system, as "reference".';
    if (characters(phpTrim(reference)) > MAX_REFERENCE) return `A reference is at most ${MAX_REFERENCE} characters.`;
    return undefined;
  }
  if (outcome === 'failed') {
    const reason = answer.reason;
    if (typeof reason !== 'string' || phpTrim(reason) === '') return 'A failed answer says why in plain words, as "reason".';
    if (characters(phpTrim(reason)) > MAX_PAYOUT_REASON) return `A reason is at most ${MAX_PAYOUT_REASON} characters.`;
    return undefined;
  }
  return 'The outcome is "paid" or "failed".';
}

/**
 * lib/Apps/Service/Handlers/AppMetricCalculationAnswerHandler.php and
 * lib/Apps/Service/Engagements/AppEngagementCalculationAnswerHandler.php,
 * validate(), which differ only in the outcome. Whether each collaborator
 * is still in the organization is left to Siren.
 */
function resultsProblem(answer: Record<string, unknown>, outcome: 'scores' | 'engagements'): string | undefined {
  if (answer.outcome !== outcome) return `outcome must be ${outcome}.`;
  const results = answer.results;
  if (!isPhpArray(results) || !isPhpList(results)) return 'results must be a list of {collaboratorId, score}.';
  const list = entries(results);
  if (list.length > MAX_RESULTS) return `results may hold at most ${MAX_RESULTS} entries, and this holds ${list.length}.`;
  const seen = new Set<number>();
  for (const [i, result] of list) {
    const collaboratorId = isPhpArray(result) ? field(result, 'collaboratorId') : undefined;
    const score = isPhpArray(result) ? field(result, 'score') : undefined;
    if (!isInt(collaboratorId) || collaboratorId < 1) return `results[${i}].collaboratorId must be a collaborator id.`;
    if (!isInt(score) || score < 0) return `results[${i}].score must be a whole number of 0 or more.`;
    if (seen.has(collaboratorId)) return `results names collaborator ${collaboratorId} more than once.`;
    seen.add(collaboratorId);
  }
  return undefined;
}

/**
 * lib/Apps/Service/Handlers/AppMetricFilterAnswerHandler.php and
 * lib/Apps/Service/Engagements/AppEngagementFilterAnswerHandler.php,
 * validate(), which are the same.
 */
function filterProblem(answer: Record<string, unknown>): string | undefined {
  const outcome = answer.outcome;
  if (outcome === 'allow') return undefined;
  if (outcome !== 'suppress') return 'outcome must be allow or suppress.';
  const reason = answer.reason;
  if (typeof reason !== 'string' || phpTrim(reason) === '') return 'A suppress answer gives a reason, in plain text.';
  const length = characters(reason);
  if (length > MAX_FILTER_REASON) return `reason may be at most ${MAX_FILTER_REASON} characters, and this is ${length}.`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]|<[^>]*>/u.test(reason)) return 'reason must be plain text, with no markup or control characters.';
  return undefined;
}

/** lib/Apps/Service/GroupOrders/AppGroupOrderQuestion.php, validate() and programIds(). */
function groupOrderProblem(question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  if (answer.outcome !== 'sorted') return 'outcome must be sorted.';
  const order = answer.programIds;
  if (!isPhpArray(order) || !isPhpList(order)) return "programIds must be a list of the question's program ids.";
  const asked = idsOf(question, 'programs', 'id');
  const seen = new Set<number>();
  for (const [, id] of entries(order)) {
    if (!isInt(id)) return 'Each program id is a whole number.';
    if (!asked.includes(id)) return `Program ${id} is not one of the programs Siren asked about.`;
    if (seen.has(id)) return `Program ${id} is listed more than once.`;
    seen.add(id);
  }
  const missing = asked.find((id) => !seen.has(id));
  return missing === undefined ? undefined : `The answer leaves out program ${missing}. List every program Siren asked about.`;
}

/** lib/Apps/Service/TransactionFilters/AppTransactionFilterQuestion.php, validate() and lineIds(). */
function transactionFilterProblem(question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  if (answer.outcome !== 'filtered') return 'The answer\'s outcome must be "filtered".';
  const include = answer.include;
  if (!isPhpArray(include) || !isPhpList(include)) return "The answer's include must be a list of line ids from the question.";
  const asked = idsOf(question, 'lines', 'id');
  const seen = new Set<number>();
  for (const [, id] of entries(include)) {
    if (!isInt(id)) return "Each id in the answer's include must be a whole number, a line id from the question.";
    if (!asked.includes(id)) return `The answer includes line ${id}, which is not a line of the sale Siren asked about.`;
    if (seen.has(id)) return `The answer includes line ${id} more than once.`;
    seen.add(id);
  }
  return undefined;
}

/**
 * lib/Apps/Service/Handlers/AppGroupStructureAnswerHandler.php, problem(),
 * chainProblem() and treeProblem(), with the members of
 * lib/Apps/Service/Items/AppGroupStructureQuestion.php, memberIds().
 */
function groupStructureProblem(question: Record<string, unknown>, answer: Record<string, unknown>): string | undefined {
  if (answer.outcome !== 'structure') return 'outcome must be structure.';
  const members = [
    ...new Set(
      rows(question, 'members')
        .map((member) => field(member, 'collaboratorId'))
        .filter(isInt),
    ),
  ];
  if (answer.shape === 'chain') return chainProblem(answer.order, members);
  if (answer.shape === 'tree') return treeProblem(answer.parents, members);
  return 'shape must be chain or tree.';
}

function chainProblem(order: unknown, members: number[]): string | undefined {
  if (!isPhpArray(order) || !isPhpList(order)) return "order must be a list of the members' collaborator ids, top first.";
  const seen = new Set<number>();
  for (const [i, collaboratorId] of entries(order)) {
    if (!isInt(collaboratorId)) return `order[${i}] must be a collaborator id.`;
    if (!members.includes(collaboratorId)) return `order[${i}] names collaborator ${collaboratorId}, who is not a member in the question.`;
    if (seen.has(collaboratorId)) return `order names collaborator ${collaboratorId} more than once.`;
    seen.add(collaboratorId);
  }
  const missing = members.find((id) => !seen.has(id));
  return missing === undefined ? undefined : `order leaves out member ${missing}. List every member of the question once.`;
}

function treeProblem(parents: unknown, members: number[]): string | undefined {
  if (!isPhpArray(parents)) return "parents must be an object of each member's collaborator id to its parent's, or null at the top.";
  const parentOf = new Map<number, number | null>();
  for (const [key, parentId] of entries(parents)) {
    // FILTER_VALIDATE_INT: an optional sign and no leading zero.
    const collaboratorId = /^[+-]?(0|[1-9]\d*)$/.test(key.trim()) ? Number(key.trim()) : undefined;
    if (collaboratorId === undefined || !members.includes(collaboratorId)) return `parents names ${key}, which is not a member in the question.`;
    if (parentId !== null && !isInt(parentId)) return `parents["${collaboratorId}"] must be a member's collaborator id or null.`;
    if (parentId !== null && !members.includes(parentId as number)) {
      return `parents["${collaboratorId}"] names collaborator ${parentId as number}, who is not a member in the question.`;
    }
    if (parentId === collaboratorId) return `parents["${collaboratorId}"] names the member as their own parent.`;
    parentOf.set(collaboratorId, parentId as number | null);
  }
  const missing = members.find((id) => !parentOf.has(id));
  if (missing !== undefined) return `parents leaves out member ${missing}. Name every member of the question once, with null at the top.`;
  // Each walk up ends at the top or at a member already known to end there. A walk that meets itself is a cycle.
  const endsAtTop = new Set<number>();
  for (const start of parentOf.keys()) {
    const path = new Set<number>();
    let at: number | null = start;
    while (at !== null && !endsAtTop.has(at)) {
      if (path.has(at)) return `parents form a cycle through member ${at}. Every member must reach the top.`;
      path.add(at);
      at = parentOf.get(at) ?? null;
    }
    for (const member of path) endsAtTop.add(member);
  }
  return undefined;
}

/** Whether PHP's json_decode makes `value` an array: a JSON object or list. */
function isPhpArray(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/** PHP's array_is_list(): a list, or an object whose keys run "0", "1", "2" and on. */
function isPhpList(value: Record<string, unknown> | unknown[]): boolean {
  if (Array.isArray(value)) return true;
  return Object.keys(value).every((key, i) => key === String(i));
}

/** An array's keys and values, a list's keys as text. */
function entries(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
}

/** PHP's `$array['name'] ?? null` on a value that may not be an array. */
function field(value: unknown, name: string): unknown {
  if (!isPhpArray(value) || Array.isArray(value)) return undefined;
  return value[name] ?? undefined;
}

/** PHP's `(array) $question['name']`, as a list of its rows. */
function rows(value: unknown, name: string): unknown[] {
  const found = field(value, name);
  return isPhpArray(found) ? entries(found).map(([, row]) => row) : [];
}

/** The `(int)` of `column` in each row of `value[name]` that is an array and sets it, as the question classes read ids. */
function idsOf(value: unknown, name: string, column: string): number[] {
  return rows(value, name)
    .filter((row) => isPhpArray(row) && field(row, column) !== undefined && field(row, column) !== null)
    .map((row) => phpInt(field(row, column)));
}

/** Whether PHP's json_decode makes `value` an int: a whole JSON number in PHP's integer range. */
function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/** Whether `(string) (int) $key === (string) $key`, the question classes' test for an id key. */
function isIntKey(key: string): boolean {
  return /^(0|-?[1-9]\d*)$/.test(key);
}

/** `(int) $key` for a key the question classes compare with their ids. */
function keyInt(key: string): number {
  return isIntKey(key) ? Number(key) : Number.parseInt(key, 10) || 0;
}

/** PHP's `(int)` of a question's value. */
function phpInt(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** PHP's `(string)` of a scalar. */
function phpString(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '';
  return String(value);
}

/** PHP's trim(), which takes spaces, tabs, line breaks, NUL and vertical tabs from both ends. */
function phpTrim(text: string): string {
  return text.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** mb_strlen(): the characters, not the UTF-16 units. */
function characters(text: string): number {
  return [...text].length;
}

/**
 * strlen(json_encode($answer)) on Siren: PHP's default flags write `/` as
 * `\/` and each character past ASCII as a `\uXXXX` escape per UTF-16 unit.
 */
function phpJsonLength(answer: Record<string, unknown>): number {
  let length = 0;
  for (const unit of JSON.stringify(answer)) {
    for (let i = 0; i < unit.length; i += 1) {
      const code = unit.charCodeAt(i);
      length += code > 0x7f ? 6 : unit[i] === '/' ? 2 : 1;
    }
  }
  return length;
}
