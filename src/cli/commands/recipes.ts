import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ConflictError, SirenError } from '../../errors';
import { RecipesResource, recipeProblems } from '../../resources/recipes';
import type { Recipe, RecipeCatalogFilters, RecipeImport, RecipePreview, RecipeProblem } from '../../resources/recipes';
import { contextOf } from '../context';
import type { CommandContext, CommandInput } from '../context';
import { REPORT_WIDTH, clean, styleFor } from '../style';
import { CliRefusal, CliUsageError } from '../targets';
import { orgNamed } from './apply';

/*
 * `siren recipes`: preview and apply a recipe, follow its import, export
 * the organization's setup as one, and read Beacon's ready-made recipes.
 * The design is review/cli-dx/lean-output.md in the run folder, "siren
 * recipes". Siren serves these routes to a signed-in session only.
 */

/** How often apply asks after its import, in milliseconds. */
export const IMPORT_POLL_MS = 2000;

/** The sections of a recipe in the order Siren applies them, with the word a progress line uses. */
const SECTION_WORDS: Readonly<Record<string, string>> = {
  currencies: 'Currencies',
  programs: 'Programs',
  programGroups: 'Program groups',
  distributors: 'Distributors',
  collaborators: 'People',
  collaboratorGroups: 'Groups',
  products: 'Products',
  mappings: 'Mappings',
  autofulfillers: 'Autofulfillers',
  notifications: 'Notifications',
  customEvents: 'Custom events',
};

/** A recipe read from a file or standard input, with the name a message calls it. */
interface ReadRecipe {
  recipe: Recipe;
  /** The file's name, or "The recipe" when it came on standard input. */
  shown: string;
  /** The file's name for Siren's imports list, or undefined for standard input. */
  fileName?: string;
}

/**
 * The recipe in `given`, a file, or standard input when it is `-`. Its
 * `$schema`, which an editor uses, is taken out, since Siren takes no other
 * key at a recipe's top.
 */
async function readRecipe(input: CommandInput, given: string): Promise<ReadRecipe> {
  const fromStdin = given === '-';
  const shown = fromStdin ? 'The recipe' : basename(given);
  let text: string;
  try {
    text = fromStdin ? await input.io.readStdin() : await readFile(resolve(input.io.cwd, given), 'utf8');
  } catch {
    throw new CliRefusal(`There is no file ${given}.`, { why: 'The tool reads the recipe from the file named, or from standard input with -.', fixText: 'Name a recipe file, or pipe one in with -.' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliRefusal(`${shown} isn't JSON.`, {
      why: `${error instanceof Error ? error.message : 'It does not parse'}. A recipe is one JSON object.`,
      fixText: fromStdin ? 'Pipe in a recipe as JSON.' : `Fix ${shown}, then run the command again.`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliRefusal(`${shown} isn't a recipe.`, { why: 'A recipe is one JSON object, with sections such as programs and collaborators.', fix: input.command('recipes export'), fixWords: "prints this organization's setup as one" });
  }
  const { $schema: _schema, ...recipe } = parsed as Record<string, unknown>;
  return { recipe, shown, ...(fromStdin ? {} : { fileName: basename(given) }) };
}

/** The key that names this recipe's import: the SHA-256 of its JSON with every object's keys in order. */
export function importKeyOf(recipe: Recipe): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
        : value;
  return `cli-${createHash('sha256').update(JSON.stringify(canonical(recipe))).digest('hex')}`;
}

/** Siren's refusal of a recipe as three parts, each problem at its path, or the error as it came when it is another. */
function refusalOf(error: unknown, read: ReadRecipe, again: string): unknown {
  const problems = recipeProblems(error);
  if (problems.length === 0) return error;
  return new CliRefusal(`${read.shown} has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}.`, {
    why: 'Siren checks a recipe before it makes anything, so nothing was made.',
    problems: problems.map((problem) => ({ at: clean(problem.path ?? 'recipe'), message: problemMessage(problem) })),
    fixLead: read.fileName === undefined ? 'Fix the recipe, then run' : `Fix ${problems.length === 1 ? 'it' : 'them'} in ${read.shown}, then run`,
    fix: again,
    fixWords: 'again',
  });
}

/** A problem's words: Siren's plain message for a missing integration or plan, else its message. */
function problemMessage(problem: RecipeProblem): string {
  const words = typeof problem.humanMessage === 'string' && problem.humanMessage !== '' ? problem.humanMessage : (problem.message ?? 'Siren refused it.');
  return clean(words);
}

/** The preview flags Siren reads as import options. */
function optionsOf(values: CommandInput['values']): { configurationOnly?: boolean; paused?: boolean } {
  return { ...(values['configuration-only'] === true ? { configurationOnly: true } : {}), ...(values.paused === true ? { paused: true } : {}) };
}

/** The preview's sections as report rows, such as ["Programs", "3: Gold, Silver, Bronze"]. */
function sectionRows(preview: RecipePreview): Array<[string, string]> {
  return preview.sections
    .filter((section) => section.count > 0)
    .map((section) => {
      const samples = section.samples.slice(0, 3).map(clean);
      const more = section.count > samples.length ? ', …' : '';
      return [clean(section.label), `${section.count}${samples.length > 0 ? `: ${samples.join(', ')}${more}` : ''}`];
    });
}

/** `siren recipes preview <file|->`: what applying it would make. Writes nothing. */
export async function recipesPreview(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const given = input.args[0]!;
  const read = await readRecipe(input, given);
  await run.signedIn();
  let preview: RecipePreview;
  try {
    preview = await run.siren().recipes.preview(read.recipe, optionsOf(input.values));
  } catch (error) {
    throw refusalOf(error, read, run.command(`recipes preview ${given}`));
  }
  if (input.values.json === true) {
    run.print(JSON.stringify(preview, null, 2));
    return 0;
  }
  if (input.values.quiet === true) return 0;
  const out = styleFor(input.io, 'stdout', input.values);
  run.print(
    out
      .report({
        headline: `${out.bold(read.shown)} would make ${preview.sections.some((section) => section.count > 0) ? 'these' : 'nothing'} in ${orgNamed(run.current())}.`,
        mark: false,
        rows: [...sectionRows(preview), ...preview.variables.map((variable) => [`Needs`, `${clean(variable.name)} (a ${clean(variable.type)}, --var ${clean(variable.key)}=<id>)`] as [string, string])],
        next: [{ text: out.command(run.command(`recipes apply ${given}`)), aside: 'apply it, after asking' }],
      })
      .replace(/\n$/, ''),
  );
  return 0;
}

/** `--var key=id,key=id` as Siren's variableAnswers. */
function variableAnswersOf(value: string | boolean | undefined): Record<string, number> {
  if (typeof value !== 'string' || value === '') return {};
  const answers: Record<string, number> = {};
  for (const pair of value.split(',')) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]{0,63})=(\d+)\s*$/.exec(pair);
    if (match === null || Number(match[2]) < 1) throw new CliUsageError(`--var takes key=<id> pairs joined by commas, such as --var partnerProgram=4, and got ${JSON.stringify(pair.trim())}.`);
    answers[match[1]!] = Number(match[2]);
  }
  return answers;
}

/**
 * `siren recipes apply <file|->`: previews the recipe, asks for each record
 * it uses that --var did not name, asks before applying, applies it under an
 * import key made from its content, and follows the import to its end.
 */
export async function recipesApply(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const given = input.args[0]!;
  const json = values.json === true;
  const read = await readRecipe(input, given);
  const session = await run.signedIn();
  const recipes = run.siren().recipes;
  const options = optionsOf(values);
  const again = run.command(`recipes apply ${given}`);
  let preview: RecipePreview;
  try {
    preview = await recipes.preview(read.recipe, options);
  } catch (error) {
    throw refusalOf(error, read, again);
  }

  // The records the recipe uses but does not make: --var names them, or a terminal asks.
  const answers = variableAnswersOf(values.var);
  const unanswered = preview.variables.filter((variable) => answers[variable.key] === undefined);
  if (unanswered.length > 0 && !io.interactive) {
    throw new CliRefusal(`${read.shown} uses ${unanswered.length === 1 ? 'a record' : `${unanswered.length} records`} it doesn't make.`, {
      why: `Name ${unanswered.length === 1 ? 'it' : 'each'} by id: ${unanswered.map((variable) => `${clean(variable.key)} (a ${clean(variable.type)})`).join(', ')}.`,
      fix: run.command(`recipes apply ${given} --var ${unanswered.map((variable) => `${clean(variable.key)}=<id>`).join(',')}`),
    });
  }
  for (const variable of unanswered) {
    const typed = (await io.prompt(`${clean(variable.name)}, the id of a ${clean(variable.type)}: `)).trim();
    if (!/^\d+$/.test(typed) || Number(typed) < 1) {
      throw new CliRefusal('Nothing applied.', { why: `${clean(variable.name)} needs the id of a ${clean(variable.type)}, a whole number.`, fix: again, fixWords: 'to be asked again' });
    }
    answers[variable.key] = Number(typed);
  }

  const out = styleFor(io, 'stdout', values);
  const err = styleFor(io, 'stderr', values);
  const org = orgNamed(session);
  if (json && values.yes !== true) {
    // A script gets the preview, and nothing is sent without --yes, as with no terminal.
    run.print(JSON.stringify({ preview, applied: false }, null, 2));
    return 1;
  }
  if (!json) {
    run.print(out.report({ headline: `${out.bold(read.shown)} would make ${preview.sections.some((section) => section.count > 0) ? 'these' : 'nothing'}.`, mark: false, rows: sectionRows(preview) }).replace(/\n$/, ''));
  }
  if (values.yes !== true) {
    if (!io.interactive) {
      const yes = run.command(`recipes apply ${given} --yes`);
      io.stderr(
        err.rich
          ? `${err.warning("Nothing sent: there's no terminal to ask in.")}\n${err.next(`${err.command(yes)} applies it without asking.`)}\n`
          : `siren: Nothing was sent. Run ${yes} to apply it without asking.\n`,
      );
      return 1;
    }
    const typed = (await io.prompt(`Apply it to ${org}? [y/N] `)).trim().toLowerCase();
    if (typed !== 'y' && typed !== 'yes') {
      io.stderr(err.rich ? `${err.dim('Nothing sent.')}\n` : 'siren: Nothing was sent.\n');
      return 1;
    }
  }

  let job: RecipeImport;
  try {
    job = await recipes.apply(read.recipe, {
      ...options,
      ...(values.again === true ? {} : { importKey: importKeyOf(read.recipe) }),
      source: { kind: 'cli', ...(read.fileName === undefined ? {} : { fileName: read.fileName }) },
      ...(Object.keys(answers).length > 0 ? { variableAnswers: answers } : {}),
    });
  } catch (error) {
    const earlier = RecipesResource.earlierImport(error);
    if (error instanceof ConflictError && earlier !== undefined) {
      throw new CliRefusal(`${read.shown} is applied in ${org} already.`, {
        why: 'Siren applies the same recipe once under its import key, so it made nothing new.',
        fix: run.command(`recipes status ${earlier.jobId}`),
        fixWords: `to see it, or add --again to apply it again as an update`,
      });
    }
    throw refusalOf(error, read, again);
  }

  if (values.wait === false || values['no-wait'] === true) {
    if (json) run.print(JSON.stringify(job, null, 2));
    else {
      run.print(out.success(`Started importing ${out.bold(read.shown)} as ${job.jobId}.`));
      run.print(out.next(`${out.command(run.command(`recipes status ${job.jobId}`))} shows how far it got.`));
    }
    return 0;
  }
  return follow(run, input, job, read.shown);
}

/** The progress line, such as "Programs 3/3 · Groups 2/2 · People 18/40". */
export function progressLine(job: Pick<RecipeImport, 'perStanzaTotals' | 'perStanzaProcessed' | 'processedItems' | 'totalItems'>): string {
  const sections = Object.entries(job.perStanzaTotals).filter(([, total]) => total > 0);
  if (sections.length === 0) return `${job.processedItems}/${job.totalItems}`;
  return sections.map(([section, total]) => `${SECTION_WORDS[section] ?? clean(section)} ${job.perStanzaProcessed[section] ?? 0}/${total}`).join(' · ');
}

/** Asks after the import every {@link IMPORT_POLL_MS} until it ends, with a progress line, then prints its report. Ctrl-C stops the watching, not the import. */
async function follow(run: CommandContext, input: CommandInput, started: RecipeImport, shown: string): Promise<number> {
  const { io, values } = input;
  const err = styleFor(io, 'stderr', values);
  const json = values.json === true;
  const spinner = json ? undefined : err.spinner(`Importing ${shown}: ${progressLine(started)}`, (text) => io.stderr(text));
  const watching = () => undefined;
  io.signal?.addEventListener('abort', watching);
  let job = started;
  try {
    while (job.status !== 'complete' && job.status !== 'failed') {
      await io.sleep(IMPORT_POLL_MS);
      if (io.signal?.aborted) {
        spinner?.cancel();
        io.stderr(`${err.rich ? err.next(`${err.command(run.command(`recipes status ${job.jobId}`))} shows how far it got. The import goes on.`) : `siren: Stopped watching. The import goes on. Run ${run.command(`recipes status ${job.jobId}`)} to see how far it got.`}\n`);
        return 130;
      }
      job = await run.siren().recipes.import(job.jobId);
      spinner?.update(`Importing ${shown}: ${progressLine(job)}`);
    }
  } finally {
    io.signal?.removeEventListener('abort', watching);
  }
  if (json) {
    run.print(JSON.stringify(job, null, 2));
    return job.status === 'complete' ? 0 : 1;
  }
  spinner?.cancel();
  printImport(run, input, job, shown);
  return job.status === 'complete' && job.failedItems === 0 ? 0 : 1;
}

/** An import as a report: what it made, the people, and each failure. */
function printImport(run: CommandContext, input: CommandInput, job: RecipeImport, shown: string): void {
  const out = styleFor(input.io, 'stdout', input.values);
  const people = job.collaboratorSummary;
  const rows: Array<[string, string]> = [['Import', job.jobId], ['Progress', progressLine(job)]];
  if (people.added + people.updated + people.skipped + people.failed > 0) {
    rows.push(['People', `${people.added} added, ${people.updated} updated, ${people.skipped} skipped, ${people.failed} failed${people.emailed > 0 ? `, ${people.emailed} emailed` : ''}`]);
  }
  const failures = [
    ...job.collaboratorResults.filter((row) => row.outcome === 'failed').map((row) => `${clean(String(row.email ?? row.key ?? 'someone'))}: ${clean(String(row.reason ?? row.message ?? 'failed'))}`),
    ...job.programResults.filter((row) => row.outcome === 'failed' || row.outcome === 'drafted').map((row) => `${clean(String(row.key ?? 'a program'))}: ${clean(String(row.reason ?? row.message ?? row.outcome))}`),
  ];
  const ended = job.status === 'complete';
  const headline = ended ? (job.failedItems === 0 ? `Applied ${out.bold(shown)}.` : `Applied ${out.bold(shown)}, with ${job.failedItems} failed.`) : `Importing ${out.bold(shown)} failed.`;
  const text = out.report({ headline, mark: ended && job.failedItems === 0, rows, tips: failures.length > 0 ? failures.slice(0, 10) : undefined }).replace(/\n$/, '');
  run.print(text);
  if (job.errorMessage) run.print(out.warning(clean(job.errorMessage)));
  if (failures.length > 10) run.print(out.dim(`${failures.length - 10} more failed. ${run.command(`recipes status ${job.jobId} --json`)} lists them all.`));
}

/** `siren recipes status <jobId>`: one import, its progress per section and how the people went. */
export async function recipesStatus(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const jobId = input.args[0]!;
  if (!/^[a-zA-Z0-9]+$/.test(jobId)) throw new CliUsageError(`${JSON.stringify(jobId)} isn't an import id. Import ids are letters and digits, as siren recipes imports lists them.`);
  const job = await run.siren().recipes.import(jobId);
  if (input.values.json === true) {
    run.print(JSON.stringify(job, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  if (job.status !== 'complete' && job.status !== 'failed') {
    run.print(out.report({ headline: `Import ${job.jobId} is ${clean(job.status)}.`, mark: false, rows: [['Progress', progressLine(job)]] }).replace(/\n$/, ''));
    return 0;
  }
  printImport(run, input, job, job.source?.fileName ? clean(job.source.fileName) : `import ${job.jobId}`);
  return 0;
}

/** A whole number from 1 to `most` from a flag, or undefined when the flag is not given. */
function countOf(flag: string, value: string | boolean | undefined, most: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > most) throw new CliUsageError(`${flag} takes a whole number from 1 to ${most}, and got ${JSON.stringify(value)}.`);
  return Number(value);
}

/** `siren recipes imports`: the organization's recent imports, newest first. */
export async function recipesImports(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const limit = countOf('--limit', input.values.limit, 100);
  await run.signedIn();
  const items = await run.siren().recipes.imports(limit === undefined ? {} : { limit });
  if (input.values.json === true) {
    run.print(JSON.stringify(items, null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  if (items.length === 0) {
    run.print(`No recipe imports in ${orgNamed(run.current())} yet.`);
    run.print(out.next(`${out.command(run.command('recipes apply <file>'))} applies one.`));
    return 0;
  }
  const width = out.rich ? Math.min(input.io.screen?.size?.columns ?? REPORT_WIDTH, REPORT_WIDTH) : Number.POSITIVE_INFINITY;
  const rows = items.map((item) => [item.jobId, item.dateCreated.slice(0, 16).replace('T', ' '), clean(item.status), `${item.processedItems}/${item.totalItems}`, clean(item.source?.fileName ?? item.source?.kind ?? '')]);
  for (const line of out.table(['ID', 'STARTED', 'STATUS', 'DONE', 'FROM'], rows, width)) run.print(line);
  run.print(out.next(`${out.command(run.command(`recipes status ${items[0]!.jobId}`))} shows one.`));
  return 0;
}

/** `siren recipes export [--include a,b]`: the organization's setup as a recipe, on standard output. */
export async function recipesExport(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn();
  const recipes = run.siren().recipes;
  if (input.values.sizes === true) {
    const sizes = await recipes.exportSizes();
    if (input.values.json === true) run.print(JSON.stringify(sizes, null, 2));
    else for (const [section, count] of Object.entries(sizes)) run.print(`${clean(section)}  ${count}`);
    return 0;
  }
  const include = typeof input.values.include === 'string' ? input.values.include.split(',').map((part) => part.trim()).filter((part) => part !== '') : [];
  const exported = await recipes.export({ include });
  run.print(JSON.stringify(exported.recipe, null, 2));
  // What the export left out goes to standard error, so the recipe on standard output stays whole.
  const left = Object.entries(exported.skipped).filter(([, rows]) => Array.isArray(rows) && rows.length > 0);
  if (left.length > 0) {
    const err = styleFor(input.io, 'stderr', input.values);
    const line = `Left out: ${left.map(([section, rows]) => `${(rows as unknown[]).length} ${clean(section)}`).join(', ')}, such as drafts.`;
    input.io.stderr(`${err.rich ? err.dim(line) : `siren: ${line}`}\n`);
  }
  return 0;
}

/** The catalog filters from their flags: --type, --goal, --tier, --integrations, --features, --search and --limit. */
function catalogFilters(values: CommandInput['values']): RecipeCatalogFilters {
  const text = (name: string) => (typeof values[name] === 'string' && values[name] !== '' ? (values[name] as string) : undefined);
  const filters: RecipeCatalogFilters = {};
  if (text('type')) filters.type = text('type');
  if (text('goal')) filters.goal = text('goal');
  if (text('tier')) filters.tier = text('tier');
  if (text('integrations')) filters.integrations = text('integrations');
  if (text('features')) filters.requiredFeatures = text('features');
  if (text('search')) filters.q = text('search');
  const limit = countOf('--limit', values.limit, 100);
  if (limit !== undefined) filters.limit = limit;
  return filters;
}

/** `siren recipes catalog`: Beacon's ready-made recipes, with whether each fits this organization. */
export async function recipesCatalog(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const filters = catalogFilters(input.values);
  await run.signedIn();
  const catalog = await run.siren().recipes.catalog(filters);
  if (input.values.json === true) {
    run.print(JSON.stringify(catalog.recipes.map(({ recipe: _recipe, ...entry }) => entry), null, 2));
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  if (catalog.recipes.length === 0) {
    run.print('No ready-made recipes match.');
    return 0;
  }
  const rows = catalog.recipes.map((entry) => [clean(String(entry.id ?? '')), clean(String(entry.name ?? '')), entry.fits ? 'yes' : entry.requiredPlan ? `needs ${clean(entry.requiredPlan)}` : 'no']);
  const width = out.rich ? Math.min(input.io.screen?.size?.columns ?? REPORT_WIDTH, REPORT_WIDTH) : Number.POSITIVE_INFINITY;
  for (const line of out.table(['ID', 'NAME', 'FITS'], rows, width)) run.print(line);
  const first = catalog.recipes.find((entry) => typeof entry.id === 'string');
  if (first !== undefined) run.print(out.next(`${out.command(run.command(`recipes show ${clean(String(first.id))} > recipe.json`))} saves one to edit and apply.`));
  return 0;
}

/** `siren recipes show <catalogId>`: one ready-made recipe, on standard output. */
export async function recipesShow(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const id = input.args[0]!;
  await run.signedIn();
  const catalog = await run.siren().recipes.catalog();
  const entry = catalog.recipes.find((candidate) => candidate.id === id);
  if (entry === undefined || entry.recipe === undefined) {
    throw new CliRefusal(`The catalog has no recipe ${clean(id)}.`, { why: "Beacon's catalog, as Siren serves it, names no recipe with that id.", fix: run.command('recipes catalog'), fixWords: 'to list them' });
  }
  run.print(JSON.stringify(entry.recipe, null, 2));
  return 0;
}

/** The token in a Beacon handoff: the token itself, or the `token` in a link, else the link's last part. */
export function handoffToken(given: string): string {
  if (!/^https?:\/\//.test(given)) return given.trim();
  const url = new URL(given);
  return url.searchParams.get('token') ?? url.pathname.split('/').filter((part) => part !== '').at(-1) ?? '';
}

/** `siren recipes fetch <token|link>`: the recipe a Beacon handoff carries, on standard output. */
export async function recipesFetch(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const token = handoffToken(input.args[0]!);
  if (token === '') throw new CliUsageError('siren recipes fetch takes a Beacon handoff token, or the link Beacon gave.');
  await run.signedIn();
  try {
    run.print(JSON.stringify(await run.siren().recipes.fetch(token), null, 2));
  } catch (error) {
    if (error instanceof SirenError && error.statusCode === 422) {
      throw new CliRefusal("Siren couldn't read that handoff.", { why: `${clean(error.message.replace(/^Siren: /, ''))}`, fixText: 'Ask Beacon for a new handoff link, since each one expires.' });
    }
    throw error;
  }
  return 0;
}
