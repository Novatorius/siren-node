import { readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ConflictError, appErrorCode } from '../../errors';
import type { App } from '../../record-types';
import { APP_FILE_NAME, appFileTemplate, declarationFor, parseAppFile } from '../app-file';
import { contextOf } from '../context';
import type { CommandContext, CommandInput } from '../context';
import { CliRefusal, CliUsageError } from '../targets';

/*
 * `siren apps init`, `apply`, `list`, `show`, `on`, `off`, `rotate` and
 * `delete`: the app file, the app on Siren, and its key on this machine.
 * Contract: docs/architecture/apps-cli.md, "The commands" and "Signing in
 * and the stored files".
 *
 * The files this tool writes: siren.app.json and a line in .gitignore
 * (`apps init`), and the env file `.env.sandbox` or `.env.live` beside the
 * app file, mode 0600 (`apps apply` on a first declaration, `apps rotate`).
 * credentials.json records the env file's path, never its contents.
 */

/** The three lines of an env file the tool owns. Every other line is kept as it is. */
const ENV_NAMES = ['SIREN_BASE_URL', 'SIREN_API_KEY', 'SIREN_SIGNING_SECRET'] as const;

/** An app key, as Siren's `AppService::KEY_PATTERN` reads it, at most 64 characters. */
const APP_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  io.stdout(`Set SIREN_APP_URL to your app's https address, then run siren apps apply.\n`);
  return 0;
}

/**
 * `siren apps apply [file]`: checks the app file, declares its app with
 * `PUT /apps/{key}` once, and prints the app without its url. On the first
 * declaration it writes the key and signing secret Siren shows once to the
 * env file beside the app file, and prints the key's prefix and the file's
 * absolute path. On a later one it leaves the env file alone, and says so
 * when that file holds no key. Records the env file's path for `rotate`.
 */
export async function appsApply(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io } = input;
  const shown = input.args[0] ?? APP_FILE_NAME;
  const path = resolve(io.cwd, shown);
  const text = await readText(path);
  if (text === undefined) throw new CliRefusal(`There is no app file at ${path}. Write one with siren apps init.`);

  const parsed = parseAppFile(text, io.env);
  if (parsed.file === null) {
    for (const problem of parsed.problems) {
      io.stderr(`${shown}:${problem.line}:${problem.column}: ${problem.path === '' ? '' : `${problem.path}: `}${problem.message}\n`);
    }
    throw new CliRefusal(`${shown} has ${parsed.problems.length === 1 ? 'a problem' : `${parsed.problems.length} problems`}, so nothing was sent.`);
  }

  await run.signedIn();
  const siren = run.siren();
  const { key, params } = declarationFor(parsed.file);
  const app = await siren.apps.declare(key, params);
  const envPath = join(dirname(path), run.envFileName());

  run.print(`Declared ${key} on ${run.target.baseUrl}.`);
  for (const line of appLines(app, false)) run.print(line);
  for (const name of parsed.filled) run.print(`Its url came from ${name}.`);

  if (app.created) {
    const saved = await saveSecrets(run, envPath, app.rawKey, app.signingSecret);
    await run.remember(key, envPath);
    return saved ? 0 : 1;
  }
  await run.remember(key, envPath);
  if ((await envValue(envPath, 'SIREN_API_KEY')) === undefined) {
    run.print(`${key} already exists, and this machine holds no key for it: ${envPath} has no SIREN_API_KEY. Run siren apps rotate ${key} to make a new key and save it there.`);
  }
  return 0;
}

/** `siren apps list [--json]`: one block per app with its items, or the JSON Siren sent. */
export async function appsList(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const apps = await run.siren().apps.list();
  if (input.values.json === true) {
    run.print(JSON.stringify(apps, null, 2));
    return 0;
  }
  if (apps.length === 0) run.print(`No apps on ${run.target.baseUrl} yet. Write one with siren apps init, then run siren apps apply.`);
  for (const app of apps) for (const line of appLines(app)) run.print(line);
  return 0;
}

/** `siren apps show <key> [--json]`: the app and its items. */
export async function appsShow(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const app = await run.siren().apps.retrieve(input.args[0] ?? '');
  if (input.values.json === true) run.print(JSON.stringify(app, null, 2));
  else for (const line of appLines(app)) run.print(line);
  return 0;
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
 * `siren apps rotate <key> [--app-file <path>]`: gives the app a new key and
 * signing secret with `POST /apps/{key}/rotate`, and writes them to the env
 * file `apply` recorded, or beside the app file `--app-file` names. With
 * neither it refuses before sending, since Siren shows the new pair once
 * and it would have nowhere known to go.
 */
export async function appsRotate(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const key = input.args[0] ?? '';
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
      `This machine has no record of where ${key}'s key lives, so nothing was sent. Run siren apps rotate ${key} --app-file <path to siren.app.json>, and the new key goes beside that file.`,
    );
  }

  const rotated = await run.siren().apps.rotate(key);
  const saved = await saveSecrets(run, envPath, rotated.rawKey, rotated.signingSecret);
  await run.remember(key, envPath);
  if (saved) run.print(`Siren revoked the old key. Restart your app so it reads the new pair.`);
  return saved ? 0 : 1;
}

/**
 * `siren apps delete <key> --yes`: deletes the app and revokes its key.
 * Without `--yes` it asks for the key in a terminal, and refuses elsewhere.
 * A 409 `app_in_use` names the records that still use its items, with
 * `siren apps off`, and the open asks, with `siren apps requests --app`.
 */
export async function appsDelete(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const key = input.args[0] ?? '';
  if (values.yes !== true) {
    const typed = io.interactive ? (await io.prompt(`Deleting ${key} revokes its key and cannot be undone. Type ${key} to delete it: `)).trim() : undefined;
    if (typed !== key) throw new CliRefusal(`Deleting ${key} revokes its key and cannot be undone. Run siren apps delete ${key} --yes to delete it.`);
  }
  await run.signedIn();
  try {
    await run.siren().apps.delete(key);
  } catch (error) {
    if (error instanceof ConflictError && appErrorCode(error) === 'app_in_use') throw new CliRefusal(inUseLines(key, error));
    throw error;
  }
  run.print(`Deleted ${key} from ${run.target.baseUrl}. Its key no longer works.`);
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

/** Turns the app on or off and prints its new state. */
async function setStatus(input: CommandInput, status: 'active' | 'inactive'): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const app = await run.siren().apps.setStatus(input.args[0] ?? '', status);
  run.print(`${app.key} is ${app.status === 'active' ? 'on' : 'off'}.`);
  return 0;
}

/** The lines a delete that records or open asks still hold gets. */
function inUseLines(key: string, error: ConflictError): string {
  const data = (typeof error.data === 'object' && error.data !== null ? error.data : {}) as { uses?: unknown; openRequests?: unknown };
  const uses = typeof data.uses === 'object' && data.uses !== null && !Array.isArray(data.uses) ? Object.entries(data.uses as Record<string, unknown>) : [];
  const open = typeof data.openRequests === 'number' ? data.openRequests : 0;
  const lines = [`Siren kept ${key}.`];
  if (uses.length > 0) {
    lines.push(`Records still select its items: ${uses.map(([ref, count]) => `${ref} (${String(count)})`).join(', ')}.`);
    lines.push(`Turn it off instead with siren apps off ${key}. Siren then stops calling it and keeps what it already did.`);
  }
  if (open > 0) {
    lines.push(`It has ${open} open ${open === 1 ? 'ask' : 'asks'}. Answer them, or wait for them to end: siren apps requests --app ${key}`);
  }
  if (uses.length === 0 && open === 0) lines.push(error.message);
  return lines.join('\n');
}

/**
 * Writes the key and secret Siren showed once to the env file, replacing
 * only its three lines, mode 0600, and prints the key's prefix and the
 * file's absolute path. Says on standard error when the file held a key for
 * another Siren. When the file cannot be written, prints both once on
 * standard error, since Siren will not show them again, and answers false.
 */
async function saveSecrets(run: CommandContext, envPath: string, rawKey: string, signingSecret: string): Promise<boolean> {
  const base = run.target.baseUrl;
  try {
    const before = await envValue(envPath, 'SIREN_BASE_URL');
    await writeEnvLines(envPath, { SIREN_BASE_URL: base, SIREN_API_KEY: rawKey, SIREN_SIGNING_SECRET: signingSecret });
    if (before !== undefined && before !== base) run.warn(`${envPath} held a key for ${before}. It now holds the key for ${base}.`);
  } catch (error) {
    run.warn(
      `Siren showed the app's new key and signing secret once, and ${envPath} could not be written (${(error as Error).message}). Keep them somewhere safe now:\n` +
        `SIREN_API_KEY=${rawKey}\nSIREN_SIGNING_SECRET=${signingSecret}\n`,
    );
    return false;
  }
  run.print(`Key ${rawKey.slice(0, 16)} and its signing secret are in ${envPath}.`);
  return true;
}

/** Replaces each named line of the env file, or adds it at the end, keeping every other line, and leaves the file at mode 0600. */
async function writeEnvLines(path: string, entries: Readonly<Record<(typeof ENV_NAMES)[number], string>>): Promise<void> {
  const text = (await readText(path)) ?? '';
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const name of ENV_NAMES) {
    const value = entries[name];
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
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
