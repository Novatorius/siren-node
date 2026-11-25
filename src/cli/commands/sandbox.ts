import { isJsonObject, readObject, writeRecord } from '../../resources/record-requests';
import { AppErrorCode, SirenError, appErrorCode } from '../../errors';
import type { App, AppFeature } from '../../record-types';
import { CommandContext, contextOf } from '../context';
import type { CommandInput } from '../context';
import type { Membership } from '../session-auth';
import { borrowOrg, orgScope } from '../org';
import { SandboxRecords, counted, hostOf, onSandbox, transportOf } from '../sandboxes';
import type { SandboxCopy } from '../sandboxes';
import { clean, styleFor } from '../style';
import type { Report } from '../style';
import { CliRefusal, CliUsageError, LIVE_BASE_URL, resolveTarget } from '../targets';

/*
 * `siren sandbox create`, `list`, `reset` and `inbox`. Contract:
 * contract/devtools-sandbox.md in the run folder, "CLI commands".
 */

/**
 * The recipe stanzas a copy asks the live Siren for: every one but
 * `collaborators` and `mappings`, which hold the client's real people
 * (AP-A4133).
 */
export const COPIED_STANZAS = ['tracking', 'commerce', 'customEvents', 'programs', 'programGroups', 'distributors', 'collaboratorGroups', 'notifications'] as const;

/** The stanzas that are lists of records, with their nouns. */
const RECORD_STANZAS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['programs', 'Programs', 'program', 'programs'],
  ['programGroups', 'Groups', 'program group', 'program groups'],
  ['collaboratorGroups', 'Groups', 'collaborator group', 'collaborator groups'],
  ['distributors', 'Distributors', 'distributor', 'distributors'],
  ['customEvents', 'Custom events', 'custom event', 'custom events'],
];

/** The stanzas that are settings, not records. */
const SETTING_STANZAS = ['tracking', 'commerce', 'notifications'] as const;

/** The feature settings `PUT /apps/{key}` takes, as `GET /apps` answers them under `settings`. */
const FEATURE_SETTINGS = ['currencies', 'answerWindowMinutes', 'scoresMoney', 'conversionTypes', 'fields', 'domains'] as const;

/** How often and how long `create` waits on the import. */
const IMPORT_POLL_MS = 1000;
const IMPORT_POLLS = 180;

/** The `--limit` default and cap of `sandbox inbox`. */
const INBOX_DEFAULT = 20;
const INBOX_MAX = 100;

/** One thing a copy left behind, and why. */
interface NotCopied {
  what: string;
  why: string;
}

interface ImportDetail {
  jobId: string;
  status: string;
  errorMessage?: string | null;
  perStanzaProcessed?: Record<string, number>;
  perStanzaTotals?: Record<string, number>;
}

/** A recipe validation error, as Siren's 422 lists it under `errors`. */
interface RecipeProblem {
  path?: string;
  message?: string;
  code?: string;
}

/** The text of a string option, trimmed, or undefined when absent or blank. */
function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}


/** Prints one JSON object and nothing else. */
function printJson(input: CommandInput, value: unknown): void {
  input.io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The live Siren `create` reads from: `--live-url`, else `SIREN_LIVE_URL`,
 * else the one stored session made on a live Siren, else the live
 * deployment. A context for reads only, so it needs no `--live`.
 */
async function liveContext(run: CommandContext, input: CommandInput): Promise<CommandContext> {
  let address = text(input.values['live-url']) ?? text(input.io.env.SIREN_LIVE_URL);
  if (address === undefined) {
    const live = Object.entries(await run.store.all()).filter(([, session]) => session.edition === 'production');
    if (live.length === 1) address = live[0]![0];
  }
  const target = address === undefined ? resolveTarget({ live: true }, {}) : resolveTarget({ live: true, baseUrl: address }, {});
  return new CommandContext(input.io, target, true);
}

/**
 * The feature kinds an app may hold with no address, as Siren's
 * AppItemKindCatalog::needs() lists them. Every other kind needs one.
 */
const NEEDS_NO_ADDRESS: ReadonlySet<string> = new Set(['customEvent']);

/** True for Siren's refusal of features or events because the app has no address. */
function needsAnAddress(error: unknown): boolean {
  if (!(error instanceof SirenError) || error.statusCode !== 422) return false;
  // Siren's feat/apps still sends the code by its old name, app_items_need_key_and_address.
  const code = appErrorCode(error);
  if (code === AppErrorCode.FeaturesNeedKeyAndAddress || code === 'app_items_need_key_and_address') return true;
  const data = error.data as { field?: unknown } | undefined;
  return data?.field === 'events';
}

/**
 * The declaration that makes the same app on another Siren: its parts and
 * its active features, never a key, a secret, the live address or its
 * contacts, who are real people and stay on the live Siren. A sandbox
 * ask must never reach the client's real server, so the copy has no url
 * (AP-A4139b). Its events go with it when `events` is true.
 */
export function declarationOf(app: App, features: readonly AppFeature[], events = true): Record<string, unknown> {
  return {
    name: app.name,
    description: app.description,
    ...(events && app.events !== undefined && app.events.length > 0 ? { events: app.events } : {}),
    ...(app.apiKey !== null && app.apiKey !== undefined ? { scopes: app.scopes } : {}),
    features: features.map((feature) => {
      const settings: Record<string, unknown> = {};
      for (const name of FEATURE_SETTINGS) {
        const value = (feature.settings as Record<string, unknown> | undefined)?.[name];
        if (value !== undefined && value !== null) settings[name] = value;
      }
      return { kind: feature.kind, key: feature.key, name: feature.name, description: feature.description, ...settings };
    }),
  };
}

/**
 * The recipe with each `app:<live id>` that names a copied feature turned
 * into `app:<sandbox id>`. Answers the new recipe and the references it
 * could not turn, which name a feature that was not copied.
 */
export function rewriteFeatureRefs(recipe: unknown, refs: ReadonlyMap<string, string>): { recipe: unknown; unknown: string[] } {
  const missing = new Set<string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!/^app:\d+$/.test(value)) return value;
      const twin = refs.get(value);
      if (twin === undefined) missing.add(value);
      return twin ?? value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  return { recipe: walk(recipe), unknown: [...missing] };
}

/**
 * The recipe without the values at these dotted paths, such as
 * `programs.0.sorter`. A path that ends in a list index takes that entry out
 * of its list. Paths are taken longest and highest index first, so one
 * removal never moves another.
 */
export function withoutPaths(recipe: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(recipe)) as Record<string, unknown>;
  const ordered = [...paths].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const path of ordered) {
    const parts = path.split('.');
    const last = parts.pop();
    let holder: unknown = copy;
    for (const part of parts) holder = Array.isArray(holder) ? holder[Number(part)] : isJsonObject(holder) ? holder[part] : undefined;
    if (last === undefined) continue;
    if (Array.isArray(holder) && /^\d+$/.test(last)) holder.splice(Number(last), 1);
    else if (isJsonObject(holder)) delete holder[last];
  }
  return copy;
}

/** The problems of a 422 recipe refusal, from POST /recipes/preview or /recipes/apply, or none for any other error. */
function recipeProblems(error: unknown): RecipeProblem[] {
  if (!(error instanceof SirenError) || error.statusCode !== 422 || !isJsonObject(error.data)) return [];
  return Array.isArray(error.data.errors) ? (error.data.errors as RecipeProblem[]).filter(isJsonObject) : [];
}

/** True for a problem that names an app's feature, which no recipe may carry. The copy turns or drops those itself. */
function isAppChoice(problem: RecipeProblem): boolean {
  return problem.code === 'APP_FEATURE' || /app's feature/.test(problem.message ?? '');
}

/** The paths of a 422 recipe refusal that name an app's feature, which a recipe cannot carry. */
function appFeaturePaths(error: unknown): string[] {
  const problems = recipeProblems(error);
  const app = problems.filter((problem) => typeof problem.path === 'string' && isAppChoice(problem));
  return app.length > 0 && app.length === problems.length ? app.map((problem) => problem.path!) : [];
}

/**
 * The fields Siren refused, each at its recipe path, such as
 * `programGroups.group_1.sorter` with "Invalid sorter 'alphabetical'. Valid
 * values: newestBindingWins, oldestBindingWins." The style module prints
 * them as it prints an app file's problems (CLI pass 3, must-fix 3). Siren's
 * words are cleaned first.
 */
function refusedFields(problems: readonly RecipeProblem[]): Array<{ at: string; message: string }> {
  return problems.map((problem) => ({ at: clean(problem.path ?? 'recipe'), message: clean(problem.message ?? 'Refused.') }));
}

/**
 * `siren sandbox create --from <live org>`: copies a live organization's
 * setup into a new organization on the sandbox. The stored session keeps
 * its organization, so the next steps name the new one with `--org`.
 */
export async function create(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const json = input.values.json === true;
  const from = text(input.values.from);
  if (from === undefined) throw new CliUsageError('siren sandbox create needs --from with the slug or id of the live organization to copy.');
  await onSandbox(run, 'sandbox create');

  const live = await liveContext(run, input);
  if (live.target.baseUrl === run.target.baseUrl) {
    throw new CliRefusal(`${run.target.baseUrl} is the sandbox, so it cannot be the live Siren too.`, {
      why: 'Name the live Siren the setup comes from.',
      fix: `siren sandbox create --from ${from} --live-url <live address>`,
    });
  }
  if ((await live.targetEdition()) !== 'production') {
    throw new CliRefusal(`${live.target.baseUrl} is a sandbox Siren, and --from copies from a live one.`, {
      why: 'Nothing was made.',
      fix: `siren sandbox create --from ${from} --live-url <live address>`,
    });
  }
  // --from names the live organization the way --org names one anywhere else.
  const liveSession = await orgScope(live, input, await live.signedIn(), 'sandbox create', { name: from, list: 'orgs', from: '--from' });

  // Read everything from the live Siren before anything is made on the sandbox.
  const liveHttp = liveSession.http;
  const exported = await readObject<{ recipe?: unknown; skipped?: unknown }>(liveHttp, '/recipes/export', { include: COPIED_STANZAS.join(',') }, (body) =>
    isJsonObject(body.recipe) ? undefined : `Siren answered GET /recipes/export on ${live.target.baseUrl} with no recipe.`,
  );
  const recipe = exported.recipe as Record<string, unknown>;
  const apps = await liveSession.siren().apps.list();

  // All or nothing. Siren has no route that deletes a sandbox organization, so the setup is checked on the
  // sandbox before one is made. POST /recipes/preview runs apply's own validation and makes nothing. Only a
  // refused field of the setup stops the copy here. App choices are the copy's to turn or drop, and any other
  // failure leaves the check to the apply, which validates again.
  const copyName = `Copy of ${liveSession.orgName}`;
  const fixLive = {
    fixLead: `Fix it in ${clean(liveSession.orgName)} on ${hostOf(live.target.baseUrl)}, then run`,
    fix: input.command(`sandbox create --from ${from}`),
  };
  try {
    await writeRecord(transportOf(run), 'POST', '/recipes/preview', { ...recipe, configurationOnly: true, name: copyName });
  } catch (error) {
    const fields = recipeProblems(error).filter((problem) => !isAppChoice(problem));
    if (fields.length > 0) throw new CliRefusal(`Siren would refuse ${clean(liveSession.orgName)}'s setup, so nothing was made.`, {
        why: `Siren checked it on the sandbox first and refused ${counted(fields.length, 'field', 'fields')}.`,
        problems: refusedFields(fields),
        ...fixLive,
      });
  }

  const style = styleFor(input.io, 'stdout', { json });
  const progress = json ? null : style.spinner(`Making a sandbox organization for ${clean(liveSession.orgName)}`, (chunk) => input.io.stdout(chunk));

  const name = text(input.values.name) ?? `${liveSession.orgName} (sandbox)`;
  let org: Membership;
  let scope: Awaited<ReturnType<typeof borrowOrg>>;
  try {
    const made = await writeRecord<{ org?: Membership }>(transportOf(run), 'POST', '/sandbox/orgs', { name });
    if (!isJsonObject(made.org) || typeof made.org.orgId !== 'number') throw new CliRefusal("Siren made the organization but didn't say which it is.", { why: 'Its answer named no organization id, so the copy stopped there.', fix: input.command('sandbox list'), fixWords: 'to find it' });
    org = made.org;
    // A token for the new organization, for this run only.
    scope = await borrowOrg(run, org);
  } catch (error) {
    progress?.stop(false, 'No sandbox organization was made.');
    throw error;
  }
  // Siren named the new organization, so its slug is cleaned before any line shows it.
  const slug = clean(org.orgSlug);

  // Apps first, so the recipe's feature references can name the sandbox's own features.
  progress?.update(`Copying ${counted(apps.length, 'app', 'apps')} into ${slug}`);
  // Siren decides whether an app may have no address, so the declaration skips the SDK's own check (AP-A4139b).
  const declare = (key: string, body: Record<string, unknown>) =>
    writeRecord<{ features: AppFeature[] }>(scope.http, 'PUT', `/apps/${encodeURIComponent(key)}`, body);
  const refs = new Map<string, string>();
  const copiedApps: Array<{ key: string; features: number }> = [];
  const notCopied: NotCopied[] = [];
  for (const app of apps) {
    const features = app.features.filter((feature) => feature.status !== 'archived');
    try {
      // The answer holds the sandbox's new key and secret. Neither is read.
      let declared: { features: AppFeature[] };
      try {
        declared = await declare(app.key, declarationOf(app, features));
      } catch (error) {
        // A sandbox without listen's empty address (AP-A4118) refuses features and events with no url.
        // The copy then keeps the features that need no address, and lists the rest.
        if (!needsAnAddress(error)) throw error;
        const kept = features.filter((feature) => NEEDS_NO_ADDRESS.has(feature.kind));
        declared = await declare(app.key, declarationOf(app, kept, false));
        const left = features.length - kept.length;
        if (left > 0) notCopied.push({ what: `${app.key}: ${counted(left, 'feature', 'features')}`, why: 'this sandbox needs an address for them' });
        if (app.events !== undefined && app.events.length > 0) notCopied.push({ what: `${app.key} events`, why: 'this sandbox needs an address for them' });
      }
      // A Siren from before the feature rename answers `items`, which names no twin.
      const twins = Array.isArray(declared.features) ? declared.features : [];
      for (const feature of features) {
        const twin = twins.find((one) => one.key === feature.key && one.kind === feature.kind);
        if (twin !== undefined) refs.set(feature.ref ?? `app:${feature.id}`, twin.ref ?? `app:${twin.id}`);
      }
      copiedApps.push({ key: app.key, features: twins.length });
    } catch (error) {
      if (!(error instanceof SirenError)) throw error;
      notCopied.push({ what: `app ${app.key}`, why: error.message.replace(/^Siren: /, '') });
    }
    const archived = app.features.length - features.length;
    if (archived > 0) notCopied.push({ what: `${app.key} archived features`, why: `${archived} archived, left behind` });
  }

  // Then the setup, with each feature reference turned to the sandbox's own.
  progress?.update(`Applying ${clean(liveSession.orgName)}'s setup to ${slug}`);
  const rewritten = rewriteFeatureRefs(recipe, refs);
  let sent = rewritten.recipe as Record<string, unknown>;
  for (const ref of rewritten.unknown) notCopied.push({ what: `feature ${ref}`, why: 'names a feature that was not copied' });
  const http = scope.http;
  const applyRecipe = (body: Record<string, unknown>) =>
    writeRecord<ImportDetail>(http, 'POST', '/recipes/apply', { ...body, configurationOnly: true, name: copyName });
  let started: ImportDetail;
  try {
    try {
      started = await applyRecipe(sent);
    } catch (error) {
      // A recipe cannot name an app's feature in some places, such as a sorter. Those are left out and listed.
      const paths = appFeaturePaths(error);
      if (paths.length === 0) throw error;
      sent = withoutPaths(sent, paths);
      for (const path of paths) notCopied.push({ what: `app choice at ${path}`, why: 'a recipe cannot carry it. Pick it again here.' });
      started = await applyRecipe(sent);
    }
  } catch (error) {
    progress?.stop(false, `Made ${slug}, but its setup was not applied.`);
    if (!(error instanceof SirenError)) throw error;
    // The check above passed, so the sandbox refused something only the new organization shows. It stays, and the person is told so.
    const fields = recipeProblems(error).filter((problem) => !isAppChoice(problem));
    throw new CliRefusal(`Made ${slug}, but Siren refused its setup.`, {
      why: fields.length > 0 ? `Siren refused ${counted(fields.length, 'field', 'fields')} once the organization was made.` : clean(error.message.replace(/^Siren: /, '')),
      problems: refusedFields(fields),
      note: `Siren cannot delete a sandbox organization, so ${slug} stays, with ${copiedApps.length > 0 ? 'its apps and ' : ''}no setup.`,
      ...fixLive,
    });
  }

  let detail = started;
  for (let poll = 0; poll < IMPORT_POLLS && detail.status !== 'complete' && detail.status !== 'failed'; poll += 1) {
    await input.io.sleep(IMPORT_POLL_MS);
    detail = await readObject<ImportDetail>(http, `/recipes/imports/${encodeURIComponent(started.jobId)}`);
  }

  const copy: SandboxCopy = {
    baseUrl: run.target.baseUrl,
    orgId: org.orgId,
    orgSlug: org.orgSlug,
    orgName: org.orgName,
    from: { baseUrl: live.target.baseUrl, orgId: liveSession.orgId, orgSlug: liveSession.orgSlug, orgName: liveSession.orgName },
    copiedAt: new Date(input.io.now()).toISOString(),
  };
  await new SandboxRecords(input.io.configDir).add(copy);

  notCopied.unshift(
    { what: 'collaborators', why: 'real people stay on the live Siren. siren seed makes samples.' },
    { what: 'API keys and secrets', why: 'the sandbox made its own. None left the live Siren.' },
  );
  for (const [stanza, rows] of Object.entries(isJsonObject(exported.skipped) ? exported.skipped : {})) {
    if (Array.isArray(rows) && rows.length > 0) notCopied.push({ what: `${rows.length} ${stanza}`, why: 'the export leaves them out' });
  }

  const stanzas: Record<string, number> = {};
  for (const [stanza] of RECORD_STANZAS) {
    // A stanza is a list, or a map keyed by each record's recipe key.
    const records = sent[stanza];
    if (Array.isArray(records)) stanzas[stanza] = records.length;
    else if (isJsonObject(records)) stanzas[stanza] = Object.keys(records).length;
  }
  const settings = SETTING_STANZAS.filter((stanza) => sent[stanza] !== undefined && sent[stanza] !== null);
  const failed = detail.status !== 'complete';

  if (json) {
    printJson(input, {
      sandbox: { baseUrl: copy.baseUrl, orgId: copy.orgId, orgSlug: copy.orgSlug, orgName: copy.orgName },
      from: copy.from,
      copied: { apps: copiedApps, stanzas, settings },
      notCopied,
      import: { jobId: detail.jobId, status: detail.status, errorMessage: detail.errorMessage ?? null },
    });
    return failed ? 1 : 0;
  }

  if (failed) {
    progress?.stop(false, `Made ${slug}, but its setup did not finish importing.`);
    throw new CliRefusal(`The import into ${slug} ${detail.status === 'failed' ? 'failed' : 'did not finish in three minutes'}.`, {
      why: clean(detail.errorMessage ?? `Import ${detail.jobId} is ${detail.status}.`),
      note: `Its apps were copied. Pass --org ${slug} to use it.`,
      ...fixLive,
    });
  }
  progress?.stop(true, `Copied ${style.bold(clean(liveSession.orgName))} into a sandbox organization`);

  const rows: Array<readonly [string, string]> = [
    ['Sandbox', `${slug} on ${hostOf(copy.baseUrl)}`],
    ['From', `${clean(copy.from.orgSlug)} on ${hostOf(copy.from.baseUrl)}`],
  ];
  // A copied app has no address, so its asks wait for siren listen or a url the person sets.
  if (apps.length === 0) rows.push(['Apps', `none on ${clean(copy.from.orgSlug)}`]);
  copiedApps.forEach((app, index) => rows.push([index === 0 ? 'Apps' : '', style.fit(`${clean(app.key)} (no address, run siren listen or set one)`, 62)]));
  const groups: string[] = [];
  for (const [stanza, label, one, many] of RECORD_STANZAS) {
    const count = stanzas[stanza];
    if (count === undefined || count === 0) continue;
    if (label === 'Groups') groups.push(counted(count, one, many));
    else rows.push([label, `${count} copied`]);
  }
  if (groups.length > 0) rows.push(['Groups', groups.join(', ')]);
  if (settings.length > 0) rows.push(['Settings', settings.join(', ')]);
  // The two that always stay behind share a line. Their reasons are the tips.
  rows.push(['Not copied', 'collaborators, API keys, signing secrets']);
  for (const item of notCopied.slice(2)) rows.push(['', style.fit(clean(`${item.what}, ${item.why}`), 62)]);

  const report: Report = {
    headline: '',
    rows,
    next: [
      { text: style.command(input.command(`seed --org ${slug} --sales 50`)), aside: 'sample sales' },
      ...(copiedApps.length === 0
        ? []
        : [{ text: style.command(input.command(`listen --org ${slug}${copiedApps.length === 1 ? ` --app ${clean(copiedApps[0]!.key)}` : ''}`)), aside: 'asks, here' }]),
      { text: style.command(input.command(`sandbox inbox --org ${slug}`)) },
    ],
    tips: [
      'Collaborators stay live. siren seed makes sample ones.',
      'The sandbox made its own keys and secrets. None left the live Siren.',
      `Set SIREN_ORG=${slug} to leave out --org.`,
    ],
  };
  // The spinner printed the headline, so the report starts at its block.
  const body = style.report(report).split('\n').slice(json || progress === null ? 0 : 1).join('\n');
  input.io.stdout(body);
  return 0;
}

/** `siren sandbox list`: the person's organizations on the sandbox, and where each copy came from. */
export async function list(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const json = input.values.json === true;
  await onSandbox(run, 'sandbox list');
  const memberships = await run.withAccessToken((token) => run.auth.memberships(token));
  const copies = await new SandboxRecords(input.io.configDir).all();
  const fromOf = (orgId: number) => copies.find((copy) => copy.baseUrl === run.target.baseUrl && copy.orgId === orgId)?.from ?? null;
  if (json) {
    printJson(input, {
      baseUrl: run.target.baseUrl,
      orgs: memberships.map((org) => ({ orgId: org.orgId, orgSlug: org.orgSlug, orgName: org.orgName, role: org.role, copiedFrom: fromOf(org.orgId) })),
    });
    return 0;
  }
  const style = styleFor(input.io, 'stdout', {});
  const lines = style.table(
    ['ORG', 'NAME', 'COPIED FROM'],
    memberships.map((org) => {
      const source = fromOf(org.orgId);
      return [org.orgSlug, org.orgName, source === null ? '' : `${source.orgSlug} on ${hostOf(source.baseUrl)}`];
    }),
    76,
  );
  const headline = style.success(`${counted(memberships.length, 'sandbox organization', 'sandbox organizations')} on ${hostOf(run.target.baseUrl)}`);
  // Through a pipe, standard output holds the table alone, and the headline and tip go to standard error (review of PR 94).
  if (!style.rich) {
    if (lines.length > 0) input.io.stdout(`${lines.join('\n')}\n`);
    input.io.stderr(`${headline}\n${LIST_TIP}\n`);
    return 0;
  }
  input.io.stdout([headline, '', ...lines.map((line) => `  ${line}`), '', style.next(style.dim(LIST_TIP)), ''].join('\n'));
  return 0;
}

/** The tip under `sandbox list`. */
const LIST_TIP = 'Pass --org <slug>, or set SIREN_ORG, to pick one.';

/** What `POST /sandbox/reset` answers. */
interface ResetAnswer {
  org: { orgId: number; orgSlug: string };
  cleared: Record<string, number>;
  total: number;
}

/** The cleared tables `reset` shows, by the names the person knows, in order. */
const CLEARED_ROWS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Conversions', ['conversions']],
  ['Obligations', ['obligations']],
  ['Transactions', ['transactions']],
  ['Payouts', ['payouts']],
  ['Requests', ['app_requests']],
  ['Deliveries', ['webhook_deliveries', 'custom_event_sends']],
];

/**
 * `siren sandbox reset`: clears the organization's activity and keeps its
 * setup. The person types the slug, or passes it with `--confirm`.
 */
export async function reset(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const json = input.values.json === true;
  const org = await orgScope(run, input, await onSandbox(run, 'sandbox reset'), 'sandbox reset');
  const slug = org.orgSlug;
  let typed = text(input.values.confirm);
  if (typed === undefined) {
    if (!input.io.interactive) {
      throw new CliRefusal(`siren sandbox reset needs the organization's slug typed to confirm.`, {
        why: 'With no terminal, nothing can ask. Nothing was cleared.',
        fix: input.command(`sandbox reset${org.flag} --confirm ${slug}`),
      });
    }
    input.io.stderr(`This clears every conversion, obligation, transaction, payout, request and delivery in ${clean(org.orgName)} (${clean(slug)}). Its setup stays.\n`);
    typed = (await input.io.prompt(`Type ${slug} to confirm: `)).trim();
  }
  if (typed !== slug) {
    throw new CliRefusal(`${typed === '' ? 'Nothing' : typed} is not ${slug}, so nothing was cleared.`, { why: 'A reset needs the organization typed, so a slip clears nothing.', fix: input.command(`sandbox reset${org.flag} --confirm ${slug}`) });
  }

  const answer = await writeRecord<ResetAnswer>(org.http, 'POST', '/sandbox/reset', { confirm: typed });
  if (json) {
    printJson(input, answer);
    return 0;
  }
  const cleared = isJsonObject(answer.cleared) ? answer.cleared : {};
  const style = styleFor(input.io, 'stdout', {});
  const shown = CLEARED_ROWS.map(([label, tables]) => [label, tables.reduce((sum, table) => sum + (cleared[table] ?? 0), 0)] as const);
  // The total also counts what hangs off these rows, such as balances, opportunities, holds and mappings.
  const rest = (typeof answer.total === 'number' ? answer.total : 0) - shown.reduce((sum, [, count]) => sum + count, 0);
  input.io.stdout(
    style.report({
      headline: `Cleared ${style.bold(slug)}'s activity`,
      rows: [
        ...shown.map(([label, count]) => [label, String(count)] as const),
        ...(rest > 0 ? [['Also', `${counted(rest, 'row', 'rows')} ${style.dim('of balances, opportunities, holds, mappings')}`] as const] : []),
        ['Kept', 'programs, apps, collaborators, groups, settings'],
      ],
      next: [{ text: style.command(input.command(`seed${org.flag} --sales 50`)), aside: 'sample sales' }],
    }),
  );
  return 0;
}

/** One captured email in the inbox list. */
interface InboxEmail {
  id: number;
  recipients: unknown;
  subject: string;
  fromName?: string | null;
  template?: string | null;
  createdAt: string;
  replyTo?: string | null;
  text?: string | null;
}

/** The recipients as one short line. */
function recipientsOf(value: unknown): string {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((one) => clean(typeof one === 'string' ? one : isJsonObject(one) && typeof one.email === 'string' ? one.email : ''))
    .filter((one) => one !== '')
    .join(', ');
}

/** `2026-11-24 17:40` from an ISO time, as Siren wrote it. */
function shortTime(iso: string): string {
  return clean(iso).replace('T', ' ').slice(0, 16);
}

/** An email's text part with each line cleaned, so its line breaks stay and nothing else reaches the terminal. */
function bodyText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => clean(line.replace(/\t/g, '  ')))
    .join('\n')
    .trim();
}

/** `siren sandbox inbox [<id>]`: the emails the sandbox caught for the organization, or one of them. */
export async function inbox(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const json = input.values.json === true;
  const id = input.args[0];
  if (id !== undefined && !/^\d+$/.test(id)) throw new CliUsageError(`siren sandbox inbox takes an email's number, such as 31, and got ${id}.`);
  const raw = text(input.values.limit);
  const limit = raw === undefined ? INBOX_DEFAULT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > INBOX_MAX) throw new CliUsageError(`--limit takes a whole number from 1 to ${INBOX_MAX}.`);

  const org = await orgScope(run, input, await onSandbox(run, 'sandbox inbox'), 'sandbox inbox');
  const http = org.http;
  const style = styleFor(input.io, 'stdout', { json });
  const slug = org.orgSlug;

  if (id !== undefined) {
    const email = await readObject<InboxEmail>(http, `/sandbox/inbox/${id}`);
    if (json) {
      printJson(input, email);
      return 0;
    }
    input.io.stdout(
      style.report({
        headline: style.bold(clean(email.subject)),
        rows: [
          ['To', recipientsOf(email.recipients)],
          ['From', clean(email.fromName ?? '')],
          ['Sent', shortTime(email.createdAt)],
          ...(email.template ? [['Template', clean(email.template)] as const] : []),
        ],
      }) + `\n${bodyText(email.text ?? '') || style.dim('(no text part)')}\n`,
    );
    return 0;
  }

  const page = await readObject<{ emails?: InboxEmail[]; total?: number }>(http, '/sandbox/inbox', { number: limit, offset: 0 });
  const emails = Array.isArray(page.emails) ? page.emails : [];
  if (json) {
    printJson(input, { emails, total: page.total ?? emails.length });
    return 0;
  }
  const lines = style.table(
    ['#', 'SENT', 'TO', 'SUBJECT'],
    emails.map((email) => [`#${clean(String(email.id))}`, shortTime(email.createdAt), recipientsOf(email.recipients), clean(email.subject)]),
    76,
  );
  const tip = emails.length === 0 ? 'The sandbox keeps each email it sends here. Seeded test sales send none.' : `${input.command(`sandbox inbox${org.flag} ${clean(String(emails[0]!.id))}`)} shows one.`;
  const headline = style.success(`${counted(page.total ?? emails.length, 'email', 'emails')} in ${style.bold(clean(slug))}'s sandbox inbox`);
  if (!style.rich) {
    if (emails.length > 0) input.io.stdout(`${lines.join('\n')}\n`);
    input.io.stderr(`${headline}\n${tip}\n`);
    return 0;
  }
  input.io.stdout([headline, ...(emails.length === 0 ? [] : ['', ...lines.map((line) => `  ${line}`)]), '', style.next(style.dim(tip)), ''].join('\n'));
  return 0;
}
