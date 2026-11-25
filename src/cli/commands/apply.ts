import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConflictError, NotFoundError, appErrorCode } from '../../errors';
import { RESERVED_APP_KEYS } from '../../resources/apps';
import type { App, AppFeature, AppFeatureDeclaration } from '../../record-types';
import { FeatureKind } from '../../taxonomy';
import { APP_FILE_NAME, APP_FILE_SCHEMA_PATH, RECIPE_NOTE, appFileTemplate, declarationFor, parseAppFile } from '../app-file';
import { appChanges, droppedLine, storedScopes } from '../app-changes';
import { kindLabel, kindName } from '../app-kinds';
import { contextOf } from '../context';
import { askOrg, findOrg, membershipsOf, orgList } from '../org';
import { REPORT_WIDTH, clean, styleFor, unbroken, visibleLength, wrapWords } from '../style';
import type { Style } from '../style';
import type { CommandContext, CommandInput } from '../context';
import type { StoredSession } from '../credentials';
import { either, suggestions } from '../suggest';
import { CliRefusal, CliUsageError, commandLine } from '../targets';

/*
 * `siren apps init`, `apply`, `list`, `show`, `on`, `off`, `rotate-key`,
 * `rotate-secret` and `delete`: the app file, the app on Siren, and its key
 * and signing secret on this machine.
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
  if (!isAppKey(key)) {
    throw new CliUsageError(
      `An app key is lowercase letters and digits joined by single dashes, at most 64 characters and never requests, events, scopes or kinds, and ${JSON.stringify(key)} is not one.`,
    );
  }
  return key;
}

/** True for a key Siren can hold: the pattern, at most 64 characters, and none of the words Siren keeps for its own routes. */
function isAppKey(key: string): boolean {
  return key.length <= 64 && APP_KEY.test(key) && !(RESERVED_APP_KEYS as readonly string[]).includes(key);
}

/** The lines `apps init` keeps in .gitignore: the two env files apply writes, by name, and the temporary file each is written through. */
const IGNORED = ['.env.sandbox', '.env.live', '.env.*.tmp'];

/**
 * `siren apps init`: writes siren.app.json in the working folder from the
 * template, never over a file that is there, and adds the env files `apply`
 * writes to .gitignore by name, so their key stays out of git and a
 * committed `.env.example` stays in. Then says where `SIREN_APP_URL` goes,
 * how to add a feature, and how Siren reaches a handler on this machine.
 * Sends nothing.
 */
export async function appsInit(input: CommandInput): Promise<number> {
  const { io, values } = input;
  const key = typeof values.key === 'string' ? values.key : keyFromFolder(io.cwd);
  if (!isAppKey(key)) {
    throw new CliUsageError(
      '--key takes lowercase letters and digits joined by single dashes, at most 64 characters and never requests, events, scopes or kinds, such as acme-payouts.',
    );
  }
  const name = typeof values.name === 'string' && values.name.trim() !== '' ? values.name.trim() : key;

  const org = await orgForInit(input);
  const path = join(io.cwd, APP_FILE_NAME);
  try {
    await writeFile(path, appFileTemplate(key, name, org), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliRefusal(`${path} is already there, so nothing was written.`);
    throw error;
  }
  const missing = await keepEnvFilesOutOfGit(io.cwd);
  const style = styleFor(io, 'stdout', {});
  io.stdout(
    style.report({
      headline: `Created ${style.bold(APP_FILE_NAME)}`,
      rows: [
        ['App', key],
        ...(org === undefined ? [] : [['Org', org] as const]),
        ['Feature', `notify · ${kindName('postConversionAction')}`],
        ...(missing.length > 0 ? [['Ignored', `${missing.join(', ')} (added to .gitignore)`] as const] : []),
      ],
      next: [
        { text: "Set SIREN_APP_URL to your handler's https address", aside: 'in .env or your shell' },
        { text: style.command(input.command('apps apply')) },
      ],
      tips: ['Siren sends requests only to https, so run your handler on an https address.', `Add features in ${APP_FILE_NAME}. Your editor completes them.`],
    }),
  );
  return 0;
}

/** Adds to `.gitignore` in `folder` each env file line apply writes and it lacks, and answers the lines added. */
async function keepEnvFilesOutOfGit(folder: string): Promise<string[]> {
  const ignorePath = join(folder, '.gitignore');
  const ignored = await readText(ignorePath);
  const have = (ignored ?? '').split(/\r?\n/);
  const missing = IGNORED.filter((line) => !have.includes(line));
  if (missing.length > 0) {
    await writeFile(ignorePath, `${ignored ?? ''}${ignored && !ignored.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
  return missing;
}

/**
 * `siren apps pull <key> [file] [--url-env] [--yes] [--json]`: writes
 * siren.app.json, or the file named, from the app on Siren, so `siren apps
 * diff` finds nothing to change straight after (CLI pass 2, finding 6).
 * It reads `GET /apps/{key}` once. The file holds the name, the
 * description, the url, the key's scopes as Siren stores them, the
 * events, the problem contacts and each active feature with the settings
 * its kind takes. An archived feature is left out, since naming it brings
 * it back. `--url-env` writes `${SIREN_APP_URL}` in place of the url. The
 * file names the organization for a person in several, so later commands
 * act in the same one. It asks before replacing a file, `--yes` skips the
 * question, and with no terminal and no `--yes` it writes nothing. Like
 * init, it keeps the env files apply writes out of git. It prints the
 * url's host, never the url.
 */
export async function appsPull(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const key = appKeyArgument(input.args[0] ?? '');
  const shown = input.args[1] ?? APP_FILE_NAME;
  const path = resolve(io.cwd, shown);
  const session = await run.signedIn();
  const app = await run.siren().apps.retrieve(key);
  const urlEnv = values['url-env'] === true;
  const org = membershipsOf(session).length > 1 ? (run.orgChoice?.org.orgSlug || String(run.orgChoice?.org.orgId ?? session.orgId)) : undefined;
  const file = pulledFile(app, org, urlEnv);
  const json = values.json === true;

  if ((await readText(path)) !== undefined && values.yes !== true) {
    const again = run.command(`apps pull ${key}${input.args[1] === undefined ? '' : ` ${shown}`} --yes`);
    if (!io.interactive || json) {
      throw new CliRefusal(`Nothing written: ${shortPath(io.cwd, path)} is already there.`, { why: 'Pulling replaces it with the app on Siren.', fix: again });
    }
    const typed = (await io.prompt(`Replace ${shortPath(io.cwd, path)}? [y/N] `)).trim().toLowerCase();
    if (typed !== 'y' && typed !== 'yes') {
      const err = styleFor(io, 'stderr', values);
      io.stderr(err.rich ? `${err.dim('Nothing written.')}\n` : 'siren: Nothing was written.\n');
      return 1;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  const ignored = await keepEnvFilesOutOfGit(io.cwd);

  if (json) {
    run.print(JSON.stringify({ path: shortPath(io.cwd, path), file }, null, 2));
    return 0;
  }
  const out = styleFor(io, 'stdout', values);
  const active = app.features.filter((item) => item.status !== 'archived');
  const archived = app.features.filter((item) => item.status === 'archived');
  const host = typeof app.url === 'string' && app.url !== '' ? hostOf(app.url) : undefined;
  const rows: Array<readonly [string, string]> = [
    ...(org === undefined ? [] : [['Org', clean(org)] as const]),
    ['Features', active.length === 0 ? out.dim('none') : clean(active.map((item) => item.key).join(', '))],
    ...(host === undefined ? [] : [['URL', urlEnv ? 'from SIREN_APP_URL' : `${clean(host)}, written in the file`] as const]),
    ...(archived.length > 0 ? [['Left out', `${clean(archived.map((item) => item.key).join(', '))}, archived`] as const] : []),
    ...(ignored.length > 0 ? [['Ignored', `${ignored.join(', ')} (added to .gitignore)`] as const] : []),
  ];
  const tips = [
    ...(host !== undefined && urlEnv ? ["Set SIREN_APP_URL to the app's url in .env or your shell before you run apply."] : []),
    ...(host !== undefined && !urlEnv ? [`${unbroken('--url-env')} writes \${SIREN_APP_URL} in place of the url, for a url that differs per machine.`] : []),
  ];
  run.print(
    out
      .report({
        headline: `Wrote ${out.bold(shortPath(io.cwd, path))} from ${out.bold(clean(key))}`,
        rows,
        next: [{ text: out.command(run.command(input.args[1] === undefined ? 'apps diff' : `apps diff ${shown}`)), aside: 'check the file matches Siren' }],
        tips,
      })
      .replace(/\n$/, ''),
  );
  return 0;
}

/** The app file for `app` as Siren holds it, in the shape `parseAppFile` reads. */
function pulledFile(app: App, org: string | undefined, urlEnv: boolean): Record<string, unknown> {
  const hasAddress = typeof app.url === 'string' && app.url !== '';
  const scopes = app.apiKey === null || app.apiKey === undefined ? [] : storedScopes(app.apiKey.scopes ?? app.scopes ?? []);
  const features: Record<string, Record<string, unknown>> = {};
  for (const item of app.features) {
    if (item.status === 'archived') continue;
    features[item.key] = pulledFeature(item);
  }
  const body: Record<string, unknown> = {
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    ...(hasAddress ? { url: urlEnv ? '${SIREN_APP_URL}' : app.url } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(hasAddress && Array.isArray(app.events) && app.events.length > 0 ? { events: [...app.events] } : {}),
    ...(Array.isArray(app.contacts) && app.contacts.length > 0 ? { contacts: [...app.contacts] } : {}),
    ...(Object.keys(features).length > 0 ? { features } : {}),
  };
  return { $schema: APP_FILE_SCHEMA_PATH, version: 1, ...(org === undefined ? {} : { org }), description: RECIPE_NOTE, apps: { [app.key]: body } };
}

/** One feature for the file: its kind and name, its description when it has one, and the settings its kind takes. */
function pulledFeature(item: AppFeature): Record<string, unknown> {
  const settings = item.settings ?? {};
  const feature: Record<string, unknown> = { kind: item.kind, name: item.name };
  if (item.description) feature.description = item.description;
  if (item.kind === FeatureKind.PayoutMethod && settings.currencies !== undefined) feature.currencies = [...settings.currencies];
  if (settings.answerWindowMinutes !== undefined) feature.answerWindowMinutes = settings.answerWindowMinutes;
  if (item.kind === FeatureKind.MetricCalculation && settings.scoresMoney === true) feature.scoresMoney = true;
  if (item.kind === FeatureKind.IncentiveType && settings.conversionTypes !== undefined) feature.conversionTypes = [...settings.conversionTypes];
  if (item.kind === FeatureKind.CustomEvent) {
    if (settings.fields !== undefined && Object.keys(settings.fields).length > 0) feature.fields = structuredClone(settings.fields);
    if (settings.domains !== undefined && settings.domains.length > 0) feature.domains = [...settings.domains];
  }
  return feature;
}

/** The host of `url`, or the url's text when it is no url. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Acme (acme), live": the organization a write acts in, and whether it is live, for the question before the write. */
export function orgNamed(session: { orgName: string; orgSlug?: string; orgId: number; edition: string }): string {
  return `${clean(session.orgName)} (${session.orgSlug === undefined ? session.orgId : clean(session.orgSlug)}), ${session.edition === 'production' ? 'live' : 'sandbox'}`;
}

/**
 * The organization `apps init` writes as "org": the one --org names, else,
 * for a person in several, the one they pick when asked in a terminal.
 * None for a person in one organization, for a person not logged in, and
 * with no terminal to ask in. Reads credentials.json and sends nothing.
 */
async function orgForInit(input: CommandInput): Promise<string | undefined> {
  const flag = typeof input.values.org === 'string' && input.values.org !== '' ? input.values.org : undefined;
  const session = (await input.kept?.()) ?? null;
  if (session === null) return flag;
  const memberships = membershipsOf(session);
  if (flag !== undefined) {
    const found = findOrg(memberships, flag);
    if (found === undefined) throw new CliRefusal(`You are not in an organization named ${flag}. Yours are ${orgList(memberships)}.`);
    return found.orgSlug || String(found.orgId);
  }
  if (memberships.length < 2 || !input.io.interactive) return undefined;
  const chosen = await askOrg(input.io, memberships);
  return chosen.orgSlug || String(chosen.orgId);
}

/**
 * The `SIREN_APP_` lines of the `.env` file in `folder`, as `NAME=value`,
 * `export NAME=value`, or with the value in quotes. Every other line is let
 * go. Empty when there is no such file.
 */
async function appVariablesIn(folder: string): Promise<Record<string, string>> {
  const text = await readText(join(folder, '.env'));
  const found: Record<string, string> = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(SIREN_APP_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    found[match[1]!] = value;
  }
  return found;
}

/** The scheme and host of an app's url, which a plan may show, since the path or query may hold a secret. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
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
  const json = input.values.json === true;
  const plan = await readPlan(input, run, 'apply');
  const { shown, path, parsed, shell, session, key, params, changes, lines, envPath } = plan;
  const out = styleFor(io, 'stdout', input.values);
  const err = styleFor(io, 'stderr', input.values);
  if (lines.length === 0) {
    if (json) run.print(JSON.stringify({ plan: planData(plan), applied: false }, null, 2));
    else {
      run.print(out.success(`${out.bold(key)} already matches ${shown}. Nothing to send.`));
      offNote(run, out, plan);
    }
    return 0;
  }
  const org = orgNamed(session);
  if (json && input.values.yes !== true) {
    // A script gets the plan, and nothing is sent without --yes, as with no terminal.
    run.print(JSON.stringify({ plan: planData(plan), applied: false }, null, 2));
    return 1;
  }
  if (!json) printPlan(run, out, plan);
  if (input.values.yes !== true) {
    const question = changes.isNew ? `Make ${key} in ${org}? [y/N] ` : `Apply to ${org}? [y/N] `;
    if (!io.interactive) {
      const again = run.command(input.args[0] === undefined ? 'apps apply --yes' : `apps apply ${shown} --yes`);
      io.stderr(
        err.rich
          ? `${err.warning("Nothing sent: there's no terminal to ask in.")}\n${err.next(`${err.command(again)} applies ${lines.length === 1 ? 'it' : 'them'} without asking`)}\n`
          : `siren: Nothing was sent. Run ${again} to apply ${lines.length === 1 ? 'it' : 'them'} without asking.\n`,
      );
      return 1;
    }
    if (!changes.isNew) run.print(out.dim('The last write wins, so this replaces anything changed in the dashboard since.'));
    const typed = (await io.prompt(question)).trim().toLowerCase();
    if (typed !== 'yes' && typed !== 'y') {
      io.stderr(err.rich ? `${err.dim('Nothing sent.')}\n` : 'siren: Nothing was sent.\n');
      return 1;
    }
  }
  void path;

  const siren = run.siren();
  const spinner = err.rich ? err.spinner(changes.isNew ? `Making ${key}` : `Applying ${shown}`, (text) => io.stderr(text)) : undefined;
  let app: Awaited<ReturnType<typeof siren.apps.declare>>;
  try {
    app = await siren.apps.declare(key, params);
  } finally {
    spinner?.cancel();
  }

  const envName = shortPath(io.cwd, envPath);
  const rows: Array<readonly [string, string]> = [];
  const tips: string[] = [];
  let saved: string | false = '';
  if (app.created) saved = await saveSecrets(run, key, envPath, { rawKey: app.rawKey, signingSecret: app.signingSecret }, false);
  // A later declaration that gave the app its first address answers the address's secret once.
  else if (app.signingSecret !== undefined) saved = await saveSecrets(run, key, envPath, { signingSecret: app.signingSecret }, false);
  await run.remember(key, envPath);
  if (saved === false) return 1;
  if (json) {
    // The key and secret went to the env file. They never print, here or anywhere.
    const { rawKey: _rawKey, signingSecret: _signingSecret, ...shownApp } = app as typeof app & { rawKey?: unknown; signingSecret?: unknown };
    run.print(JSON.stringify({ plan: planData(plan), applied: true, app: shownApp }, null, 2));
    return 0;
  }
  if (saved !== '') rows.push([app.created ? 'Key' : 'Secret', saved]);
  for (const item of app.features) rows.push([clean(item.key), featureRow(item)]);
  if (Array.isArray(app.events) && app.events.length > 0) rows.push(['Events', `${clean(app.events.join(', '))}${planMark(app.eventsAccess, ', so Siren does not send them')}`]);
  for (const name of parsed.filled) rows.push(['URL from', `${name}${shell(name) ? '' : ' in .env'}`]);
  if (app.features.some((item) => item.status === 'archived')) {
    const again = unbroken(run.command(input.args[0] === undefined ? 'apps apply' : `apps apply ${shown}`));
    tips.push(`Siren keeps an archived feature while a record selects it, and never calls it. Name it in ${shown} again and run ${again} to bring it back.`);
  }
  if (!app.created && (await envValue(envPath, 'SIREN_API_KEY')) === undefined) {
    // An app made in the dashboard may hold no key, and Siren refuses to rotate one it lacks (409 `app_key_missing`).
    if (app.apiKey === null || app.apiKey === undefined) tips.push(`${key} holds no key, so ${envName} has none. ${unbroken(run.command(`apps add-key ${key}`))} makes one and saves it there.`);
    // CLI pass 2, finding 2: a running service may hold the key, so never advise rotating it.
    else tips.push(`${envName} holds no key for ${key}, which is fine when your service has one. ${unbroken(run.command(`apps rotate-key ${key}`))} would save a new one here and revoke the one in use.`);
  }
  const next = app.created
    ? [
        { text: out.command(`node --env-file=${envName} server.js`), aside: 'run your handler with its key' },
        // A read, which needs no --live.
        { text: out.command(commandLine(run.target, 'apps requests --follow', false)), aside: 'watch what Siren sends it' },
      ]
    : [];
  run.print(out.report({ headline: `${app.created ? 'Made' : 'Updated'} ${out.bold(key)} in ${clean(session.orgName)}`, rows, next, tips }).replace(/\n$/, ''));
  return 0;
}

/** What apply would do: the file it read, the app it names, and the changes Siren would take. */
interface Plan {
  shown: string;
  path: string;
  parsed: ReturnType<typeof parseAppFile> & { file: NonNullable<ReturnType<typeof parseAppFile>['file']> };
  shell: (name: string) => boolean;
  session: StoredSession;
  key: string;
  params: ReturnType<typeof declarationFor>['params'];
  changes: ReturnType<typeof appChanges>;
  lines: string[];
  envPath: string;
  /** False when Siren holds the app and it is off, true when it is on, undefined for a new app. */
  on: boolean | undefined;
}

/**
 * Reads the app file and the app on Siren, and works out what apply would
 * change. Apply first checks the env file it will write to. Diff writes
 * nothing, so it skips that check.
 */
async function readPlan(input: CommandInput, run: CommandContext, mode: 'apply' | 'diff'): Promise<Plan> {
  const { io } = input;
  const shown = input.args[0] ?? APP_FILE_NAME;
  const path = resolve(io.cwd, shown);
  const text = await readText(path);
  if (text === undefined) throw new CliRefusal(`There is no app file at ${path}. Write one with ${run.command('apps init')}.`);

  // The shell wins over .env beside the file, as Node's --env-file and dotenv do.
  const fromFile = await appVariablesIn(dirname(path));
  const shell = (name: string) => io.env[name] !== undefined && io.env[name] !== '';
  const parsed = parseAppFile(text, { ...fromFile, ...Object.fromEntries(Object.entries(io.env).filter(([name]) => shell(name))) });
  if (parsed.file === null) {
    for (const problem of parsed.problems) {
      // CLI pass 2, finding 11: a message that already starts with its path, or a shorter part of it, names its place once.
      const segments = problem.path.split('.');
      const named = segments.some((_, at) => problem.message.startsWith(segments.slice(0, at + 1).join('.')));
      const at = problem.path === '' || named ? '' : `${problem.path}: `;
      io.stderr(`${shown}:${problem.line}:${problem.column}: ${at}${problem.message}\n`);
    }
    throw new CliRefusal(`${shown} has ${parsed.problems.length === 1 ? 'a problem' : `${parsed.problems.length} problems`}, so nothing was sent.`);
  }

  run.appFilePath = path;
  const session = await run.signedIn();
  const { key, params } = declarationFor(parsed.file);
  if (params.url != null && onThisMachine(params.url)) {
    run.warn(
      "siren: The app's url is on this machine's own address, which a Siren running in a container cannot reach. " +
        'Use host.docker.internal in its place, and see "Running against your own Siren Cloud" in the README.',
    );
  }
  const envPath = join(dirname(path), run.envFileName());
  if (mode === 'apply') {
    const problem = await envFileProblem(envPath);
    if (problem !== undefined) throw new CliRefusal(`${problem.line} Nothing was sent.`);
    const held = await envValue(envPath, 'SIREN_BASE_URL');
    if (held !== undefined && held !== run.target.baseUrl) {
      throw new CliRefusal(
        `${envPath} holds the key for ${held}, and this apply is for ${run.target.baseUrl}, so nothing was sent. ` +
          `Move that file aside to keep its key, then run ${run.command('apps apply')} again.`,
      );
    }
  }
  const current = await run
    .siren()
    .apps.retrieve(key)
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    });
  await checkNames(run, input, shown, current, params);
  const changes = appChanges(current, params);
  if (current !== undefined && (current.apiKey === null || current.apiKey === undefined) && (params.scopes ?? []).length > 0) {
    run.warn(
      `siren: ${shown} names scopes, and ${key} holds no key, so they reach nothing. ` +
        `Make one with ${run.command(`apps add-key ${key}`)}, then run ${run.command('apps apply')} again to give it these scopes.`,
    );
  }
  // `GET /apps/{key}` gives each feature its `uses` for a person who may change the app (GetApp.php),
  // so apply reads no feature route, which a personal access token cannot reach.
  const uses = changes.dropped.map(({ item }) => (typeof item.uses === 'number' ? item.uses : undefined));
  changes.dropped.forEach(({ item }, at) => refuseKindChange(item, uses[at], params.features ?? [], shown));
  const removals = changes.dropped.map(({ item }, at) => droppedLine(item, uses[at]));
  const on = current === undefined ? undefined : current.status === 'active';
  return { shown, path, parsed: parsed as Plan['parsed'], shell, session, key, params, changes, lines: [...changes.lines, ...removals], envPath, on };
}

/**
 * CLI pass 2, finding 5: checks each scope and event the file names, and
 * the app does not hold yet, against the lists the Siren in use serves
 * (`GET /apps/scopes` and `GET /apps/events`), so a typo is refused before
 * the plan with the nearest real name, not by Siren after the question.
 * A list it cannot read, as with a token that may not, leaves the check
 * to Siren. A wildcard scope such as `*` is Siren's to judge too. Prints
 * one line per problem, as the file check does, then refuses.
 */
async function checkNames(run: CommandContext, input: CommandInput, shown: string, current: App | undefined, params: Plan['params']): Promise<void> {
  const heldScopes = new Set<string>(current === undefined ? [] : (current.apiKey?.scopes ?? current.scopes ?? []));
  const heldEvents = new Set<string>(current?.events ?? []);
  // Compared as Siren stores them, so a scope `*` already covers is not new.
  const newScopes = storedScopes(params.scopes ?? []).filter((scope) => !heldScopes.has(scope) && !scope.includes('*'));
  const newEvents = (params.events ?? []).filter((event) => !heldEvents.has(event));
  const problems: string[] = [];
  const siren = run.siren();
  if (newScopes.length > 0) {
    const groups = await siren.apps.scopes().catch(() => undefined);
    const known = groups === undefined ? undefined : Object.values(groups).flatMap((entries) => (entries ?? []).map((entry) => entry.scope));
    for (const scope of known === undefined ? [] : newScopes.filter((scope) => !known.includes(scope))) {
      const offer = suggestions(scope, known!, /:/);
      problems.push(`scopes: "${clean(scope)}" is not a scope an app's key may hold.${offer.length === 0 ? '' : ` Did you mean ${either(offer)}?`}`);
    }
  }
  if (newEvents.length > 0) {
    const catalog = await siren.apps.events().catch(() => undefined);
    const known = catalog?.map((entry) => entry.event);
    for (const event of known === undefined ? [] : newEvents.filter((event) => !known.includes(event))) {
      const offer = suggestions(event, known!, /\./);
      problems.push(`events: Siren sends no event "${clean(event)}".${offer.length === 0 ? '' : ` Did you mean ${either(offer)}?`}`);
    }
  }
  if (problems.length === 0) return;
  for (const problem of problems) input.io.stderr(`${shown}: ${problem}\n`);
  const scopesWrong = problems.some((problem) => problem.startsWith('scopes:'));
  const eventsWrong = problems.some((problem) => problem.startsWith('events:'));
  const list = scopesWrong && eventsWrong ? 'apps scopes' : scopesWrong ? 'apps scopes' : 'apps events';
  throw new CliRefusal(`${shown} has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}, so nothing was sent.`, {
    fix: run.command(list),
    fixWords: scopesWrong && eventsWrong ? `and ${run.command('apps events')} list what Siren offers` : 'lists what Siren offers',
  });
}

/** The plan as a person reads it: a header with the app and the organization, then one marked line per change. */
function printPlan(run: CommandContext, out: Style, plan: Plan): void {
  run.print(`${out.bold('Plan')}  ${out.bold(plan.key)} → ${orgNamed(plan.session)}`);
  run.print('');
  for (const line of plan.lines) {
    // A terminal gets lines that fit it. A pipe gets each change on one line, for a script to read.
    const [first = '', ...rest] = out.rich ? wrapWords(line, REPORT_WIDTH - 4) : [line];
    run.print(`  ${planMarker(out, line)} ${first}`);
    for (const more of rest) run.print(`    ${more}`);
  }
  const origin = plan.params.url == null ? undefined : originOf(plan.params.url);
  if (plan.changes.isNew && origin !== undefined) run.print(`  ${out.dim('→')} sends its requests to ${origin}`);
  run.print('');
  offNote(run, out, plan);
}

/**
 * CLI pass 2, finding 10: a warning that the app is off, so its features
 * get nothing from Siren whatever the file says, and the command that
 * turns it on. Nothing for an app that is on or new.
 */
function offNote(run: CommandContext, out: Style, plan: Plan): void {
  if (plan.on !== false) return;
  run.print(out.warning(`${plan.key} is off, so Siren sends it nothing until ${out.command(run.command(`apps on ${plan.key}`))}.`));
}

/** The plan as data, for `--json`: the app, the organization, whether it is new or matches, and each change as add, remove or change. */
function planData(plan: Plan): Record<string, unknown> {
  const origin = plan.params.url == null ? null : (originOf(plan.params.url) ?? null);
  return {
    app: plan.key,
    org: { id: plan.session.orgId, name: plan.session.orgName, slug: plan.session.orgSlug ?? null },
    new: plan.changes.isNew,
    matches: plan.lines.length === 0,
    changes: plan.lines.map((text) => ({ op: /^(adds|makes) /.test(text) ? 'add' : /^removes /.test(text) ? 'remove' : 'change', text })),
    sendsTo: plan.changes.isNew ? origin : null,
    on: plan.on ?? null,
  };
}

/**
 * `siren apps diff [file]`: what apply would change, with nothing sent.
 * It reads the app from Siren, prints the plan or that the file matches,
 * and exits 0 when the file matches and 3 when apply would change
 * something, as `terraform plan -detailed-exitcode` and `git diff
 * --exit-code` do, so a CI check can tell a difference from a failure,
 * which keeps 1 and 2. It needs no --live, since it only reads.
 * `--json` prints the plan as data.
 */
export async function appsDiff(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const plan = await readPlan(input, run, 'diff');
  if (input.values.json === true) {
    run.print(JSON.stringify(planData(plan), null, 2));
    return plan.lines.length === 0 ? 0 : 3;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  if (plan.lines.length === 0) {
    run.print(out.success(`${out.bold(plan.key)} already matches ${plan.shown}. Nothing to send.`));
    offNote(run, out, plan);
    return 0;
  }
  printPlan(run, out, plan);
  run.print(out.next(`${out.command(run.command(input.args[0] === undefined ? 'apps apply' : `apps apply ${plan.shown}`))} makes these changes.`));
  return 3;
}

/** `+` for what a plan adds, `-` for what it removes, `~` for what it changes, colored when the terminal takes color. */
function planMarker(style: Style, line: string): string {
  if (/^(adds|makes) /.test(line)) return style.green('+');
  if (/^removes /.test(line)) return style.red('-');
  return style.amber('~');
}

/** A feature's row after apply: its `app:{id}`, its kind, and any mark for its state or plan. */
function featureRow(item: AppFeature): string {
  const archived = item.status === 'archived' ? ' · archived' : '';
  return `${clean(item.ref)} · ${clean(kindName(item.kind))}${archived}${planMark(item)}`;
}

/** `path` relative to `cwd` when it is inside it, such as `.env.sandbox`, else the absolute path. */
function shortPath(cwd: string, path: string): string {
  const inside = relative(cwd, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
}

/**
 * Refuses a file that gives a feature Siren holds a different kind (CLI pass
 * 2, finding 3). A kind locks once Siren makes the feature, so the plan
 * would delete it or archive it and make a new one with a new `app:{id}`,
 * and a record that stores the old id would keep pointing at the old one.
 * `uses` is how many records select it, undefined when that read failed.
 */
function refuseKindChange(item: AppFeature, uses: number | undefined, wanted: readonly AppFeatureDeclaration[], shown: string): void {
  const next = wanted.find((feature) => feature.key === item.key && feature.kind !== item.kind);
  if (next === undefined) return;
  const article = (label: string) => (/^[AEIOU]/.test(label) ? 'an' : 'a');
  const was = kindLabel(item.kind);
  const now = kindLabel(next.kind);
  const replaced = `applying this would replace ${item.ref} with a new feature and a new id`;
  const consequence =
    uses === 0
      ? `${replaced}. Nothing selects ${item.ref} today.`
      : uses === undefined
        ? `${replaced}, and any record that selects ${item.ref} would keep the old one.`
        : `${replaced}, and the ${uses === 1 ? 'record that selects' : `${uses} records that select`} ${item.ref} would keep the old one.`;
  throw new CliRefusal(
    `${item.key} is ${article(was)} ${was} on Siren, and ${shown} makes it ${article(now)} ${now}. ` +
      `A feature's kind locks once Siren makes it, so ${consequence} ` +
      `Nothing was sent. Give the new feature its own key, and keep or remove ${item.key} on its own.`,
  );
}


/**
 * `siren apps scopes [--json]`: the scopes an app's key may hold on this
 * Siren, from `GET /apps/scopes`, one line each with what it allows, or the
 * JSON Siren sent. CLI pass 2, finding 5.
 */
export async function appsScopes(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const groups = await run.siren().apps.scopes();
  if (input.values.json === true) {
    run.print(JSON.stringify(groups, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', {});
  const rows = Object.values(groups).flatMap((entries) => (entries ?? []).map((entry) => [clean(entry.scope), clean(entry.label)]));
  for (const line of out.table(['SCOPE', 'ALLOWS'], rows, widthOf(input, out))) run.print(line);
  return 0;
}

/**
 * `siren apps events [--json]`: the events Siren can send an app's address,
 * from `GET /apps/events`, one line each with what it means, in the order
 * the dashboard groups them, or the JSON Siren sent. CLI pass 2, finding 5.
 */
export async function appsEvents(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const catalog = await run.siren().apps.events();
  if (input.values.json === true) {
    run.print(JSON.stringify(catalog, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', {});
  const rows = catalog.map((entry) => [clean(entry.event), clean(entry.label)]);
  for (const line of out.table(['EVENT', 'MEANS'], rows, widthOf(input, out))) run.print(line);
  return 0;
}

/** `siren apps list [--json]`: a count line and a table of the apps, or the JSON Siren sent. */
export async function appsList(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const session = await run.signedIn();
  const apps = await run.siren().apps.list();
  if (input.values.json === true) {
    run.print(JSON.stringify(apps, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', {});
  if (apps.length === 0) {
    run.print(`No apps in ${orgNamed(session)} yet. Write one with ${run.command('apps init')}, then run ${run.command('apps apply')}.`);
    return 0;
  }
  run.print(out.bold(`${apps.length} ${apps.length === 1 ? 'app' : 'apps'} in ${orgNamed(session)}`));
  run.print('');
  const rows = apps.map((app) => {
    const count = attentionCount(app);
    return [
      clean(app.key),
      stateCell(out, app),
      String(app.features.length),
      count === 0 ? out.dim('–') : out.bold(out.amber(`${count} ${count === 1 ? 'request' : 'requests'}`)),
      addressCell(out, app),
    ];
  });
  for (const line of out.table(['APP', 'STATE', 'FEATURES', 'ATTENTION', 'ADDRESS'], rows, widthOf(input, out))) run.print(line);
  const waiting = apps.filter((app) => attentionCount(app) > 0);
  if (waiting.length === 1) attentionTip(run, out, waiting[0]!);
  else if (waiting.length > 1) {
    run.print('');
    run.print(out.next(`${out.command(run.command('apps requests --attention'))} lists the requests that need you.`));
  }
  return 0;
}

/** `siren apps show <key> [--json]`: the app in an aligned block, then its features as a table. */
export async function appsShow(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const key = appKeyArgument(input.args[0] ?? '');
  await run.signedIn();
  const app = await run.siren().apps.retrieve(key);
  if (input.values.json === true) {
    run.print(JSON.stringify(app, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', {});
  const prefix = app.apiKey?.prefix ?? app.apiKeyPrefix;
  const events = Array.isArray(app.events) ? app.events : [];
  const rows: Array<readonly [string, string]> = [
    ['State', stateCell(out, app)],
    ['Address', addressCell(out, app)],
    ...(typeof prefix === 'string' && prefix !== '' ? [['Key', `${prefix}…`] as const] : [['Key', out.dim('none')] as const]),
    ...(events.length > 0 ? [['Events', `${clean(events.join(', '))}${planMark(app.eventsAccess, ', so Siren does not send them')}`] as const] : []),
  ];
  // Each feature's kind reads "Post-conversion action (postConversionAction)" when the line fits.
  // When it does not, the code name goes before NAME is cut, and a Kinds row above names the code names.
  const width = widthOf(input, out);
  const featureRows = (label: (kind: string) => string) =>
    app.features.map((item) => [
      clean(item.ref),
      clean(item.key),
      clean(label(item.kind)),
      `${clean(item.name)}${item.status === 'archived' ? out.dim(' · archived') : ''}${planMark(item).replace(/^ {2}/, ' · ')}`,
    ]);
  const HEADERS = ['ID', 'KEY', 'KIND', 'NAME'];
  const full = featureRows(kindLabel);
  const fitsFull = out.table(HEADERS, full, Number.POSITIVE_INFINITY).every((line) => visibleLength(line) <= width);
  const features = fitsFull ? full : featureRows(kindName);
  if (!fitsFull) rows.push(['Kinds', clean([...new Set(app.features.map((item) => item.kind))].join(', '))]);

  // The demo printed "cli-demo  cli-demo" for an app named after its key, so the name shows only when it differs.
  const named = clean(app.name) === clean(app.key) || clean(app.name) === '' ? '' : `  ${clean(app.name)}`;
  run.print(out.report({ headline: `${out.bold(clean(app.key))}${named}`, rows, mark: false }).replace(/\n$/, ''));
  if (app.features.length > 0) {
    run.print('');
    for (const line of out.table(HEADERS, features, width)) run.print(line);
  }
  if (attentionCount(app) > 0) attentionTip(run, out, app);
  return 0;
}

/** How many of the app's requests need a person, or 0 when Siren sends no count. */
function attentionCount(app: App): number {
  return typeof app.needsAttention === 'number' && app.needsAttention > 0 ? app.needsAttention : 0;
}

/** `● on` green or `○ off` dim in a terminal, `on` or `off` elsewhere. */
function stateCell(style: Style, app: App): string {
  if (app.status === 'active') return style.rich ? style.green('● on') : 'on';
  return style.rich ? style.dim('○ off') : 'off';
}

/** The host Siren sends the app's requests to, or `key only` for an app with no address. Never the whole url. */
function addressCell(style: Style, app: App): string {
  if (typeof app.url !== 'string' || app.url === '') return style.dim('key only');
  try {
    return new URL(app.url).host;
  } catch {
    return style.dim('an address');
  }
}

/** The widest a table may be: the terminal's columns, 80 in a terminal of unknown size, and no limit in a pipe. */
function widthOf(input: CommandInput, style: Style): number {
  if (!style.rich) return Number.POSITIVE_INFINITY;
  return input.io.screen?.size?.columns ?? 80;
}

/** The tip under an app with requests that need a person: how many, and the command that lists them. */
function attentionTip(run: CommandContext, out: Style, app: App): void {
  const count = attentionCount(app);
  run.print('');
  run.print(out.next(`${out.command(run.command(`apps requests --app ${app.key} --attention`))} lists the ${count} that ${count === 1 ? 'needs' : 'need'} you.`));
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
  const out = styleFor(io, 'stdout', values);
  if (part !== 'add-key' && values.yes !== true) {
    const why = part === 'key' ? 'The old key stops working at once.' : 'Siren signs with the new secret at once, and the app refuses requests until it reads it.';
    if (!io.interactive) throw new CliRefusal('Nothing sent: rotating needs a yes.', { why, fix: run.command(`${command} ${key} --yes`) });
    run.print(
      out.warning(
        part === 'key'
          ? 'Rotating the key revokes the old one at once, so anything still using it stops working.'
          : 'Rotating the signing secret makes Siren sign with the new one at once.',
      ),
    );
    const typed = (await io.prompt(`Rotate it in ${orgNamed(run.current())}? [y/N] `)).trim().toLowerCase();
    if (typed !== 'yes' && typed !== 'y') {
      // Saying no is the person's choice, so it reads as a quiet line, with exit 1 kept for scripts.
      const err = styleFor(io, 'stderr', values);
      io.stderr(err.rich ? `${err.dim(`Nothing sent. ${what.charAt(0).toUpperCase()}${what.slice(1)} still works.`)}\n` : `siren: Nothing was sent, and ${what} still works.\n`);
      return 1;
    }
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
  if (saved === false) return 1;
  const report =
    part === 'key'
      ? { headline: `Rotated the key of ${out.bold(key)}`, rows: [['Key', saved]] as const, tips: ['Siren revoked the old key. Restart your app so it reads the new one.'] }
      : part === 'secret'
        ? {
            headline: `Rotated the signing secret of ${out.bold(key)}`,
            rows: [['Secret', saved.replace(/^the new signing secret /, '')]] as const,
            tips: ['Siren signs with the new secret from now on. Restart your app so it reads it.'],
          }
        : {
            headline: `Made a key for ${out.bold(key)}`,
            rows: [['Key', saved]] as const,
            next: [{ text: out.command(run.command('apps apply')), aside: 'give the key the scopes your app file names' }],
          };
  run.print(out.report(report).replace(/\n$/, ''));
  return 0;
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
    if (typed !== key) {
      throw new CliRefusal(io.interactive ? `Nothing deleted: you typed something other than ${key}.` : 'Nothing deleted: deleting needs a yes.', {
        why: 'It revokes the key and cannot be undone.',
        fix: run.command(`apps delete ${key} --yes`),
      });
    }
  }
  await run.signedIn();
  try {
    await run.siren().apps.delete(key);
  } catch (error) {
    if (error instanceof ConflictError && appErrorCode(error) === 'app_in_use') throw new CliRefusal(await inUseLines(run, key, error));
    throw error;
  }
  const out = styleFor(io, 'stdout', values);
  run.print(out.success(`Deleted ${out.bold(key)}. Its key no longer works.`));
  return 0;
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
  const named = clean(plan);
  return `  requires ${named.charAt(0).toUpperCase()}${named.slice(1)}${then}`;
}

/** Turns the app on or off and prints its new state. */
async function setStatus(input: CommandInput, status: 'active' | 'inactive'): Promise<number> {
  const run = contextOf(input);
  const key = appKeyArgument(input.args[0] ?? '');
  await run.signedIn();
  const app = await run.siren().apps.setStatus(key, status);
  const out = styleFor(input.io, 'stdout', input.values);
  const shown = out.bold(clean(app.key));
  run.print(
    out.success(
      app.status === 'active'
        ? `${shown} is on. Siren sends it requests again.`
        : `${shown} is off. Siren sends it nothing until ${out.command(run.command(`apps on ${clean(app.key)}`))}.`,
    ),
  );
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
async function saveSecrets(run: CommandContext, key: string, envPath: string, secrets: ShownSecrets, revoked: boolean): Promise<string | false> {
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
  const where = shortPath(run.io.cwd, envPath);
  if (both) return `${rawKey.slice(0, 16)}… in ${where}, with its signing secret`;
  if (rawKey !== undefined) return `${rawKey.slice(0, 16)}… in ${where}`;
  return `the new signing secret in ${where}`;
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
