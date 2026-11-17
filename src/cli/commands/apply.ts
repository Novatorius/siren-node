import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ConflictError, NotFoundError, appErrorCode } from '../../errors';
import type { App } from '../../record-types';
import { APP_FILE_NAME, appFileTemplate, declarationFor, parseAppFile } from '../app-file';
import { appChanges, droppedLine } from '../app-changes';
import { contextOf } from '../context';
import type { CommandContext, CommandInput } from '../context';
import { CliRefusal, CliUsageError } from '../targets';

/*
 * `siren apps init`, `apply`, `list`, `show`, `on`, `off`, `rotate-key`,
 * `rotate-secret` and `delete`: the app file, the app on Siren, and its key
 * and signing secret on this machine. `rotate` names the two that replace
 * it.
 * Contract: docs/architecture/apps-cli.md, "The commands" and "Signing in
 * and the stored files".
 *
 * The files this tool writes: siren.app.json and a line in .gitignore
 * (`apps init`), and the env file `.env.sandbox` or `.env.live` beside the
 * app file, mode 0600 (`apps apply`, `apps rotate-key`, `apps rotate-secret`).
 * credentials.json records the env file's path, never its contents.
 */

/** The three lines of an env file the tool owns. Every other line is kept as it is. */
const ENV_NAMES = ['SIREN_BASE_URL', 'SIREN_API_KEY', 'SIREN_SIGNING_SECRET'] as const;

/** An app key, as Siren's `AppService::KEY_PATTERN` reads it, at most 64 characters. */
const APP_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The app key a command line names, or `CliUsageError` in the tool's words
 * for one Siren cannot hold, so the command answers 2 and sends nothing, not
 * the SDK's refusal, which names a method the person never typed.
 */
export function appKeyArgument(key: string): string {
  if (key.length > 64 || !APP_KEY.test(key) || key === 'requests') {
    throw new CliUsageError(
      `An app key is lowercase letters and digits joined by single dashes, at most 64 characters and never requests, and ${JSON.stringify(key)} is not one.`,
    );
  }
  return key;
}

/**
 * `siren apps init`: writes siren.app.json in the working folder from the
 * template, never over a file that is there, and adds `.env.*` to
 * .gitignore so the key `apply` saves stays out of git. Sends nothing.
 */
export async function appsInit(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const key = typeof values.key === 'string' ? values.key : keyFromFolder(io.cwd);
  if (key.length > 64 || !APP_KEY.test(key) || key === 'requests') {
    throw new CliUsageError('--key takes lowercase letters and digits joined by single dashes, at most 64 characters, such as acme-payouts.');
  }
  const name = typeof values.name === 'string' && values.name.trim() !== '' ? values.name.trim() : key;

  const path = join(io.cwd, APP_FILE_NAME);
  try {
    await writeFile(path, appFileTemplate(key, name), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliRefusal(`${path} is already there, so nothing was written.`);
    throw error;
  }
  io.stdout(`Wrote ${path} for the app ${key}.\n`);

  const ignorePath = join(io.cwd, '.gitignore');
  const ignored = await readText(ignorePath);
  if (!(ignored ?? '').split(/\r?\n/).includes('.env.*')) {
    await writeFile(ignorePath, `${ignored ?? ''}${ignored && !ignored.endsWith('\n') ? '\n' : ''}.env.*\n`);
    io.stdout(`Added .env.* to ${ignorePath}, so the key apply saves stays out of git.\n`);
  }
  io.stdout(`Set SIREN_APP_URL to your app's https address, then run ${input.command('apps apply')}.\n`);
  return 0;
}

/**
 * True when an app's url names this machine's own address: `localhost` or
 * `127.0.0.1`, as a person writes it for a server they run. A Siren in a
 * container reads that address as the container itself, so apply says so
 * once, before it sends, and names `host.docker.internal`. The url itself is
 * never printed.
 */
function onThisMachine(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * `siren apps apply [file] [--yes]`: checks the app file, reads the app as
 * Siren holds it with `GET /apps/{key}`, prints each change applying the
 * file would make, and asks
 * before it writes, since the last write wins. It cannot tell a change made
 * in the dashboard from an edit to the file (AP-A1776), so it claims neither. `--yes` skips the question,
 * and with no terminal and no `--yes` it refuses. With nothing to change it
 * says so and writes nothing. Then it declares the app with
 * `PUT /apps/{key}` once, and prints the app without its url. On the first
 * declaration it writes the key and signing secret Siren shows once to the
 * env file beside the app file, and prints the key's prefix and the file's
 * absolute path. On a later one it leaves the env file alone, and says so
 * when that file holds no key. Records the env file's path for `rotate`.
 *
 * Before sending it refuses an env path it could not write as a regular
 * file (AP-A904), and an env file that holds the key of another Siren, so a key is never written through a
 * link and never replaces a key this machine still needs.
 */
export async function appsApply(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io } = input;
  const shown = input.args[0] ?? APP_FILE_NAME;
  const path = resolve(io.cwd, shown);
  const text = await readText(path);
  if (text === undefined) throw new CliRefusal(`There is no app file at ${path}. Write one with ${run.command('apps init')}.`);

  const parsed = parseAppFile(text, io.env);
  if (parsed.file === null) {
    for (const problem of parsed.problems) {
      io.stderr(`${shown}:${problem.line}:${problem.column}: ${problem.path === '' ? '' : `${problem.path}: `}${problem.message}\n`);
    }
    throw new CliRefusal(`${shown} has ${parsed.problems.length === 1 ? 'a problem' : `${parsed.problems.length} problems`}, so nothing was sent.`);
  }

  await run.signedIn();
  const { key, params } = declarationFor(parsed.file);
  if (params.url != null && onThisMachine(params.url)) {
    run.warn(
      "siren: The app's url is on this machine's own address, which a Siren running in a container cannot reach. " +
        'Use host.docker.internal in its place, and see "Running against your own Siren Cloud" in the README.',
    );
  }
  const envPath = join(dirname(path), run.envFileName());
  const problem = await envFileProblem(envPath);
  if (problem !== undefined) throw new CliRefusal(`${problem.line} Nothing was sent.`);
  const held = await envValue(envPath, 'SIREN_BASE_URL');
  if (held !== undefined && held !== run.target.baseUrl) {
    throw new CliRefusal(
      `${envPath} holds the key for ${held}, and this apply is for ${run.target.baseUrl}, so nothing was sent. ` +
        `Move that file aside to keep its key, then run ${run.command('apps apply')} again.`,
    );
  }
  const siren = run.siren();
  const current = await siren.apps.retrieve(key).catch((error: unknown) => {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  });
  const changes = appChanges(current, params);
  if (current !== undefined && (current.apiKey === null || current.apiKey === undefined) && (params.scopes ?? []).length > 0) {
    run.warn(
      `siren: ${shown} names scopes, and ${key} holds no key, so they reach nothing. ` +
        `Make one with ${run.command(`apps add-key ${key}`)}, then run ${run.command('apps apply')} again to give it these scopes.`,
    );
  }
  const removals = await Promise.all(
    changes.dropped.map(({ item }) =>
      siren.apps.items.retrieve(key, item.id).then(
        (page) => droppedLine(item, page.uses),
        () => droppedLine(item, undefined),
      ),
    ),
  );
  const lines = [...changes.lines, ...removals];
  if (lines.length === 0) {
    run.print(`${key} on ${run.target.baseUrl} already matches ${shown}, so nothing was sent.`);
    return 0;
  }
  run.print(
    changes.isNew
      ? `${key} is new on ${run.target.baseUrl}. Applying ${shown}:`
      : `Applying ${shown} changes ${key} on ${run.target.baseUrl}:`,
  );
  for (const line of lines) run.print(`  ${line}`);
  if (input.values.yes !== true) {
    const question = `Apply ${lines.length === 1 ? 'this change' : 'these changes'}? The last write wins, so this replaces anything changed in the dashboard since. Type yes to apply: `;
    if (!io.interactive) {
      throw new CliRefusal(`Nothing was sent. Run ${run.command(input.args[0] === undefined ? 'apps apply --yes' : `apps apply ${shown} --yes`)} to apply ${lines.length === 1 ? 'it' : 'them'} without asking.`);
    }
    const typed = (await io.prompt(question)).trim().toLowerCase();
    if (typed !== 'yes' && typed !== 'y') throw new CliRefusal('Nothing was sent.');
  }

  const app = await siren.apps.declare(key, params);

  run.print(`Declared ${key} on ${run.target.baseUrl}.`);
  for (const line of appLines(app, false)) run.print(line);
  for (const name of parsed.filled) run.print(`Its url came from ${name}.`);
  if (app.items.some((item) => item.status === 'archived')) {
    const again = run.command(input.args[0] === undefined ? 'apps apply' : `apps apply ${shown}`);
    run.print(
      `An archived feature is one ${shown} no longer names while a record still selects it. ` +
        'Siren keeps it so that record still points at it, never calls it, and deletes it once nothing selects it. ' +
        `To bring it back, name it in ${shown} again with the same kind and key, and run ${again}.`,
    );
  }

  if (app.created) {
    const saved = await saveSecrets(run, key, envPath, { rawKey: app.rawKey, signingSecret: app.signingSecret }, false);
    await run.remember(key, envPath);
    return saved ? 0 : 1;
  }
  await run.remember(key, envPath);
  // A later declaration that gave the app its first address answers the address's secret once.
  if (app.signingSecret !== undefined && !(await saveSecrets(run, key, envPath, { signingSecret: app.signingSecret }, false))) return 1;
  if ((await envValue(envPath, 'SIREN_API_KEY')) === undefined) {
    // An app made in the dashboard may hold no key, and Siren refuses to rotate one it lacks (409 `app_key_missing`).
    if (app.apiKey === null || app.apiKey === undefined) {
      run.print(`${key} holds no key, so ${envPath} has none. Run ${run.command(`apps add-key ${key}`)} to make one and save it there.`);
    } else {
      run.print(`${key} already exists, and this machine holds no key for it: ${envPath} has no SIREN_API_KEY. Run ${run.command(`apps rotate-key ${key}`)} to make a new key and save it there.`);
    }
  }
  return 0;
}

/** `siren apps list [--json]`: one block per app with its features, or the JSON Siren sent. */
export async function appsList(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const apps = await run.siren().apps.list();
  if (input.values.json === true) {
    run.print(JSON.stringify(apps, null, 2));
    return 0;
  }
  if (apps.length === 0) run.print(`No apps on ${run.target.baseUrl} yet. Write one with ${run.command('apps init')}, then run ${run.command('apps apply')}.`);
  for (const app of apps) {
    for (const line of appLines(app)) run.print(line);
    attentionLine(run, app);
  }
  return 0;
}

/** `siren apps show <key> [--json]`: the app and its features. */
export async function appsShow(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const key = appKeyArgument(input.args[0] ?? '');
  await run.signedIn();
  const app = await run.siren().apps.retrieve(key);
  if (input.values.json === true) run.print(JSON.stringify(app, null, 2));
  else {
    for (const line of appLines(app)) run.print(line);
    attentionLine(run, app);
  }
  return 0;
}

/**
 * Under an app with requests that need a person, how many, and the command
 * that lists them. Prints nothing for a count of zero, or for a Siren that
 * sends no count.
 */
function attentionLine(run: CommandContext, app: App): void {
  const count = app.needsAttention;
  if (typeof count !== 'number' || count <= 0) return;
  const command = run.command(`apps requests --app ${app.key} --attention`);
  run.print(count === 1 ? `  1 request needs attention. See it with ${command}.` : `  ${count} requests need attention. See them with ${command}.`);
}

/** `siren apps on <key>`: turns the app on. */
export function appsOn(input: CommandInput): Promise<number> {
  return setStatus(input, 'active');
}

/** `siren apps off <key>`: turns the app off. Siren stops calling it. */
export function appsOff(input: CommandInput): Promise<number> {
  return setStatus(input, 'inactive');
}

/**
 * `siren apps rotate <key>`: gone, since an app's key and its signing secret
 * now change apart (`POST /apps/{key}/key/rotate` and
 * `POST /apps/{key}/secret/rotate` on Siren's int/preview-apps). Sends
 * nothing, names the two commands that replace it, and exits 1.
 */
export async function appsRotate(input: CommandInput): Promise<number> {
  const key = appKeyArgument(input.args[0] ?? '');
  throw new CliRefusal(
    `Rotating is now two commands, since an app's key and its signing secret change apart. Nothing was sent. ` +
      `Run ${input.command(`apps rotate-key ${key}`)} for a new key, or ${input.command(`apps rotate-secret ${key}`)} for a new signing secret.`,
  );
}

/**
 * `siren apps rotate-key <key> [--app-file <path>] [--yes]`: gives the app a
 * new key with `POST /apps/{key}/key/rotate`, and writes it to the env file
 * as `SIREN_API_KEY`. Siren revokes the old key at once, so it asks first.
 */
export function appsRotateKey(input: CommandInput): Promise<number> {
  return rotatePart(input, 'key');
}

/**
 * `siren apps rotate-secret <key> [--app-file <path>] [--yes]`: gives the
 * app's address a new signing secret with `POST /apps/{key}/secret/rotate`,
 * and writes it to the env file as `SIREN_SIGNING_SECRET`. Siren signs with
 * the new secret at once, so it asks first.
 */
export function appsRotateSecret(input: CommandInput): Promise<number> {
  return rotatePart(input, 'secret');
}

/**
 * `siren apps add-key <key> [--app-file <path>]`: makes a key for an app
 * that holds none with `POST /apps/{key}/key`, and writes it to the env
 * file as `SIREN_API_KEY`. The key holds no scopes until the next
 * `siren apps apply` gives it the file's. Nothing is revoked, so it does not
 * ask. Siren answers 409 `app_key_exists` for an app that holds a key.
 */
export function appsAddKey(input: CommandInput): Promise<number> {
  return rotatePart(input, 'add-key');
}

/**
 * Rotates one secret, or makes the key, and writes it to the env file `apply` recorded, or
 * beside the app file `--app-file` names, replacing only its own line and
 * `SIREN_BASE_URL`, mode 0600, through a temporary file and a rename. With
 * neither it refuses before sending, since Siren shows the new secret once
 * and it would have nowhere known to go. It asks before sending, since the
 * old secret stops working at once: `--yes` skips the question, and with no
 * terminal and no `--yes` it refuses.
 */
async function rotatePart(input: CommandInput, part: 'key' | 'secret' | 'add-key'): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const key = appKeyArgument(input.args[0] ?? '');
  const command = part === 'key' ? 'apps rotate-key' : part === 'secret' ? 'apps rotate-secret' : 'apps add-key';
  const session = await run.signedIn();

  let envPath: string | undefined;
  if (typeof values['app-file'] === 'string') {
    const appFile = resolve(io.cwd, values['app-file']);
    if (!(await isFile(appFile))) throw new CliRefusal(`There is no app file at ${appFile}.`);
    envPath = join(dirname(appFile), run.envFileName());
  } else {
    envPath = session.envFiles?.[key];
  }
  if (envPath === undefined) {
    throw new CliRefusal(
      `This machine has no record of where ${key}'s ${part === 'secret' ? 'signing secret' : 'key'} lives, so nothing was sent. Run ${run.command(`${command} ${key} --app-file <path to siren.app.json>`)}, and the new one goes beside that file.`,
    );
  }
  const what = part === 'key' ? 'the old key' : part === 'secret' ? 'the old signing secret' : 'the app';
  const problem = await envFileProblem(envPath);
  if (problem !== undefined) throw new CliRefusal(`${problem.line} Nothing was sent${part === 'add-key' ? '' : `, and ${what} still works`}.`);
  const held = await envValue(envPath, 'SIREN_BASE_URL');
  if (held !== undefined && held !== run.target.baseUrl) {
    throw new CliRefusal(
      `${envPath} holds the key for ${held}, and this ${part === 'add-key' ? 'key' : 'rotation'} is for ${run.target.baseUrl}, so nothing was sent${part === 'add-key' ? '' : ` and ${what} still works`}. ` +
        `Move that file aside to keep its key, then run ${run.command(`${command} ${key}`)} again.`,
    );
  }
  if (part !== 'add-key' && values.yes !== true) {
    const warning =
      part === 'key'
        ? `Rotating ${key}'s key revokes the old key at once, so anything still using it stops working.`
        : `Rotating ${key}'s signing secret makes Siren sign with the new one at once, so the app refuses requests until it reads the new one.`;
    if (!io.interactive) throw new CliRefusal(`${warning} Nothing was sent. Run ${run.command(`${command} ${key} --yes`)} to rotate it.`);
    const typed = (await io.prompt(`${warning} Type yes to rotate it: `)).trim().toLowerCase();
    if (typed !== 'yes' && typed !== 'y') throw new CliRefusal(`Nothing was sent, and ${what} still works.`);
  }

  const siren = run.siren();
  let secrets: ShownSecrets;
  try {
    secrets =
      part === 'key'
        ? { rawKey: (await siren.apps.rotateKey(key)).rawKey }
        : part === 'secret'
          ? { signingSecret: (await siren.apps.rotateSecret(key)).signingSecret }
          : { rawKey: (await siren.apps.createKey(key)).rawKey };
  } catch (error) {
    throw partRefusal(run, key, error) ?? error;
  }
  const saved = await saveSecrets(run, key, envPath, secrets, part !== 'add-key');
  await run.remember(key, envPath);
  if (saved) {
    run.print(
      part === 'key'
        ? 'Siren revoked the old key. Restart your app so it reads the new key.'
        : part === 'secret'
          ? 'Siren signs every request with the new secret from now on. Restart your app so it reads it.'
          : `The key holds no scopes yet. Run ${run.command('apps apply')} to give it the scopes your app file names.`,
    );
  }
  return saved ? 0 : 1;
}

/**
 * The tool's words for Siren's 409 when the app lacks the part a command
 * changes, or already holds the key `add-key` would make
 * (AppPartRefusedException on Siren's feat/apps at c8dbb1ab3), naming the
 * one command that fits the app. Undefined for any other error.
 */
function partRefusal(run: CommandContext, key: string, error: unknown): CliRefusal | undefined {
  if (!(error instanceof ConflictError)) return undefined;
  switch (appErrorCode(error)) {
    case 'app_key_missing':
      return new CliRefusal(`${key} holds no key to rotate, so nothing changed. Run ${run.command(`apps add-key ${key}`)} to make one.`);
    case 'app_key_exists':
      return new CliRefusal(
        `${key} already holds a key, so nothing changed. Run ${run.command(`apps rotate-key ${key}`)} for a new one, which revokes the old one at once.`,
      );
    case 'app_address_missing':
      return new CliRefusal(
        `${key} has no address, so it has no signing secret to rotate. Give it a url in its app file, then run ${run.command('apps apply')}.`,
      );
    default:
      return undefined;
  }
}

/**
 * `siren apps delete <key> --yes`: deletes the app and revokes its key.
 * Without `--yes` it asks for the key in a terminal, and refuses elsewhere.
 * A 409 `app_in_use` names the records that still use its features, with
 * `siren apps off`, and the open asks, with `siren apps requests --app`.
 */
export async function appsDelete(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const key = appKeyArgument(input.args[0] ?? '');
  if (values.yes !== true) {
    const typed = io.interactive ? (await io.prompt(`Deleting ${key} revokes its key and cannot be undone. Type ${key} to delete it: `)).trim() : undefined;
    if (typed !== key) throw new CliRefusal(`Deleting ${key} revokes its key and cannot be undone. Run ${run.command(`apps delete ${key} --yes`)} to delete it.`);
  }
  await run.signedIn();
  try {
    await run.siren().apps.delete(key);
  } catch (error) {
    if (error instanceof ConflictError && appErrorCode(error) === 'app_in_use') throw new CliRefusal(await inUseLines(run, key, error));
    throw error;
  }
  run.print(`Deleted ${key} from ${run.target.baseUrl}. Its key no longer works.`);
  return 0;
}

/**
 * An app's lines: its key, name, state and, when `showUrl`, its url, then
 * one line per feature with its `app:{id}`, then its events when it has
 * any. A feature Siren archived, because a later declaration left it out
 * while a record still selects it, says so beside it, and a feature or the
 * events the plan cannot use say which plan they need. `apply` leaves the url out, since it may have come from the
 * environment.
 */
export function appLines(app: App, showUrl = true): string[] {
  const state = app.status === 'active' ? 'on' : 'off';
  const lines = [`${app.key}  ${app.name}  ${state}${showUrl && app.url ? `  ${app.url}` : ''}`];
  for (const item of app.items) {
    const archived = item.status === 'archived' ? '  archived, so Siren no longer calls it' : '';
    lines.push(`  ${item.ref}  ${item.kind}  ${item.key}  ${item.name}${archived}${planMark(item)}`);
  }
  const events = Array.isArray(app.events) ? app.events : [];
  if (events.length > 0) lines.push(`  events  ${events.join(', ')}${planMark(app.eventsAccess, ', so Siren does not send them')}`);
  return lines;
}

/**
 * `  requires Pro` beside a feature or the events the plan cannot use, read
 * from Siren's `entitled` and `requiredPlan` (AppPlanAccess on Siren's
 * int/preview-apps). The plan is the one Siren names, never a guess: when
 * `requiredPlan` is null the mark says only that the plan cannot use it.
 * Nothing when Siren sends no `entitled`, as an older Siren does not.
 */
function planMark(access: { entitled?: unknown; requiredPlan?: unknown } | undefined, then = ''): string {
  if (access === undefined || access === null || access.entitled !== false) return '';
  const plan = typeof access.requiredPlan === 'string' && access.requiredPlan !== '' ? access.requiredPlan : undefined;
  if (plan === undefined) return `  your plan cannot use it${then}`;
  return `  requires ${plan.charAt(0).toUpperCase()}${plan.slice(1)}${then}`;
}

/** Turns the app on or off and prints its new state. */
async function setStatus(input: CommandInput, status: 'active' | 'inactive'): Promise<number> {
  const run = contextOf(input);
  const key = appKeyArgument(input.args[0] ?? '');
  await run.signedIn();
  const app = await run.siren().apps.setStatus(key, status);
  run.print(`${app.key} is ${app.status === 'active' ? 'on' : 'off'}.`);
  return 0;
}

/**
 * The lines a delete that records or open asks still hold gets. When records
 * hold it, it reads the app with `GET /apps/{key}`: an app that is on is
 * told to turn off instead, and one already off is told to change the
 * records. When that read fails, both ways are named.
 */
async function inUseLines(run: CommandContext, key: string, error: ConflictError): Promise<string> {
  const data = (typeof error.data === 'object' && error.data !== null ? error.data : {}) as { uses?: unknown; openRequests?: unknown };
  const uses = typeof data.uses === 'object' && data.uses !== null && !Array.isArray(data.uses) ? Object.entries(data.uses as Record<string, unknown>) : [];
  const open = typeof data.openRequests === 'number' ? data.openRequests : 0;
  const lines = [`Siren kept ${key}.`];
  if (uses.length > 0) {
    lines.push(`Records still select its features: ${uses.map(([ref, count]) => `${ref} (${String(count)})`).join(', ')}.`);
    const status = await run
      .siren()
      .apps.retrieve(key)
      .then((app) => app.status, () => undefined);
    const turnOff = `Turn it off instead with ${run.command(`apps off ${key}`)}. Siren then stops calling it and keeps what it already did.`;
    const change = `To delete it, change each record that selects those features to another choice, then run ${run.command(`apps delete ${key} --yes`)}.`;
    if (status === 'active') lines.push(turnOff);
    else if (status !== undefined) lines.push(`It is already off, so Siren no longer calls it. ${change}`);
    else lines.push(`If it is on, ${turnOff.charAt(0).toLowerCase()}${turnOff.slice(1)} ${change}`);
  }
  if (open > 0) {
    lines.push(`It has ${open} open ${open === 1 ? 'ask' : 'asks'}. Answer them, or wait for them to end: ${run.command(`apps requests --app ${key}`)}`);
  }
  if (uses.length === 0 && open === 0) lines.push(error.message);
  return lines.join('\n');
}

/** The secrets one answer showed once. An app with no address gets no signing secret. */
interface ShownSecrets {
  rawKey?: string;
  signingSecret?: string;
}

/**
 * Writes the key, the secret or both, as Siren showed them once, to the env
 * file, replacing only `SIREN_BASE_URL` and the lines it has a value for,
 * mode 0600, and prints the key's prefix and the file's absolute path. It
 * never writes an empty line for a secret Siren did not send. `apply` and `rotate` have already refused a file
 * that holds another Siren's key. When a write the checks before sending
 * could not foresee fails, says on standard error that Siren issued a secret
 * it could not save and names `siren apps rotate-key` or `rotate-secret`,
 * which issue a new one, and, after a rotation, that the old one left in
 * the file is revoked. Never
 * prints either value, and answers false.
 */
async function saveSecrets(run: CommandContext, key: string, envPath: string, secrets: ShownSecrets, revoked: boolean): Promise<boolean> {
  const { rawKey, signingSecret } = secrets;
  const both = rawKey !== undefined && signingSecret !== undefined;
  try {
    await writeEnvLines(envPath, {
      SIREN_BASE_URL: run.target.baseUrl,
      ...(rawKey === undefined ? {} : { SIREN_API_KEY: rawKey }),
      ...(signingSecret === undefined ? {} : { SIREN_SIGNING_SECRET: signingSecret }),
    });
  } catch (error) {
    const what = both ? 'a new key and signing secret' : rawKey !== undefined ? 'a new key' : 'a new signing secret';
    const again = [
      ...(rawKey !== undefined ? [`${run.command(`apps rotate-key ${key}`)} to issue a new key`] : []),
      ...(signingSecret !== undefined ? [`${run.command(`apps rotate-secret ${key}`)} to issue a new signing secret`] : []),
    ];
    const old = rawKey !== undefined ? 'The old key' : 'The old signing secret';
    run.warn(
      `Siren issued ${what} for ${key}, and ${both ? 'they' : 'it'} could not be saved to ${envPath} (${(error as Error).message}). ` +
        (revoked ? `${old} in ${envPath} was revoked when Siren rotated it, so stop using it. ` : '') +
        `Siren shows each secret only once, so ${both ? 'they are' : 'it is'} lost. Run ${again.join(', and ')}.`,
    );
    return false;
  }
  if (both) run.print(`Key ${rawKey.slice(0, 16)} and its signing secret are in ${envPath}.`);
  else if (rawKey !== undefined) run.print(`Key ${rawKey.slice(0, 16)} is in ${envPath}.`);
  else run.print(`Its new signing secret is in ${envPath}.`);
  return true;
}

/**
 * Replaces each line `entries` names, or adds it at the end, keeping every
 * other line, the lines it leaves out included. Writes the whole text to a new file made with mode 0600
 * beside it and renames that over the env file, as `CredentialStore` writes
 * credentials.json, so the key is never in a wider file, a crash leaves the
 * old file whole, and a link planted at the path is replaced, not followed.
 * Refuses a path that is a symbolic link or not a regular file.
 */
async function writeEnvLines(path: string, entries: Readonly<Partial<Record<(typeof ENV_NAMES)[number], string>>>): Promise<void> {
  const problem = await envFileProblem(path);
  if (problem !== undefined) throw new Error(problem.line);
  const text = (await readText(path)) ?? '';
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const name of ENV_NAMES) {
    const value = entries[name];
    if (value === undefined) continue;
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  // `.env.sandbox.<hex>.tmp`, which the `.env.*` line apps init writes to .gitignore covers, so a
  // crash before the rename cannot leave a key git would stage.
  const temporary = join(dirname(path), `${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Why the tool cannot write a key to `path` as a regular file: it is a
 * symbolic link, it is there and not a regular file, its folder does not
 * exist, or its folder cannot be written to, which the rename needs. Or why
 * it will not: the file holds one of the names the tool writes on more than
 * one line. The tool would replace one, and a loader that reads the other,
 * as examples/apps/acme/env.mjs reads the last, would keep a key Siren just
 * revoked, so every command refuses before it sends.
 * Undefined when the path is a regular file or not there, in a folder the
 * tool can write to. `apply` and `rotate` ask before sending, by the
 * orchestrator's ruling in the slice 8 fix round (AP-A904), since Siren
 * issues a pair once.
 */
async function envFileProblem(path: string): Promise<{ kind: 'link' | 'other'; line: string } | undefined> {
  let found;
  try {
    found = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  if (found?.isSymbolicLink()) {
    return { kind: 'link', line: `${path} is a symbolic link, and the tool writes a key only to a regular file it can see. Replace the link with a file.` };
  }
  if (found !== undefined && !found.isFile()) return { kind: 'other', line: `${path} is not a regular file, so the tool cannot write a key to it.` };
  const folder = dirname(path);
  try {
    await access(folder, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'other', line: `${folder} does not exist, so the tool cannot write ${path}.` };
    return { kind: 'other', line: `The tool cannot write to ${folder}, so it cannot save ${path}.` };
  }
  if (found !== undefined) {
    const lines = ((await readText(path)) ?? '').split(/\r?\n/);
    for (const name of ENV_NAMES) {
      const at = lines.flatMap((line, index) => (line.startsWith(`${name}=`) ? [index + 1] : []));
      if (at.length > 1) {
        const shown = `${at.slice(0, -1).join(', ')} and ${at.at(-1)}`;
        return {
          kind: 'other',
          line: `${path} holds ${name} on lines ${shown}, and a program that reads it takes only one of them. Keep the line you use, delete the other, then run the command again.`,
        };
      }
    }
  }
  return undefined;
}

/** The value of `name` in the env file, or undefined when the file or the line is missing. */
async function envValue(path: string, name: string): Promise<string | undefined> {
  const text = await readText(path);
  const line = text?.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1);
}

/** A file's text, or undefined when there is no file. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** True when `path` is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** An app key made from the working folder's name, for `apps init` without `--key`. */
function keyFromFolder(cwd: string): string {
  const key = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return key === '' || key === 'requests' ? 'my-app' : key;
}
