import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { styleFor } from '../style';
import { CliRefusal } from '../targets';
import { appKeyArgument } from './apply';
import type { NextStep } from '../style';
import { TestActivityClient, activityBody, activityNext, activityRows, askAndWait, assertSandbox, cleaned, confirmLiveAsk, eventName, orgLabel, triggerAndWait, waitSeconds } from './trigger-client';
import { ASK_WAIT_SECONDS, TRIGGER_WAIT_SECONDS, featureKeyArgument } from './trigger';

/*
 * `siren fixtures <file.json>`: an ordered list of trigger steps, each able
 * to read an earlier step's answer. Stripe's fixture format, with Siren's
 * trigger names in place of HTTP paths. Contract:
 * contract/devtools-trigger.md in the run folder, section 4.
 */

/** One step of a fixture file. `params` takes the flags' names. */
export interface FixtureStep {
  name: string;
  trigger: string;
  params: Record<string, unknown>;
}

/** The most steps one file may hold, so a file can't send Siren an endless run. */
const MAX_STEPS = 100;

/** `${name:path}` or `${.env:NAME}`. */
const REFERENCE = /\$\{([^}:]+):([^}]*)\}/g;
const WHOLE = /^\$\{([^}:]+):([^}]*)\}$/;

/** Reads and checks the file, or `CliRefusal` naming the first problem's place. */
export function parseFixtures(text: string, path: string): FixtureStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliRefusal(`${path} is not JSON.`, { why: error instanceof Error ? error.message : String(error) });
  }
  const list = (parsed as { fixtures?: unknown } | null)?.fixtures;
  if (!Array.isArray(list) || list.length === 0) throw new CliRefusal(`${path} has no steps.`, { why: 'It needs a "fixtures" list with at least one step.' });
  if (list.length > MAX_STEPS) throw new CliRefusal(`${path} has ${list.length} steps.`, { why: `A file may hold at most ${MAX_STEPS}.` });
  const names = new Set<string>();
  return list.map((raw, at) => {
    const step = raw as Partial<FixtureStep> | null;
    const where = `fixtures.${at}`;
    if (step === null || typeof step !== 'object') throw new CliRefusal(`${where} is not an object.`);
    if (typeof step.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(step.name)) {
      throw new CliRefusal(`${where}.name is missing or not a name.`, { why: 'Each step needs a name of letters, digits, dashes and underscores, so later steps can read its answer.' });
    }
    if (names.has(step.name)) throw new CliRefusal(`${where}.name repeats ${JSON.stringify(step.name)}.`, { why: 'Each step needs its own name.' });
    names.add(step.name);
    if (typeof step.trigger !== 'string' || step.trigger === '') throw new CliRefusal(`${where}.trigger is missing.`, { why: 'Use sale, refund, visit, ask or a custom event\'s slug.' });
    const params = step.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) throw new CliRefusal(`${where}.params is not an object.`);
    return { name: step.name, trigger: step.trigger, params: params as Record<string, unknown> };
  });
}

/** The value at a dotted path, or undefined. A number part reads a list. */
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path === '' ? [] : path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Every reference in `value` filled in. A string that is one whole
 * reference takes the value's own type. A reference inside other text is
 * filled in as text. A reference to a step or path that does not exist is
 * `CliRefusal`.
 */
export function resolveReferences(value: unknown, results: ReadonlyMap<string, unknown>, env: Readonly<Record<string, string | undefined>>, where: string): unknown {
  const lookup = (name: string, path: string, reference: string): unknown => {
    if (name === '.env') {
      const found = env[path];
      if (found === undefined) throw new CliRefusal(`${where} reads ${reference}, and ${path} is not set.`, { why: 'Set it in the environment, or change the step.' });
      return found;
    }
    if (!results.has(name)) throw new CliRefusal(`${where} reads ${reference}, and no step before it is named ${JSON.stringify(name)}.`, { why: 'A step can read only the steps above it.' });
    const found = at(results.get(name), path);
    if (found === undefined) throw new CliRefusal(`${where} reads ${reference}, and step ${JSON.stringify(name)} answered nothing at ${path}.`);
    return found;
  };
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(whole[1]!, whole[2]!, value);
    return value.replace(REFERENCE, (reference, name: string, path: string) => {
      const found = lookup(name, path, reference);
      return typeof found === 'object' && found !== null ? JSON.stringify(found) : String(found);
    });
  }
  if (Array.isArray(value)) return value.map((one, index) => resolveReferences(one, results, env, `${where}.${index}`));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, resolveReferences(one, results, env, `${where}.${key}`)]));
  }
  return value;
}

/**
 * Runs the file's steps in order and stops at the first refusal, having
 * printed each step it finished. A file of asks alone follows the live
 * guard of `trigger ask`, step by step: an ask step's app and feature keys
 * are checked as that command checks them, a payout method is refused, and
 * any other kind is asked about unless `--yes`. Any other step needs a
 * sandbox, checked before anything is sent.
 */
export async function fixtures(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const json = values.json === true;
  const path = resolve(io.cwd, input.args[0]!);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new CliRefusal(`The tool could not read ${input.args[0]}.`, { why: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'There is no such file.' : String(error) });
  }
  const steps = parseFixtures(text, input.args[0]!);

  const run = contextOf(input);
  if (steps.some((step) => step.trigger !== 'ask')) await assertSandbox(run, 'fixtures');
  await run.signedIn();
  const client = new TestActivityClient(run);
  const style = styleFor(io, 'stdout', {});
  const results = new Map<string, unknown>();
  const done: Array<{ name: string; trigger: string; result: unknown }> = [];
  let next: NextStep[] = [];

  for (const [index, step] of steps.entries()) {
    const params = resolveReferences(step.params, results, io.env, `fixtures.${index}.params`) as Record<string, unknown>;
    let result: unknown;
    let line: string;
    if (step.trigger === 'ask') {
      const app = appKeyArgument(String(params.app ?? ''));
      const feature = featureKeyArgument(String(params.feature ?? ''));
      await confirmLiveAsk(run, io, client, app, feature, values.yes === true, `fixtures ${input.args[0]} --live --yes`);
      const request = await askAndWait(client, io, app, feature, waitSeconds(params.wait, ASK_WAIT_SECONDS), json);
      result = request;
      const shown = cleaned(request);
      line = `${step.name}  asked ${app} › ${feature} · ${shown.status}${shown.answer === null ? '' : ` · ${JSON.stringify(shown.answer)}`}`;
      next = [{ text: style.command(input.command(`apps requests ${shown.id}`)), aside: 'each send and answer' }];
    } else {
      const activity = await triggerAndWait(client, io, activityBody(step.trigger, params), waitSeconds(params.wait, TRIGGER_WAIT_SECONDS), json);
      result = activity;
      const shown = cleaned(activity);
      next = activityNext(style, input, activity);
      line = `${step.name}  ${eventName(shown.event).toLowerCase()} · ${activityRows(shown)
        .filter(([label]) => label !== '')
        .map(([label, value]) => `${label.toLowerCase()} ${value}`)
        .slice(0, 2)
        .join(' · ')}`;
    }
    results.set(step.name, result);
    done.push({ name: step.name, trigger: step.trigger, result });
    if (!json) io.stdout(`${style.success([...line].length > 78 ? `${[...line].slice(0, 77).join('')}…` : line)}\n`);
  }

  if (json) io.stdout(`${JSON.stringify({ steps: done }, null, 2)}\n`);
  else {
    // The last step's next move, such as the refund of the sale it made.
    io.stdout(
      `\n${style.report({
        headline: `Ran ${steps.length} ${steps.length === 1 ? 'fixture' : 'fixtures'} in ${orgLabel(run)}`,
        rows: [['File', input.args[0]!]],
        next,
        tips: ['--json prints every step\'s answer, for a script to read.'],
      })}`,
    );
  }
  return 0;
}
