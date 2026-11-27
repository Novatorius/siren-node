import { describe, expect, it } from 'vitest';
import { ConflictError, SirenError, ValidationError } from '../src/errors';
import { RecipesResource, recipeProblems } from '../src/resources/recipes';
import { reply } from './http-fakes';
import { bodyOf, pathOf, queryOf, transportOver } from './record-fakes';
import { PREVIEW, RECIPE, importDetail } from './recipes-fixtures';

/*
 * `siren.recipes`, read from Siren feat/apps 76d5bbdf83,
 * lib/Recipes/Service/Rest: PreviewRecipe, ApplyRecipe, GetRecipeImport,
 * ListRecipeImports, ExportRecipe, ListRecipeCatalog and FetchRecipe. The
 * import answers are RecipeImportJobProjection's toDetail and toListItem.
 */

const refused = (errors: unknown[]) => reply(422, { error: { message: 'Recipe validation failed.', context: { type: 'RECIPE_VALIDATION_FAILED', errors } } });

describe('siren.recipes.preview', () => {
  it('sends the recipe with its options to POST /recipes/preview and answers the preview', async () => {
    const { http, transport } = transportOver([reply(200, { success: true, preview: PREVIEW })]);
    const preview = await new RecipesResource(transport).preview(RECIPE, { configurationOnly: true });
    expect(preview).toEqual(PREVIEW);
    expect(http.requests[0]!.method).toBe('POST');
    expect(pathOf(http.requests[0])).toBe('/recipes/preview');
    expect(bodyOf(http.requests[0])).toEqual({ ...RECIPE, configurationOnly: true });
  });

  it('throws ValidationError on 422, and recipeProblems reads each path and message', async () => {
    const problems = [{ path: 'programs.gold.status', message: 'Invalid status.', code: 'INVALID_VALUE' }];
    const { transport } = transportOver([refused(problems)]);
    const error = await new RecipesResource(transport).preview(RECIPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(recipeProblems(error)).toEqual(problems);
    expect(recipeProblems(new Error('x'))).toEqual([]);
  });

  it('refuses a recipe that is not an object, or that uses an option name as a section, before sending', async () => {
    const { http, transport } = transportOver([]);
    const recipes = new RecipesResource(transport);
    await expect(recipes.preview([] as never)).rejects.toThrow(SirenError);
    await expect(recipes.preview({ ...RECIPE, importKey: 'x' })).rejects.toThrow(/importKey/);
    expect(http.requests).toHaveLength(0);
  });
});

describe('siren.recipes.apply', () => {
  it('sends the recipe and options once to POST /recipes/apply and answers the job', async () => {
    const started = importDetail({ status: 'pending', processedItems: 0 });
    const { http, transport } = transportOver([reply(202, { success: true, ...started })]);
    const job = await new RecipesResource(transport).apply(RECIPE, { importKey: 'abc123', paused: true, variableAnswers: { partnerProgram: 4 }, source: { kind: 'cli', fileName: 'launch.recipe.json' } });
    expect(job.jobId).toBe('job7f3a');
    expect(job.status).toBe('pending');
    expect(bodyOf(http.requests[0])).toEqual({ ...RECIPE, importKey: 'abc123', paused: true, variableAnswers: { partnerProgram: 4 }, source: { kind: 'cli', fileName: 'launch.recipe.json' } });
  });

  it('sends an import with a key again on a 503, since Siren takes it once, and one with no key only once', async () => {
    const keyed = transportOver([reply(503, {}), reply(202, { success: true, ...importDetail() })]);
    await new RecipesResource(keyed.transport).apply(RECIPE, { importKey: 'abc123' });
    expect(keyed.http.requests).toHaveLength(2);
    const bare = transportOver([reply(503, {}), reply(202, { success: true, ...importDetail() })]);
    await expect(new RecipesResource(bare.transport).apply(RECIPE)).rejects.toThrow(SirenError);
    expect(bare.http.requests).toHaveLength(1);
  });

  it('throws ConflictError naming the earlier job when the import key was applied already', async () => {
    const { transport } = transportOver([reply(409, { error: { message: 'This recipe has already been applied here.', context: { type: 'RECIPE_ALREADY_APPLIED', jobId: 'job11', status: 'complete' } } })]);
    const error = await new RecipesResource(transport).apply(RECIPE, { importKey: 'abc123' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(RecipesResource.earlierImport(error)).toEqual({ jobId: 'job11', status: 'complete' });
  });

  it('refuses an import key over 191 characters, and a variable answer that is not a record id, before sending', async () => {
    const { http, transport } = transportOver([]);
    const recipes = new RecipesResource(transport);
    await expect(recipes.apply(RECIPE, { importKey: 'k'.repeat(192) })).rejects.toThrow(/191/);
    await expect(recipes.apply(RECIPE, { variableAnswers: { partnerProgram: 0 } })).rejects.toThrow(/partnerProgram/);
    expect(http.requests).toHaveLength(0);
  });
});

describe('siren.recipes imports, export, catalog and fetch', () => {
  it('reads one import with GET /recipes/imports/{jobId}, retried, and refuses a job id Siren would not route', async () => {
    const { http, transport } = transportOver([reply(503, {}), reply(200, { success: true, ...importDetail() })]);
    const recipes = new RecipesResource(transport);
    expect((await recipes.import('job7f3a')).collaboratorSummary.added).toBe(1);
    expect(pathOf(http.requests[1])).toBe('/recipes/imports/job7f3a');
    await expect(recipes.import('job/../x')).rejects.toThrow(SirenError);
  });

  it('lists imports with limit, 1 to 100', async () => {
    const { http, transport } = transportOver([reply(200, { success: true, items: [importDetail()] })]);
    const recipes = new RecipesResource(transport);
    expect(await recipes.imports({ limit: 5 })).toHaveLength(1);
    expect(queryOf(http.requests[0])).toEqual({ limit: '5' });
    await expect(recipes.imports({ limit: 101 })).rejects.toThrow(/100/);
  });

  it('exports the named sections with include, and the counts alone with sizes', async () => {
    const { http, transport } = transportOver([reply(200, { success: true, recipe: RECIPE, skipped: {} }), reply(200, { success: true, sizes: { programs: 3 } })]);
    const recipes = new RecipesResource(transport);
    expect((await recipes.export({ include: ['programs', 'collaborators'] })).recipe).toEqual(RECIPE);
    expect(queryOf(http.requests[0])).toEqual({ include: 'programs,collaborators' });
    expect(await recipes.exportSizes()).toEqual({ programs: 3 });
    expect(queryOf(http.requests[1])).toEqual({ sizes: '1' });
  });

  it("reads the catalog with Siren's filters, refuses any other, and parses each recipe's payload", async () => {
    const { http, transport } = transportOver([reply(200, { success: true, recipes: [{ id: 'gold-partners', name: 'Gold partners', fits: true, payload: JSON.stringify(RECIPE) }], store: { integrations: [], capabilities: [] } })]);
    const recipes = new RecipesResource(transport);
    const catalog = await recipes.catalog({ type: 'affiliate', q: 'gold', limit: 10 });
    expect(queryOf(http.requests[0])).toEqual({ type: 'affiliate', q: 'gold', limit: '10' });
    expect(catalog.recipes[0]!.recipe).toEqual(RECIPE);
    await expect(recipes.catalog({ colour: 'red' } as never)).rejects.toThrow(/colour/);
  });

  it('fetches a recipe from a Beacon handoff token with POST /recipes/fetch', async () => {
    const { http, transport } = transportOver([reply(200, RECIPE)]);
    expect(await new RecipesResource(transport).fetch('eyJ.a.b')).toEqual(RECIPE);
    expect(bodyOf(http.requests[0])).toEqual({ token: 'eyJ.a.b' });
  });
});
