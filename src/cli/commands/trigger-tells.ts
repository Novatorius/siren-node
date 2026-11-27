import type { App, AppFeature, AppRequestRecord } from '../../record-types';
import type { CommandContext, CommandInput } from '../context';
import { clean } from '../style';
import type { NextStep, Style } from '../style';
import type { ActivityConversion, ActivityResult, TestActivityClient } from './trigger-client';

/*
 * What `siren trigger` sent each app's post-conversion action, or why it
 * sent nothing (review round 1, C3). Siren tells an app when a conversion
 * of a program that picks one of its post-conversion actions is approved
 * (AppPostConversionAction on pkt/devtools). The test activity answer says
 * nothing about tells, so this reads the org's apps, the programs the
 * conversions belong to, and, once a conversion is approved, the app's
 * requests about it.
 */

/** The conversion statuses Siren has approved. The read side calls an approved one `complete`. */
const APPROVED = new Set(['approved', 'complete']);

export function isApproved(conversion: Pick<ActivityConversion, 'status'>): boolean {
  return APPROVED.has(conversion.status);
}

/** The rows and Next steps a report adds for the apps. Empty when the org has no post-conversion action. */
export interface AppTells {
  rows: Array<readonly [string, string]>;
  next: NextStep[];
}

const NONE: AppTells = { rows: [], next: [] };

interface Picked {
  app: App;
  feature: AppFeature;
}

/** Each active post-conversion action of each active app. */
function actionsOf(apps: readonly App[]): Picked[] {
  return apps
    .filter((app) => app.status === 'active')
    .flatMap((app) => (Array.isArray(app.features) ? app.features : []).filter((feature) => feature.kind === 'postConversionAction' && feature.status === 'active').map((feature) => ({ app, feature })));
}

/** What a JSON body names a value inside single quotes on a shell line. */
function quoted(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * One row per post-conversion action: what Siren sent it for this
 * activity, or why it sent nothing, with the command that changes that.
 * Any read that fails leaves the rows out, since the activity itself
 * happened and its report must still print.
 */
export async function appTells(style: Style, input: Pick<CommandInput, 'command'>, run: Pick<CommandContext, 'siren'>, client: TestActivityClient, result: ActivityResult): Promise<AppTells> {
  if (result.conversions.length === 0) return NONE;
  let actions: Picked[];
  try {
    actions = actionsOf(await run.siren().apps.list());
  } catch {
    return NONE;
  }
  if (actions.length === 0) return NONE;

  const programs = [...new Set(result.conversions.map((one) => one.programId).filter((id): id is number => id !== null))];
  const picks = new Map<number, string[]>();
  for (const id of programs) {
    try {
      picks.set(id, await client.programActions(id));
    } catch {
      // A program that can't be read is left out of the picking below.
    }
  }

  const rows: string[] = [];
  const next: NextStep[] = [];
  const added = new Set<string>();
  const step = (text: string, aside: string) => {
    if (added.has(text)) return;
    added.add(text);
    next.push({ text: style.command(input.command(text)), aside });
  };
  for (const { app, feature } of actions) {
    const name = `${clean(app.name || app.key)} › ${clean(feature.name || feature.key)}`;
    if (feature.entitled === false) {
      rows.push(`${name}: sent nothing. It needs ${clean(feature.requiredPlan ?? 'a plan that sends out of Siren')}.`);
      continue;
    }
    const pickers = result.conversions.filter((one) => one.programId !== null && (picks.get(one.programId) ?? []).includes(feature.ref));
    if (pickers.length === 0) {
      const first = result.conversions.find((one) => one.programId !== null && picks.has(one.programId));
      rows.push(`${name}: sent nothing. No program here picks it.`);
      if (first !== undefined) {
        const types = [...(picks.get(first.programId!) ?? []), feature.ref].map((type) => ({ type }));
        step(`programs update ${first.programId} --data ${quoted({ postConversionActions: types })}`, `picks it in ${clean(first.programName ?? `program ${first.programId}`)}`);
      }
      continue;
    }
    for (const conversion of pickers) {
      if (!isApproved(conversion)) {
        rows.push(`${name}: waits for conversion ${conversion.id} to be approved.`);
        step(`conversions update ${conversion.id} -d status=approved`, 'approves it, and Siren tells the app');
        continue;
      }
      const told = await toldAbout(run, app, feature, conversion.id);
      rows.push(told === undefined ? `${name}: conversion ${conversion.id} is approved, and Siren has sent nothing yet.` : `${name}: told about conversion ${conversion.id} · ${clean(told.status)} · ${clean(told.id)}`);
    }
  }
  return { rows: rows.map((row, at) => [at === 0 ? 'Apps' : '', row] as const), next };
}

/** The app's request about this conversion from this feature, among its newest 50, or undefined. */
async function toldAbout(run: Pick<CommandContext, 'siren'>, app: App, feature: AppFeature, conversionId: number): Promise<AppRequestRecord | undefined> {
  try {
    const requests = await run.siren().apps.requests.list({ appId: app.id, limit: 50 });
    return requests.find((one) => one.feature === feature.ref && one.subject?.type === 'conversion' && String(one.subject.id) === String(conversionId));
  } catch {
    return undefined;
  }
}
