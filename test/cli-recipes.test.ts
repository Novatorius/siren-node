import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importKeyOf, handoffToken, progressLine } from '../src/cli/commands/recipes';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';
import { PREVIEW, RECIPE, importDetail } from './recipes-fixtures';

/*
 * `siren recipes` (review/cli-dx/lean-output.md in the run folder, "siren
 * recipes"), against Siren's answers from feat/apps 76d5bbdf83.
 */

const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const tty = (h: ReturnType<typeof harness>) => ({ ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });
const FILE = 'launch.recipe.json';
const previewed = reply(200, { success: true, preview: PREVIEW });
const recipeRequests = (h: ReturnType<typeof harness>) => h.http.requests.filter((request) => new URL(request.url).pathname.includes('/recipes'));
const bodyAt = (h: ReturnType<typeof harness>, at: number) => JSON.parse(recipeRequests(h)[at]!.body!) as Record<string, unknown>;
const withFile = (replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(replies, options);
  h.signedIn();
  h.write(FILE, JSON.stringify({ $schema: 'https://unpkg.com/@novatorius/siren/siren.recipe.schema.json', ...RECIPE }));
  return h;
};

describe('siren recipes preview', () => {
  it("says what the recipe makes, sends it to POST /recipes/preview without its $schema, and writes nothing", async () => {
    const h = withFile([previewed]);
    expect(await h.run(['recipes', 'preview', FILE]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview']);
    expect(bodyAt(h, 0)).toEqual(RECIPE);
    expect(h.out()).toContain(`${FILE} would make these in Acme (3), sandbox.`);
    expect(h.out()).toContain('Programs');
    expect(h.out()).toContain('1: Gold partners');
    expect(h.out()).toContain(`siren recipes apply ${FILE}`);
  });

  it('reads the recipe from standard input with -', async () => {
    const h = harness([previewed], { stdin: JSON.stringify(RECIPE) });
    h.signedIn();
    expect(await h.run(['recipes', 'preview', '-']), h.err()).toBe(0);
    expect(bodyAt(h, 0)).toEqual(RECIPE);
    expect(h.out()).toContain('The recipe would make these');
  });

  it("prints each of Siren's problems at its path, in three parts, using the plain words for a plan or integration", async () => {
    const h = withFile([
      reply(422, {
        error: {
          message: 'Recipe validation failed.',
          context: {
            type: 'RECIPE_VALIDATION_FAILED',
            errors: [
              { path: 'programs.gold.status', message: 'Invalid status.', code: 'INVALID_VALUE' },
              { path: 'programs.gold.incentiveType', message: 'PLAN_UPGRADE_REQUIRED', code: 'PLAN_UPGRADE_REQUIRED', humanMessage: 'Tiered rates need the Plus plan.', plan: 'plus' },
            ],
          },
        },
      }),
    ]);
    expect(await runCli(['recipes', 'preview', FILE], tty(h))).toBe(1);
    const lines = strip(h.err()).trimEnd().split('\n');
    expect(lines[0]).toBe(`✗ ${FILE} has 2 problems.`);
    expect(lines[1]).toBe('  Siren checks a recipe before it makes anything, so nothing was made.');
    expect(strip(h.err())).toContain('programs.gold.status');
    expect(strip(h.err())).toContain('Tiered rates need the Plus plan.');
    expect(strip(h.err()).replace(/\s+/g, ' ')).toContain(`› Fix them in ${FILE}, then run siren recipes preview ${FILE} again.`);
  });

  it('refuses a file that is not a recipe, and sends nothing', async () => {
    const h = harness([]);
    h.signedIn();
    h.write('list.json', '[]');
    expect(await h.run(['recipes', 'preview', 'list.json'])).toBe(1);
    expect(h.err()).toContain("list.json isn't a recipe.");
    expect(recipeRequests(h)).toHaveLength(0);
  });
});

describe('siren recipes apply', () => {
  it('previews, then sends nothing with no terminal to ask in, and names --yes', async () => {
    const h = withFile([previewed]);
    expect(await h.run(['recipes', 'apply', FILE])).toBe(1);
    expect(h.paths()).toEqual(['POST /recipes/preview']);
    expect(h.err()).toContain(`Run siren recipes apply ${FILE} --yes to apply it without asking.`);
  });

  it('asks in a terminal, naming the organization, and sends nothing on no', async () => {
    const h = withFile([previewed], { interactive: true, typed: ['n'] });
    expect(await h.run(['recipes', 'apply', FILE])).toBe(1);
    expect(h.prompts).toEqual(['Apply it to Acme (3), sandbox? [y/N] ']);
    expect(h.paths()).toEqual(['POST /recipes/preview']);
  });

  it('applies with an import key from its content and the file as its source, then follows the job to the end', async () => {
    const pending = importDetail({ status: 'processing', processedItems: 1, perStanzaProcessed: { programs: 1, collaborators: 0 } });
    const h = withFile([previewed, reply(202, { success: true, ...pending }), reply(200, { success: true, ...importDetail() })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'POST /recipes/apply', 'GET /recipes/imports/job7f3a']);
    expect(bodyAt(h, 1)).toEqual({ ...RECIPE, importKey: importKeyOf(RECIPE), source: { kind: 'cli', fileName: FILE } });
    expect(h.out()).toContain(`Applied ${FILE}.`);
    expect(h.out()).toMatch(/People +1 added, 0 updated, 0 skipped, 0 failed/);
  });

  it('makes the same import key whatever order the keys are in, and another for another recipe', () => {
    const shuffled = { collaborators: RECIPE.collaborators, programs: RECIPE.programs, name: RECIPE.name, version: RECIPE.version };
    expect(importKeyOf(shuffled)).toBe(importKeyOf(RECIPE));
    expect(importKeyOf({ ...RECIPE, name: 'Other' })).not.toBe(importKeyOf(RECIPE));
    expect(importKeyOf(RECIPE)).toMatch(/^cli-[0-9a-f]{64}$/);
    expect(importKeyOf(RECIPE).length).toBeLessThanOrEqual(191);
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });

  it('sends no import key with --again, so Siren applies it again as an update', async () => {
    const h = withFile([previewed, reply(202, { success: true, ...importDetail() })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes', '--again']), h.err()).toBe(0);
    expect(bodyAt(h, 1)).not.toHaveProperty('importKey');
  });

  it('names the earlier import and --again when Siren applied this recipe already', async () => {
    const h = withFile([previewed, reply(409, { error: { message: 'This recipe has already been applied here.', context: { type: 'RECIPE_ALREADY_APPLIED', jobId: 'job11', status: 'complete' } } })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes'])).toBe(1);
    expect(h.err()).toContain(`${FILE} is applied in Acme (3), sandbox already.`);
    expect(h.err()).toContain('Run siren recipes status job11 to see it, or add --again to apply it again as an update.');
  });

  it('refuses with no terminal when a variable has no --var, and sends each answer it is given', async () => {
    const needs = reply(200, { success: true, preview: { ...PREVIEW, variables: [{ key: 'partnerProgram', type: 'program', name: 'Partner program', help: null }] } });
    const missing = withFile([needs]);
    expect(await missing.run(['recipes', 'apply', FILE, '--yes'])).toBe(1);
    expect(missing.err()).toContain(`Run siren recipes apply ${FILE} --var partnerProgram=<id>.`);

    const given = withFile([needs, reply(202, { success: true, ...importDetail() })]);
    expect(await given.run(['recipes', 'apply', FILE, '--yes', '--var', 'partnerProgram=4']), given.err()).toBe(0);
    expect(bodyAt(given, 1).variableAnswers).toEqual({ partnerProgram: 4 });
  });

  it('prints the import id and stops with --no-wait', async () => {
    const h = withFile([previewed, reply(202, { success: true, ...importDetail({ status: 'pending' }) })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes', '--no-wait']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'POST /recipes/apply']);
    expect(h.out()).toContain('Started importing launch.recipe.json as job7f3a.');
    expect(h.out()).toContain('siren recipes status job7f3a');
  });

  it('stops watching on Ctrl-C with 130, and says the import goes on', async () => {
    const h = withFile([previewed, reply(202, { success: true, ...importDetail({ status: 'processing' }) })], { onSleep: (_count, abort) => abort() });
    expect(await h.run(['recipes', 'apply', FILE, '--yes'])).toBe(130);
    expect(h.err()).toContain('The import goes on.');
    expect(h.err()).toContain('siren recipes status job7f3a');
  });

  it('lists each person who failed, and exits 1', async () => {
    const failed = importDetail({ failedItems: 1, collaboratorResults: [{ key: 'ana', email: 'ana@example.com', outcome: 'failed', reason: 'The email address is not valid.' }], collaboratorSummary: { added: 0, updated: 0, skipped: 0, failed: 1, emailed: 0 } });
    const h = withFile([previewed, reply(202, { success: true, ...failed })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes'])).toBe(1);
    expect(h.out()).toContain(`Applied ${FILE}, with 1 failed.`);
    expect(h.out()).toContain('ana@example.com: The email address is not valid.');
  });
});

describe('siren recipes status, imports, export, catalog, show and fetch', () => {
  it('status shows the progress line of an import still running', async () => {
    const h = harness([reply(200, { success: true, ...importDetail({ status: 'processing', processedItems: 1, perStanzaProcessed: { programs: 1, collaborators: 0 } }) })]);
    h.signedIn();
    expect(await h.run(['recipes', 'status', 'job7f3a']), h.err()).toBe(0);
    expect(h.out()).toContain('Import job7f3a is processing.');
    expect(h.out()).toContain('Programs 1/1 · People 0/1');
  });

  it('imports lists the newest first, with --limit sent to Siren', async () => {
    const h = harness([reply(200, { success: true, items: [importDetail()] })]);
    h.signedIn();
    expect(await h.run(['recipes', 'imports', '--limit', '5']), h.err()).toBe(0);
    expect(new URL(recipeRequests(h)[0]!.url).searchParams.get('limit')).toBe('5');
    expect(h.out()).toContain('job7f3a');
    expect(h.out()).toContain(FILE);
  });

  it('export prints the recipe alone on standard output, and what it left out on standard error', async () => {
    const h = harness([reply(200, { success: true, recipe: RECIPE, skipped: { programs: [{ id: 9, name: 'Draft', reason: 'draft' }] } })]);
    h.signedIn();
    expect(await h.run(['recipes', 'export', '--include', 'programs,collaborators']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual(RECIPE);
    expect(new URL(recipeRequests(h)[0]!.url).searchParams.get('include')).toBe('programs,collaborators');
    expect(h.err()).toContain('Left out: 1 programs');
  });

  it("catalog lists the recipes with whether each fits, and show prints one's recipe", async () => {
    const catalog = { success: true, recipes: [{ id: 'gold-partners', name: 'Gold partners', fits: true, payload: JSON.stringify(RECIPE) }, { id: 'tiers', name: 'Tiers', fits: false, requiredPlan: 'plus', payload: '{}' }], store: { integrations: [], capabilities: [] } };
    const h = harness([reply(200, catalog), reply(200, catalog)]);
    h.signedIn();
    expect(await h.run(['recipes', 'catalog', '--search', 'gold']), h.err()).toBe(0);
    expect(new URL(recipeRequests(h)[0]!.url).searchParams.get('q')).toBe('gold');
    expect(h.out()).toMatch(/gold-partners +Gold partners +yes/);
    expect(h.out()).toMatch(/tiers +Tiers +needs plus/);
    const before = h.out().length;
    expect(await h.run(['recipes', 'show', 'gold-partners']), h.err()).toBe(0);
    expect(JSON.parse(h.out().slice(before))).toEqual(RECIPE);
  });

  it('fetch reads the token from a Beacon link and prints the recipe', async () => {
    expect(handoffToken('https://beacon.example/handoff?token=eyJ.a.b')).toBe('eyJ.a.b');
    expect(handoffToken('https://beacon.example/recipes/handoff/eyJ.a.b')).toBe('eyJ.a.b');
    expect(handoffToken(' eyJ.a.b ')).toBe('eyJ.a.b');
    const h = harness([reply(200, RECIPE)]);
    h.signedIn();
    expect(await h.run(['recipes', 'fetch', 'https://beacon.example/handoff?token=eyJ.a.b']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual(RECIPE);
    expect(bodyAt(h, 0)).toEqual({ token: 'eyJ.a.b' });
  });

  it('progressLine names each section with work, in plain words', () => {
    expect(progressLine({ perStanzaTotals: { programs: 3, collaboratorGroups: 2, collaborators: 40, products: 0 }, perStanzaProcessed: { programs: 3, collaboratorGroups: 2, collaborators: 18 }, processedItems: 23, totalItems: 45 })).toBe('Programs 3/3 · Groups 2/2 · People 18/40');
  });
});
