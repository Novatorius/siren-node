import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstSentence, importKeyOf, handoffToken, madeRows, namesEntry, progressLine } from '../src/cli/commands/recipes';
import { runCli } from '../src/cli/run';
import type { RecipePreview } from '../src/resources/recipes';
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
// The copy check reads the organization's programs, since the recipe makes one. None here have its name.
const noPrograms = reply(200, { items: [], total: 0, page: 1, perPage: 200, totalPages: 1 });
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
    const h = withFile([previewed, noPrograms]);
    expect(await h.run(['recipes', 'preview', FILE]), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'GET /programs']);
    expect(bodyAt(h, 0)).toEqual(RECIPE);
    expect(h.out()).toContain(`${FILE} would make these in Acme (3), sandbox.`);
    expect(h.out()).toContain('Programs');
    expect(h.out()).toContain('1: Gold partners');
    expect(h.out()).toContain(`siren recipes apply ${FILE}`);
  });

  it('reads the recipe from standard input with -', async () => {
    const h = harness([previewed, noPrograms], { stdin: JSON.stringify(RECIPE) });
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
    const h = withFile([previewed, noPrograms]);
    expect(await h.run(['recipes', 'apply', FILE])).toBe(1);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'GET /programs']);
    expect(h.err()).toContain(`Run siren recipes apply ${FILE} --yes to apply it without asking.`);
  });

  it('asks in a terminal, naming the organization, and sends nothing on no', async () => {
    const h = withFile([previewed, noPrograms], { interactive: true, typed: ['n'] });
    expect(await h.run(['recipes', 'apply', FILE])).toBe(1);
    expect(h.prompts).toEqual(['Apply it to Acme (3), sandbox? [y/N] ']);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'GET /programs']);
  });

  it('applies with an import key from its content and the file as its source, then follows the job to the end', async () => {
    const pending = importDetail({ status: 'processing', processedItems: 1, perStanzaProcessed: { programs: 1, collaborators: 0 } });
    const h = withFile([previewed, noPrograms, reply(202, { success: true, ...pending }), reply(200, { success: true, ...importDetail() })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'GET /programs', 'POST /recipes/apply', 'GET /recipes/imports/job7f3a']);
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
    // The answers and options are part of what is applied, so they are part of the key (review of PR 94, must-fix 1).
    expect(importKeyOf(RECIPE, { variableAnswers: { partnerProgram: 4 } })).not.toBe(importKeyOf(RECIPE, { variableAnswers: { partnerProgram: 5 } }));
    expect(importKeyOf(RECIPE, { variableAnswers: { a: 1, b: 2 } })).toBe(importKeyOf(RECIPE, { variableAnswers: { b: 2, a: 1 } }));
    expect(importKeyOf(RECIPE, { configurationOnly: true })).not.toBe(importKeyOf(RECIPE));
    expect(importKeyOf(RECIPE, { paused: true })).not.toBe(importKeyOf(RECIPE));
    expect(importKeyOf(RECIPE, {})).toBe(importKeyOf(RECIPE));
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });

  it('sends no import key with --again when nothing here shares a name, so Siren applies it again', async () => {
    const h = withFile([previewed, noPrograms, reply(202, { success: true, ...importDetail() })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes', '--again']), h.err()).toBe(0);
    expect(bodyAt(h, 1)).not.toHaveProperty('importKey');
  });

  // Review round 1, C9: Siren makes a recipe's programs anew on each apply, so --again would copy them.
  it('stops --again before it copies a program here, naming its id and the command that changes it', async () => {
    const gold = reply(200, { items: [{ id: 41, name: 'Gold partners' }], total: 1, page: 1, perPage: 200, totalPages: 1 });
    const h = withFile([previewed, gold]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes', '--again'])).toBe(1);
    expect(recipeRequests(h).map((request) => new URL(request.url).pathname)).toEqual([expect.stringMatching(/\/recipes\/preview$/)]);
    const flat = h.err().replace(/\s+/g, ' ');
    expect(flat).toContain(`Applying ${FILE} again would copy 1 program (41) this organization has.`);
    expect(flat).toContain('Nothing was sent.');
    expect(flat).toContain('siren programs update 41 -d <field>=<value>');
    expect(flat).toContain(`siren recipes apply ${FILE} --again --copy --yes to make the copies anyway`);
  });

  it('makes the copies with --again --copy, and lists each record the import made by id', async () => {
    const gold = reply(200, { items: [{ id: 41, name: 'Gold partners' }], total: 1, page: 1, perPage: 200, totalPages: 1 });
    const made = importDetail({ created: { programs: [{ key: 'gold', id: 52, name: 'Gold partners' }], collaborators: [{ key: 'ana', id: 9, name: 'ana@example.com' }] } });
    const h = withFile([previewed, gold, reply(202, { success: true, ...made })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes', '--again', '--copy']), h.err()).toBe(0);
    expect(bodyAt(h, 1)).not.toHaveProperty('importKey');
    expect(h.out()).toMatch(/Made +program 52 · Gold partners/);
    expect(h.out()).toMatch(/person 9 · ana@example\.com/);
  });

  it('madeRows reads a list or a map of ids, and counts people past the first five', () => {
    expect(madeRows({ created: { programs: { gold: 41 } } })).toEqual([['Made', 'program 41 · gold']]);
    const people = Array.from({ length: 7 }, (_, at) => ({ key: `p${at}`, id: at + 1, name: `p${at}@example.com` }));
    const rows = madeRows({ created: { collaborators: people } });
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toEqual(['', 'and 2 more people']);
    expect(madeRows({ created: {} })).toEqual([]);
  });

  it('names the earlier import and --again when Siren applied this recipe already', async () => {
    const h = withFile([previewed, noPrograms, reply(409, { error: { message: 'This recipe has already been applied here.', context: { type: 'RECIPE_ALREADY_APPLIED', jobId: 'job11', status: 'complete' } } })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes'])).toBe(1);
    expect(h.err()).toContain(`${FILE} is applied in Acme (3), sandbox already.`);
    expect(h.err()).toContain('Run siren recipes status job11 to see it, or add --again to apply it again as an update.');
  });

  it('refuses with no terminal when a variable has no --var, and sends each answer it is given', async () => {
    const needs = reply(200, { success: true, preview: { ...PREVIEW, variables: [{ key: 'partnerProgram', type: 'program', name: 'Partner program', help: null }] } });
    const missing = withFile([needs, noPrograms]);
    expect(await missing.run(['recipes', 'apply', FILE, '--yes'])).toBe(1);
    expect(missing.err()).toContain(`Run siren recipes apply ${FILE} --var partnerProgram=<id>.`);

    const given = withFile([needs, noPrograms, reply(202, { success: true, ...importDetail() })]);
    expect(await given.run(['recipes', 'apply', FILE, '--yes', '--var', 'partnerProgram=4']), given.err()).toBe(0);
    expect(bodyAt(given, 1).variableAnswers).toEqual({ partnerProgram: 4 });
  });

  it('prints the import id and stops with --no-wait', async () => {
    const h = withFile([previewed, noPrograms, reply(202, { success: true, ...importDetail({ status: 'pending' }) })]);
    expect(await h.run(['recipes', 'apply', FILE, '--yes', '--no-wait']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'GET /programs', 'POST /recipes/apply']);
    expect(h.out()).toContain('Started importing launch.recipe.json as job7f3a.');
    expect(h.out()).toContain('siren recipes status job7f3a');
  });

  it('stops watching on Ctrl-C with 130, and says the import goes on', async () => {
    const h = withFile([previewed, noPrograms, reply(202, { success: true, ...importDetail({ status: 'processing' }) })], { onSleep: (_count, abort) => abort() });
    expect(await h.run(['recipes', 'apply', FILE, '--yes'])).toBe(130);
    expect(h.err()).toContain('The import goes on.');
    expect(h.err()).toContain('siren recipes status job7f3a');
  });

  it('lists each person who failed, and exits 1', async () => {
    const failed = importDetail({ failedItems: 1, collaboratorResults: [{ key: 'ana', email: 'ana@example.com', outcome: 'failed', reason: 'The email address is not valid.' }], collaboratorSummary: { added: 0, updated: 0, skipped: 0, failed: 1, emailed: 0 } });
    const h = withFile([previewed, noPrograms, reply(202, { success: true, ...failed })]);
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
    // Through a pipe, standard output holds the table alone, and the hint goes to standard error (review of PR 94).
    expect(h.out().split('\n')[0]).toMatch(/^ID\tSTARTED/);
    expect(h.out()).not.toContain('shows one');
    expect(h.err()).toContain('siren recipes status job7f3a shows one.');
  });

  it('export prints the recipe alone on standard output, and what it left out on standard error', async () => {
    const h = harness([reply(200, { success: true, recipe: RECIPE, skipped: { programs: [{ id: 9, name: 'Draft', reason: 'draft' }] } })]);
    h.signedIn();
    expect(await h.run(['recipes', 'export', '--include', 'programs,collaborators']), h.err()).toBe(0);
    expect(JSON.parse(h.out())).toEqual(RECIPE);
    expect(new URL(recipeRequests(h)[0]!.url).searchParams.get('include')).toBe('programs,collaborators');
    expect(h.err()).toContain('Left out: 1 programs');
  });

  // Review round 1, C5: today's catalog names a recipe by `title`, with a number for its id and a slug.
  it("catalog reads Beacon's title, slug and description, and leaves FITS out when every recipe fits", async () => {
    const catalog = {
      success: true,
      recipes: [
        { id: 542, title: 'Introduce and close', slug: 'introduce-and-close', description: 'Pays a partner for an introduction. It also pays the closer.', fits: true, payload: JSON.stringify(RECIPE) },
        { id: 543, title: 'Store credit', slug: 'store-credit', description: 'Rewards in store credit', fits: true, payload: JSON.stringify(RECIPE) },
      ],
      store: { integrations: [], capabilities: [] },
    };
    const h = harness([reply(200, catalog), reply(200, catalog), reply(200, catalog)]);
    h.signedIn();
    expect(await h.run(['recipes', 'catalog']), h.err()).toBe(0);
    expect(h.out()).toContain('Introduce and close');
    expect(h.out()).toContain('Pays a partner for an introduction.');
    expect(h.out()).not.toContain('It also pays the closer.');
    expect(h.out()).toContain('introduce-and-close');
    expect(h.out()).not.toContain('FITS');
    expect(h.out()).not.toContain('undefined');
    expect(h.err()).toContain('siren recipes show introduce-and-close > recipe.json');
    let before = h.out().length;
    expect(await h.run(['recipes', 'show', '542']), h.err()).toBe(0);
    expect(JSON.parse(h.out().slice(before))).toEqual(RECIPE);
    before = h.out().length;
    expect(await h.run(['recipes', 'show', 'store-credit']), h.err()).toBe(0);
    expect(JSON.parse(h.out().slice(before))).toEqual(RECIPE);
  });

  it('prints each recipe as its key over its name and description when 80 columns leave no room for the table (review round 1, C8)', async () => {
    const catalog = {
      success: true,
      recipes: [
        { id: 542, title: 'Introduce and Close Affiliate Program', slug: 'introduce-and-close-affiliate-program', description: 'A dual-attribution affiliate program that pays two stacking commissions on one sale.', fits: true, payload: '{}' },
        { id: 543, title: 'Sales Override Commission Program', slug: 'tiered-sales-override-program', description: 'Launch a sales commission plan that pays each rep a percentage on the deals they close.', fits: true, payload: '{}' },
      ],
      store: { integrations: [], capabilities: [] },
    };
    const h = harness([reply(200, catalog)]);
    h.signedIn();
    expect(await runCli(['recipes', 'catalog'], tty(h))).toBe(0);
    const lines = h.out().replace(/\u001b\[[\d;]*m/g, '').split('\n');
    expect(lines.slice(0, 7)).toEqual([
      'introduce-and-close-affiliate-program',
      '  Introduce and Close Affiliate Program. A dual-attribution affiliate program',
      '  that pays two stacking commissions on one sale.',
      '',
      'tiered-sales-override-program',
      '  Sales Override Commission Program. Launch a sales commission plan that pays',
      '  each rep a percentage on the deals they close.',
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('namesEntry matches an id as text or a number, or a slug, and firstSentence keeps one sentence', () => {
    expect(namesEntry({ id: 542, fits: true }, '542')).toBe(true);
    expect(namesEntry({ id: 'gold', fits: true }, 'GOLD')).toBe(true);
    expect(namesEntry({ id: 1, slug: 'store-credit', fits: true }, 'store-credit')).toBe(true);
    expect(namesEntry({ id: 1, fits: true }, '2')).toBe(false);
    expect(firstSentence('One thing.  Two  things.')).toBe('One thing.');
    expect(firstSentence('Version 1.5 works')).toBe('Version 1.5 works');
    expect(firstSentence(undefined)).toBe('');
  });

  it("catalog lists the recipes with whether each fits, and show prints one's recipe", async () => {
    const catalog = { success: true, recipes: [{ id: 'gold-partners', name: 'Gold partners', fits: true, payload: JSON.stringify(RECIPE) }, { id: 'tiers', name: 'Tiers', fits: false, requiredPlan: 'plus', payload: '{}' }], store: { integrations: [], capabilities: [] } };
    const h = harness([reply(200, catalog), reply(200, catalog)]);
    h.signedIn();
    expect(await h.run(['recipes', 'catalog', '--search', 'gold']), h.err()).toBe(0);
    expect(new URL(recipeRequests(h)[0]!.url).searchParams.get('q')).toBe('gold');
    expect(h.out()).toMatch(/gold-partners\tGold partners\t[^\n]*yes/);
    expect(h.out()).toMatch(/tiers\tTiers\t[^\n]*needs plus/);
    expect(h.out()).not.toContain('saves one to edit');
    expect(h.err()).toContain('saves one to edit and apply.');
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

describe('siren recipes: export, then preview of the same file', () => {
  // Recorded from the PR 1250 preview: the export of its programs, and Siren's preview of that recipe.
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/recipes/programs-round-trip.json', import.meta.url), 'utf8')) as { exported: Record<string, unknown>; preview: RecipePreview };

  it("previews what export wrote, with Siren's samples as objects, and names a few by name", async () => {
    const h = harness([reply(200, { success: true, recipe: recorded.exported, skipped: {} }), reply(200, { success: true, preview: recorded.preview }), noPrograms]);
    h.signedIn();
    expect(await h.run(['recipes', 'export', '--include', 'programs']), h.err()).toBe(0);
    h.write('export.json', h.out());
    const before = h.out().length;
    expect(await h.run(['recipes', 'preview', 'export.json']), h.err()).toBe(0);
    expect(bodyAt(h, 1)).toEqual(recorded.exported);
    const shown = h.out().slice(before);
    expect(shown).toContain('export.json would make these');
    expect(shown).toMatch(/Programs +19: Referral Program, Creator Program, Influencer Program, …/);
  });
});

describe('an error inside the tool', () => {
  it('prints its stack with --verbose, and keeps it out without', async () => {
    // A preview whose sections are no list fails inside the tool, which is the case --verbose is for.
    const broken = () => harness([reply(200, { success: true, preview: { ...PREVIEW, sections: 7 } }), noPrograms]);
    const quiet = broken();
    quiet.signedIn();
    quiet.write(FILE, JSON.stringify(RECIPE));
    expect(await quiet.run(['recipes', 'preview', FILE])).toBe(1);
    expect(quiet.err()).toContain('Something went wrong inside the tool.');
    expect(quiet.err()).not.toMatch(/\n\s+at /);

    const loud = broken();
    loud.signedIn();
    loud.write(FILE, JSON.stringify(RECIPE));
    expect(await loud.run(['recipes', 'preview', FILE, '--verbose'])).toBe(1);
    expect(loud.err()).toMatch(/\n\s*at .+recipes/);
  });
});

describe('siren recipes catalog when Siren cannot reach Beacon', () => {
  it("says Siren couldn't reach Beacon and that only the catalog needs it, for catalog and show", async () => {
    for (const words of [['recipes', 'catalog'], ['recipes', 'show', 'gold-partners']]) {
      const h = harness([reply(502, { error: { message: 'Could not load recipes from Beacon.', context: { type: 'BEACON_UNAVAILABLE' } } })]);
      h.signedIn();
      expect(await h.run(words)).toBe(1);
      expect(h.err()).toContain("Siren couldn't reach Beacon, which serves the ready-made recipes.");
      expect(h.err()).toContain('Only the catalog needs Beacon.');
    }
  });
});

describe('siren recipes preview of a recipe whose records this organization already has', () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/recipes/programs-round-trip.json', import.meta.url), 'utf8')) as { exported: { programs: Record<string, { name: string }> }; preview: RecipePreview };
  const names = Object.values(recorded.exported.programs).map((program) => program.name);
  const listed = (items: Array<{ id: number; name: string }>) => reply(200, { items, total: items.length, page: 1, perPage: 200, totalPages: 1 });

  it('warns that applying makes copies, and offers the list before apply', async () => {
    const h = harness([reply(200, { success: true, preview: recorded.preview }), listed(names.map((name, at) => ({ id: at + 1, name })))]);
    h.signedIn();
    h.write('setup.json', JSON.stringify(recorded.exported));
    expect(await h.run(['recipes', 'preview', 'setup.json']), h.err()).toBe(0);
    expect(h.paths()).toEqual(['POST /recipes/preview', 'GET /programs']);
    expect(new URL(h.http.requests.at(-1)!.url).searchParams.get('number')).toBe('200');
    expect(h.out()).toContain('19 programs here already have these names. Applying makes copies.');
    const next = h.out().slice(h.out().indexOf('Next'));
    expect(next.indexOf('siren programs list')).toBeGreaterThan(-1);
    expect(next.indexOf('siren programs list')).toBeLessThan(next.indexOf('siren recipes apply setup.json'));
  });

  it('says nothing of copies when no name matches, and offers apply first', async () => {
    const h = harness([reply(200, { success: true, preview: recorded.preview }), listed([{ id: 1, name: 'Something else' }])]);
    h.signedIn();
    h.write('setup.json', JSON.stringify(recorded.exported));
    expect(await h.run(['recipes', 'preview', 'setup.json']), h.err()).toBe(0);
    expect(h.out()).not.toContain('copies');
    expect(h.out()).toMatch(/Next\n {2}siren recipes apply setup\.json/);
  });

  it('warns on apply too, before it asks', async () => {
    const h = harness([reply(200, { success: true, preview: recorded.preview }), listed([{ id: 1, name: names[0]! }])], { interactive: true, typed: ['n'] });
    h.signedIn();
    h.write('setup.json', JSON.stringify(recorded.exported));
    expect(await h.run(['recipes', 'apply', 'setup.json'])).toBe(1);
    expect(h.out()).toContain('1 program here already has this name. Applying makes a copy.');
  });
});
