import type { App } from '../../record-types';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { CliRefusal } from '../targets';

/*
 * `siren apps init`, `apply`, `list`, `show`, `on`, `off`, `rotate` and
 * `delete`: the app file, the app on Siren, and its key on this machine.
 * Contract: docs/architecture/apps-cli.md, "The commands" and "Signing in
 * and the stored files".
 */

/** `siren apps list`: one block per app with its items. */
export async function appsList(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const apps = await run.siren().apps.list();
  if (apps.length === 0) run.print(`No apps on ${run.target.baseUrl} yet. Write one with siren apps init, then run siren apps apply.`);
  for (const app of apps) for (const line of appLines(app)) run.print(line);
  return 0;
}

/**
 * An app's lines: its key, name, state and, when `showUrl`, its url, then
 * one line per item with its `app:{id}`. `apply` leaves the url out, since
 * it may have come from the environment.
 */
export function appLines(app: App, showUrl = true): string[] {
  const state = app.status === 'active' ? 'on' : 'off';
  const lines = [`${app.key}  ${app.name}  ${state}${showUrl && app.url ? `  ${app.url}` : ''}`];
  for (const item of app.items) lines.push(`  ${item.ref}  ${item.kind}  ${item.key}  ${item.name}`);
  return lines;
}

/** The commands packet cli-apply builds. Each refuses until then. */
export async function notBuilt(_input: CommandInput): Promise<number> {
  throw new CliRefusal('This command is not built yet.');
}
