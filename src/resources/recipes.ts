import { ConflictError, SirenError, UnexpectedResponseError } from '../errors';
import type { HttpTransport } from '../http';
import { isJsonObject, readObject, writeRecord, writeRecordResent } from './record-requests';

/** A recipe: a JSON object with Siren's recipe sections, as recipe.schema.json describes. */
export type Recipe = Record<string, unknown>;

/** One section of a recipe preview: how many records of one kind it makes, with a few names. */
export interface RecipePreviewSection {
  type: string;
  label: string;
  count: number;
  samples: string[];
  category: string;
}

/** One record a recipe uses but does not make. The importer names it in `variableAnswers`. */
export interface RecipeVariable {
  key: string;
  type: string;
  name: string;
  help: string | null;
}

/** What `POST /recipes/preview` answers: what an apply would make, with nothing written. */
export interface RecipePreview {
  name: string;
  description: string | null;
  version: string;
  sections: RecipePreviewSection[];
  variables: RecipeVariable[];
}

/** Where an import came from, shown in the imports list. */
export interface RecipeSource {
  kind: string;
  fileName?: string | null;
  mapping?: Record<string, string>;
}

/** The options `preview` and `apply` take beside the recipe (RecipeImportOptions). */
export interface RecipePreviewOptions {
  /** Leave out the collaborators, mappings and group members, keeping the setup. */
  configurationOnly?: boolean;
  /** Make every program and distributor inactive. */
  paused?: boolean;
}

export interface RecipeApplyOptions extends RecipePreviewOptions {
  /**
   * Names the import, so Siren runs it once in an org. A second apply under
   * the same key throws `ConflictError` naming the earlier job, and a lost
   * connection can send it again safely. With no key, Siren applies every
   * time, which is how a merchant updates a setup. At most 191 characters.
   */
  importKey?: string;
  source?: RecipeSource;
  /** The record id for each variable the preview names. */
  variableAnswers?: Record<string, number>;
}

/** How many entries of one kind were added, updated, skipped and failed. */
export interface RecipeOutcomes {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** One row of `GET /recipes/imports`. */
export interface RecipeImportSummary {
  jobId: string;
  /** pending, processing, complete or failed. */
  status: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  perStanzaTotals: Record<string, number>;
  perStanzaProcessed: Record<string, number>;
  dateCreated: string;
  completedDate?: string | null;
  errorMessage: string | null;
  source: RecipeSource | null;
}

/** One import in full, from `POST /recipes/apply` or `GET /recipes/imports/{jobId}`. */
export interface RecipeImport extends RecipeImportSummary {
  created: Record<string, unknown>;
  collaboratorResults: Array<Record<string, unknown>>;
  collaboratorSummary: RecipeOutcomes & { emailed: number };
  productResults: Array<Record<string, unknown>>;
  productSummary: RecipeOutcomes;
  programResults: Array<Record<string, unknown>>;
  linkedRecords: Array<{ key: string; name: string; type: string; id: number; recordName: string }>;
  failureKind: string | null;
}

/** What `GET /recipes/export` answers: the org's setup as a recipe, and what it left out. */
export interface RecipeExport {
  recipe: Recipe;
  skipped: Record<string, unknown>;
}

/** The filters `GET /recipes/catalog` passes to Beacon (ListRecipeCatalog::FILTER_KEYS). */
export interface RecipeCatalogFilters {
  type?: string;
  goal?: string;
  requiredFeatures?: string;
  integrations?: string;
  tier?: string;
  q?: string;
  limit?: number;
}

/** One ready-made recipe, with whether it fits this org and the recipe itself. */
export interface RecipeCatalogEntry {
  id?: string;
  name?: string;
  description?: string;
  fits: boolean;
  unmetRequirements?: string[];
  requiredPlan?: string;
  /** The recipe, parsed from the catalog's `payload` text. Undefined when the entry carries none. */
  recipe?: Recipe;
  [key: string]: unknown;
}

export interface RecipeCatalog {
  recipes: RecipeCatalogEntry[];
  store: { integrations: unknown[]; capabilities: unknown[] };
}

/** One problem in a recipe Siren refused: the field's path, what is wrong, and a code. */
export interface RecipeProblem {
  path?: string;
  message?: string;
  code?: string;
  humanMessage?: string;
  plan?: string;
  [key: string]: unknown;
}

/** The names Siren reads as options, so a recipe may not hold them as sections (RecipeImportOptions::PARAMS). */
const OPTION_NAMES = ['configurationOnly', 'paused', 'importKey', 'source', 'variableAnswers'] as const;

/** RecipeImportOptions::MAX_IMPORT_KEY_LENGTH. */
const MAX_IMPORT_KEY = 191;

/** ListRecipeImports::MAX_LIMIT. */
const MAX_IMPORTS = 100;

const CATALOG_FILTERS = ['type', 'goal', 'requiredFeatures', 'integrations', 'tier', 'q', 'limit'] as const;

/**
 * The problems of a recipe Siren refused with 422 `RECIPE_VALIDATION_FAILED`,
 * from `preview` or `apply`, in Siren's order. Empty for any other error.
 */
export function recipeProblems(error: unknown): RecipeProblem[] {
  if (!(error instanceof SirenError) || error.statusCode !== 422 || !isJsonObject(error.data)) return [];
  return Array.isArray(error.data.errors) ? (error.data.errors as unknown[]).filter(isJsonObject) : [];
}

/**
 * Recipes (`/recipes`): preview and apply a recipe, follow its import,
 * export the org's setup as one, and read Beacon's ready-made recipes.
 *
 * Siren serves these routes to a signed-in member's session only. An API
 * key cannot call them yet. `preview` and `apply` run Siren's own recipe
 * validation, which also checks the store's integrations and the org's plan,
 * and throw `ValidationError` on 422. {@link recipeProblems} reads its
 * problems. Reads retry on a network error, 429 or 5xx. `apply` is sent
 * once, unless it names an `importKey`, which Siren runs once in an org.
 */
export class RecipesResource {
  constructor(private readonly http: HttpTransport) {}

  /** The earlier import a `ConflictError` from {@link apply} names, or undefined for any other error. */
  static earlierImport(error: unknown): { jobId: string; status: string | null } | undefined {
    if (!(error instanceof ConflictError) || !isJsonObject(error.data) || typeof error.data.jobId !== 'string') return undefined;
    return { jobId: error.data.jobId, status: typeof error.data.status === 'string' ? error.data.status : null };
  }

  /** What applying `recipe` would make, with `POST /recipes/preview`. Writes nothing. */
  async preview(recipe: Recipe, options: RecipePreviewOptions = {}): Promise<RecipePreview> {
    const body = await writeRecordResent<{ preview?: unknown }>(this.http, 'POST', '/recipes/preview', withOptions(recipe, options, 'preview'));
    if (!isJsonObject(body.preview)) throw new UnexpectedResponseError('Siren answered POST /recipes/preview with no preview.');
    return body.preview as unknown as RecipePreview;
  }

  /**
   * Applies `recipe` with `POST /recipes/apply`. Siren answers 202 with the
   * import, which runs on its own. Follow it with {@link import}.
   */
  async apply(recipe: Recipe, options: RecipeApplyOptions = {}): Promise<RecipeImport> {
    if (options.importKey !== undefined && (options.importKey.trim() === '' || options.importKey.length > MAX_IMPORT_KEY)) {
      throw new SirenError(`recipes.apply() takes an importKey of 1 to ${MAX_IMPORT_KEY} characters.`);
    }
    for (const [key, id] of Object.entries(options.variableAnswers ?? {})) {
      if (!Number.isInteger(id) || id < 1) throw new SirenError(`recipes.apply() takes a record id of 1 or more for the variable ${key}.`);
    }
    const body = withOptions(recipe, options, 'apply');
    const send = options.importKey === undefined ? writeRecord : writeRecordResent;
    return importOf(await send<Record<string, unknown>>(this.http, 'POST', '/recipes/apply', body), 'POST /recipes/apply');
  }

  /** One import, with `GET /recipes/imports/{jobId}`. */
  async import(jobId: string): Promise<RecipeImport> {
    if (!/^[a-zA-Z0-9]+$/.test(jobId)) throw new SirenError(`recipes.import() takes a job id of letters and digits, and got ${JSON.stringify(jobId)}.`);
    return importOf(await readObject<Record<string, unknown>>(this.http, `/recipes/imports/${jobId}`), 'GET /recipes/imports/{jobId}');
  }

  /** The org's recent imports, newest first, with `GET /recipes/imports`. Siren answers 25 unless `limit` says 1 to 100. */
  async imports(params: { limit?: number } = {}): Promise<RecipeImportSummary[]> {
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_IMPORTS)) {
      throw new SirenError(`recipes.imports() takes a limit of 1 to ${MAX_IMPORTS}.`);
    }
    const body = await readObject<{ items?: unknown }>(this.http, '/recipes/imports', params.limit === undefined ? {} : { limit: params.limit });
    if (!Array.isArray(body.items)) throw new UnexpectedResponseError('Siren answered GET /recipes/imports with no items.');
    return body.items as RecipeImportSummary[];
  }

  /** The org's setup as a recipe, with `GET /recipes/export`. `include` names the sections, and every section comes when it is empty. */
  async export(params: { include?: readonly string[] } = {}): Promise<RecipeExport> {
    const include = params.include ?? [];
    const body = await readObject<{ recipe?: unknown; skipped?: unknown }>(this.http, '/recipes/export', include.length === 0 ? {} : { include: include.join(',') });
    if (!isJsonObject(body.recipe)) throw new UnexpectedResponseError('Siren answered GET /recipes/export with no recipe.');
    return { recipe: body.recipe, skipped: isJsonObject(body.skipped) ? body.skipped : {} };
  }

  /** How many records each section of an export would hold, with `GET /recipes/export?sizes=1`. */
  async exportSizes(): Promise<Record<string, number>> {
    const body = await readObject<{ sizes?: unknown }>(this.http, '/recipes/export', { sizes: 1 });
    if (!isJsonObject(body.sizes)) throw new UnexpectedResponseError('Siren answered GET /recipes/export?sizes=1 with no sizes.');
    return body.sizes as Record<string, number>;
  }

  /**
   * Beacon's ready-made recipes, through Siren, with `GET /recipes/catalog`.
   * Siren marks each with `fits`, and with `unmetRequirements` and
   * `requiredPlan` when it does not. Siren sends each recipe as JSON text,
   * which this parses into `recipe`.
   */
  async catalog(filters: RecipeCatalogFilters = {}): Promise<RecipeCatalog> {
    for (const key of Object.keys(filters)) {
      if (!(CATALOG_FILTERS as readonly string[]).includes(key)) throw new SirenError(`recipes.catalog() takes ${CATALOG_FILTERS.join(', ')}, and not ${key}.`);
    }
    const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string | number>;
    const body = await readObject<{ recipes?: unknown; store?: unknown }>(this.http, '/recipes/catalog', query);
    if (!Array.isArray(body.recipes)) throw new UnexpectedResponseError('Siren answered GET /recipes/catalog with no recipes.');
    const recipes = (body.recipes as unknown[]).filter(isJsonObject).map((entry) => {
      const { payload, ...rest } = entry;
      let recipe: Recipe | undefined;
      try {
        const parsed: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;
        recipe = isJsonObject(parsed) ? parsed : undefined;
      } catch {
        recipe = undefined;
      }
      return { ...rest, fits: rest.fits === true, recipe } as RecipeCatalogEntry;
    });
    const store = isJsonObject(body.store) ? body.store : {};
    return { recipes, store: { integrations: Array.isArray(store.integrations) ? store.integrations : [], capabilities: Array.isArray(store.capabilities) ? store.capabilities : [] } };
  }

  /** The recipe a Beacon handoff token carries, with `POST /recipes/fetch`. */
  async fetch(token: string): Promise<Recipe> {
    if (token.trim() === '') throw new SirenError('recipes.fetch() takes a Beacon handoff token.');
    return writeRecordResent<Recipe>(this.http, 'POST', '/recipes/fetch', { token: token.trim() });
  }
}

/** The body for preview or apply: the recipe with its options beside it. */
function withOptions(recipe: Recipe, options: RecipeApplyOptions, method: string): Record<string, unknown> {
  if (!isJsonObject(recipe)) throw new SirenError(`recipes.${method}() takes a recipe as a JSON object.`);
  const clash = OPTION_NAMES.find((name) => name in recipe);
  if (clash !== undefined) throw new SirenError(`recipes.${method}() takes a recipe with no ${clash} at its top, since Siren reads ${clash} as an option.`);
  const body: Record<string, unknown> = { ...recipe };
  for (const name of OPTION_NAMES) if ((options as Record<string, unknown>)[name] !== undefined) body[name] = (options as Record<string, unknown>)[name];
  return body;
}

/** An import from Siren's answer, without the `success` flag. */
function importOf(body: Record<string, unknown>, route: string): RecipeImport {
  if (typeof body.jobId !== 'string') throw new UnexpectedResponseError(`Siren answered ${route} with no jobId.`);
  const { success: _success, ...detail } = body;
  return detail as unknown as RecipeImport;
}
