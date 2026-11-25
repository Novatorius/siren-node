import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import { AppHandlerError, SirenError, ValidationError } from '../src/errors';
import type { AppRequest } from '../src/record-types';
import { appRequest } from '../src/testing';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * DX pass 3 (review/sdk-dx/pass-3-review.md and pass-3-builder-spec.md):
 * type names that follow the kind (finding 4), a first test that compiles
 * under strict TypeScript (finding 2), types that match what Siren builds
 * (finding 3), and one surface across the three SDKs (finding 5). The type
 * checks run the TypeScript compiler on the README's own samples and on
 * Siren's request fixture, the way an app's editor would.
 */

const root = join(__dirname, '..');
const SECRET = 'a-secret-for-pass-3';
const read = (name: string): string => readFileSync(join(root, name), 'utf8');

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown> & { mode: string; data: Record<string, unknown> }; answer: Record<string, unknown> | null }>;
}
const features = JSON.parse(read('test/fixtures/apps-feature-contracts/requests.json')) as FeatureFixture;

function handler(replies = [reply(200, { status: 'accepted' })]) {
  const http = new FakeHttpClient(replies);
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
  return { http, answers: siren.apps.requestHandler({ signingSecret: SECRET, onError: () => undefined }) };
}

function signed(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  return {
    method: 'POST',
    rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Siren-Event': 'app.request',
      'X-Siren-Timestamp': String(t),
      'X-Siren-Signature-V2': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')}`,
    },
  };
}

/** Siren's fixture request for `kind`, with its answer address on the test base. */
function fixtureRequest(kind: string, change: (data: Record<string, unknown>) => void = () => undefined) {
  const request = structuredClone(features.kinds[kind]!.request);
  change(request.data);
  if (request.mode === 'ask') request.answerUrl = `${BASE}/apps/requests/${String(request.id)}/answer`;
  request.createdAt = new Date().toISOString();
  return signed(request);
}

// Each compiler run type-checks the SDK's source, which takes seconds and
// far more on a busy machine.
vi.setConfig({ testTimeout: 180_000 });

const scratch = mkdtempSync(join(tmpdir(), 'siren-dx3-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const COMPILER: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  allowJs: true,
  checkJs: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  esModuleInterop: true,
  skipLibCheck: true,
  types: ['node'],
  typeRoots: [join(root, 'node_modules/@types')],
  baseUrl: root,
  paths: { '@novatorius/siren': ['src/index.ts'], '@novatorius/siren/testing': ['src/testing/index.ts'] },
};

/** The compiler's errors for `files`, as `file(line): message`, for files outside src. */
function compileErrors(files: string[]): string[] {
  const program = ts.createProgram(files, COMPILER);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && !d.file.fileName.includes('/src/'))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${d.file!.fileName.split('/').pop()}(${line + 1}): ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
}

/** What an editor shows on hover at `needle` in `text`, from TypeScript's language service. */
function hoverAt(text: string, needle: string, offset = 0): string {
  const file = join(scratch, `hover-${Math.random().toString(16).slice(2)}.ts`);
  writeFileSync(file, text);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => (ts.sys.fileExists(name) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(name)!) : undefined),
    getCurrentDirectory: () => root,
    getCompilationSettings: () => COMPILER,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const info = ts.createLanguageService(host).getQuickInfoAtPosition(file, text.indexOf(needle) + offset);
  return info === undefined ? '' : ts.displayPartsToString(info.displayParts);
}

describe('DX pass 3, finding 4: each type is named from its kind, as in PHP and Python', () => {
  // The table in review/sdk-dx/pass-3-builder-spec.md, the same in all three SDKs.
  const NAMES: Record<string, string[]> = {
    postConversionAction: ['PostConversionActionTell'],
    postAllocationAction: ['PostAllocationActionTell'],
    distributionResolver: ['DistributionResolverQuestion', 'DistributionResolverAnswer'],
    incentiveResolver: ['IncentiveResolverQuestion', 'IncentiveResolverAnswer'],
    incentiveType: ['IncentiveTypeQuestion', 'IncentiveTypeAnswer'],
    metricCalculation: ['MetricCalculationQuestion', 'MetricCalculationAnswer'],
    metricFilter: ['MetricFilterQuestion', 'MetricFilterAnswer'],
    transactionFilter: ['TransactionFilterQuestion', 'TransactionFilterAnswer'],
    engagementCalculation: ['EngagementCalculationQuestion', 'EngagementCalculationAnswer'],
    engagementFilter: ['EngagementFilterQuestion', 'EngagementFilterAnswer'],
    programGroupSorter: ['ProgramGroupSorterQuestion', 'ProgramGroupSorterAnswer'],
    collaboratorGroupStructure: ['CollaboratorGroupStructureQuestion', 'CollaboratorGroupStructureAnswer'],
    payoutMethod: ['PayoutMethodQuestion', 'PayoutMethodAnswer'],
  };
  const VARIANTS = [
    'PayoutMethodPaidAnswer',
    'PayoutMethodFailedAnswer',
    'CollaboratorGroupStructureDistributorQuestion',
    'CollaboratorGroupStructureProgramQuestion',
    'CollaboratorGroupStructureChainAnswer',
    'CollaboratorGroupStructureTreeAnswer',
  ];

  it('maps every kind to the names in the table, in the generated FeatureQuestions, FeatureAnswers and FeatureTells', () => {
    const generated = read('src/feature-kind.ts');
    for (const [kind, names] of Object.entries(NAMES)) {
      for (const name of names) expect(generated, `${kind}: ${name}`).toContain(`  ${kind}: ${name};`);
    }
  });

  it('exports every new name from the package, and none of the old ones', () => {
    const types = read('src/record-types.ts');
    for (const name of [...Object.values(NAMES).flat(), ...VARIANTS]) {
      expect(types, name).toMatch(new RegExp(`export (interface|type) ${name}\\b`));
    }
    for (const old of ['AppRewardQuestion', 'AppGroupOrderQuestion', 'AppConversionApprovedData', 'AppAllocationCompletedData', 'AppPayoutPaid', 'AppDistributionQuestion']) {
      expect(types, old).not.toMatch(new RegExp(`export (interface|type) ${old}\\b`));
    }
  });

  it('gives FeatureQuestion<K>, FeatureAnswer<K> and FeatureTell<K> so a developer names the kind once', () => {
    const file = join(scratch, 'feature-types.ts');
    writeFileSync(
      file,
      [
        "import type { FeatureAnswer, FeatureQuestion, FeatureTell, DistributionResolverAnswer, DistributionResolverQuestion, PostConversionActionTell } from '@novatorius/siren'",
        'type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false',
        "export const q: Same<FeatureQuestion<'distributionResolver'>, DistributionResolverQuestion> = true",
        "export const a: Same<FeatureAnswer<'distributionResolver'>, DistributionResolverAnswer> = true",
        "export const t: Same<FeatureTell<'postConversionAction'>, PostConversionActionTell> = true",
      ].join('\n'),
    );
    expect(compileErrors([file])).toEqual([]);
  });

  it("writes one hover sentence for every kind: the name, Siren's term where it differs, the description, and tell or ask", () => {
    const generated = read('src/feature-kind.ts');
    expect(generated).toContain("   * Attribution model. Siren's code calls it the incentive resolver.");
    expect(generated).toContain('   * A tell: Siren lets the app know.\n');
    expect(generated).toContain('   * An ask: Siren waits for the app to answer.\n');
    expect(generated).not.toContain('and the app answers nothing');
  });
});

describe("DX pass 3, finding 2: the README's first test compiles under strict TypeScript", () => {
  const samples = [
    'test/readme-samples/try-it-without-siren.js',
    ...[
      'collaborator-group-structure',
      'distribution-resolver',
      'engagement-calculation',
      'engagement-filter',
      'incentive-resolver',
      'incentive-type',
      'metric-calculation',
      'metric-filter',
      'payout-method',
      'post-allocation-action',
      'post-conversion-action',
      'program-group-sorter',
      'transaction-filter',
    ].map((name) => `test/answer-samples/${name}.js`),
  ];

  it('type-checks "Try it without Siren" and every kind\'s README sample with strict on', () => {
    // What a sample leaves to the app's own code, as the samples' tests stub it.
    const helpers = join(scratch, 'app-helpers.d.ts');
    writeFileSync(
      helpers,
      [
        'declare function isStaff(collaboratorId: number, customerId: number | null): boolean',
        'declare function isRefunded(transactionId: number): boolean',
        'declare function payOnce(payoutId: number, collaborator: unknown, amount: unknown): Promise<{ ok: boolean; id: string; error: string }>',
        'declare function noteShare(requestId: string, allocation: unknown): Promise<void>',
        'declare function addToCrm(requestId: string, conversion: unknown, reward: unknown): Promise<void>',
      ].join('\n'),
    );
    expect(compileErrors([helpers, ...samples.map((name) => join(root, name))])).toEqual([]);
  });

  it("types simulate()'s answer by the kind appRequest() names", () => {
    const file = join(scratch, 'simulated.ts');
    writeFileSync(
      file,
      [
        "import { Siren } from '@novatorius/siren'",
        "import { appRequest } from '@novatorius/siren/testing'",
        'const answers = new Siren().apps.requestHandler()',
        "const { answer } = await answers.simulate(appRequest('distributionResolver', 'split-by-score'))",
        'export const shares: Record<string, number> | undefined = answer?.shares',
        "// @ts-expect-error a distribution answer's outcome is allocated",
        "export const wrong: 'rewards' | undefined = answer?.outcome",
      ].join('\n'),
    );
    expect(compileErrors([file])).toEqual([]);
  });

  it('prints the handler as AppRequestHandler and names FeatureKind when a kind is misspelled', () => {
    const text = [
      "import { Siren } from '@novatorius/siren'",
      'const answers = new Siren().apps.requestHandler()',
      "answers.on('distributionResolvr', () => answers.later())",
    ].join('\n');
    expect(hoverAt(text, 'answers =', 2)).toBe('const answers: AppRequestHandler');
    const file = join(scratch, 'typo.ts');
    writeFileSync(file, text);
    const errors = compileErrors([file]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`Argument of type '"distributionResolvr"' is not assignable to parameter of type 'FeatureKind'.`);
    expect(errors[0]).not.toContain('never');
  });
});

describe('DX pass 3, finding 3: the types hold what Siren builds', () => {
  /** Siren's fixture request and answer for each kind, checked with `satisfies` against the SDK's types. */
  function fixtureFile(change: (kind: string, data: Record<string, unknown>) => void = () => undefined): string {
    const lines = [
      "import type { AppFeatureFunctions } from '@novatorius/siren'",
      "type Req<K extends keyof AppFeatureFunctions> = Omit<Parameters<AppFeatureFunctions[K]>[0], 'timestamp' | 'deliveryId' | 'isAsk'>",
      "type Ans<K extends keyof AppFeatureFunctions> = Exclude<Awaited<ReturnType<AppFeatureFunctions[K]>>, void | import('@novatorius/siren').AppAnswerLater>",
    ];
    for (const [kind, { request, answer }] of Object.entries(features.kinds)) {
      const copy = structuredClone(request);
      change(kind, copy.data);
      lines.push(`export const req_${kind} = ${JSON.stringify(copy)} satisfies Req<'${kind}'>`);
      if (answer !== null) lines.push(`export const ans_${kind} = ${JSON.stringify(answer)} satisfies Ans<'${kind}'>`);
    }
    const file = join(scratch, `fixture-${Math.random().toString(16).slice(2)}.ts`);
    writeFileSync(file, lines.join('\n'));
    return file;
  }

  it("takes Siren's own request and answer for every kind, with no field missing, extra or mistyped", () => {
    expect(compileErrors([fixtureFile()])).toEqual([]);
  });

  it('takes the branches Siren builds beyond the fixture: a conversion with no reward, a sale with no lines, a refund', () => {
    const file = fixtureFile((kind, data) => {
      if (kind === 'postConversionAction') data.reward = null; // AppActionSubjects::forConversion(), no obligation
      if (kind === 'transactionFilter') (data.transaction as Record<string, unknown>).currency = null; // AppTransactionFilterQuestion::build(), no first line
      if (kind === 'incentiveResolver') data.reason = 'refund'; // AppRewardQuestion::REASON_REFUND
      if (kind === 'programGroupSorter') data.conversionType = 'lead';
    });
    expect(compileErrors([file])).toEqual([]);
  });

  it('catches a field Siren never sends, so the check can fail', () => {
    const file = fixtureFile((kind, data) => {
      if (kind === 'distributionResolver') data.pools = data.pool;
    });
    expect(compileErrors([file]).join('\n')).toMatch(/pools.*does not exist in type 'DistributionResolverQuestion'/);
  });

  it("refuses a reason or conversion type Siren's builders never send", () => {
    const file = fixtureFile((kind, data) => {
      if (kind === 'incentiveResolver') data.reason = 'renewed';
      if (kind === 'programGroupSorter') data.conversionType = 'subscription';
    });
    const errors = compileErrors([file]).join('\n');
    expect(errors).toContain('"renewed"');
    expect(errors).toContain('"subscription"');
  });

  it("reads an engagement type's empty args, which Siren sends as [], as {}", async () => {
    const { answers } = handler();
    const seen: unknown[] = [];
    answers.on('engagementCalculation', (request) => {
      seen.push(request.data.args);
      return { outcome: 'engagements', results: [] };
    });
    const result = await answers.simulate(fixtureRequest('engagementCalculation', (data) => (data.args = [])));
    expect(result.error).toBeNull();
    expect(seen).toEqual([{}]);
  });

  it('keeps args that hold settings as Siren sent them', async () => {
    const { answers } = handler();
    const seen: unknown[] = [];
    answers.on('engagementCalculation', (request) => {
      seen.push(request.data.args);
      return { outcome: 'engagements', results: [] };
    });
    await answers.simulate(fixtureRequest('engagementCalculation'));
    expect(seen).toEqual([{ weight: '2' }]);
  });
});

describe('DX pass 3, finding 5: one surface across the three SDKs', () => {
  it('gives every request isAsk, true for an ask and false for a tell', async () => {
    const { answers } = handler();
    const seen: Array<[string, boolean]> = [];
    answers.on('postConversionAction', (request) => void seen.push([request.mode, request.isAsk]));
    answers.on('distributionResolver', (request) => {
      seen.push([request.mode, request.isAsk]);
      return answers.later();
    });
    await answers.simulate(fixtureRequest('postConversionAction'));
    await answers.simulate(fixtureRequest('distributionResolver'));
    expect(seen).toEqual([
      ['tell', false],
      ['ask', true],
    ]);
  });

  it('answers the same four fields every time, with null for no answer and no error', async () => {
    const { answers } = handler();
    answers.on('postConversionAction', () => undefined);
    const tell = await answers.simulate(fixtureRequest('postConversionAction'));
    expect(tell).toEqual({ status: 200, body: {}, answer: null, error: null });
  });

  it('answers null after answers.later()', async () => {
    const { answers } = handler();
    answers.on('distributionResolver', () => answers.later());
    expect(await answers.simulate(fixtureRequest('distributionResolver'))).toEqual({ status: 200, body: {}, answer: null, error: null });
  });

  it('answers null beside an answer Siren would refuse, with the refusal as the error', async () => {
    const { answers } = handler();
    answers.on('distributionResolver', () => ({ outcome: 'allocated', units: 'USD', shares: { '41': 1 } }));
    const result = await answers.simulate(fixtureRequest('distributionResolver'));
    expect(result.answer).toBeNull();
    expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('throws AppHandlerError, a SirenError, for every mistake in the code that uses the handler', async () => {
    const { answers } = handler();
    const mistakes: Array<() => unknown> = [
      () => answers.on('distributionResolvr' as never, (() => answers.later()) as never),
      () => answers.on('customEvent' as never, (() => undefined) as never),
      () => answers.on('distributionResolver', 'k', (() => answers.later()) as never).on('distributionResolver', 'k', (() => answers.later()) as never),
      () => answers.onEvent('', (() => undefined) as never),
      () => answers.handle(null as never),
    ];
    for (const mistake of mistakes) {
      expect(mistake).toThrow(AppHandlerError);
      expect(mistake).toThrow(SirenError);
    }
    await expect(answers.simulate(null as never)).rejects.toThrow(AppHandlerError);
    expect(() => appRequest('distributionResolver', 'k', { secret: '' })).toThrow(AppHandlerError);
  });

  it('gives a forgotten return as AppHandlerError', async () => {
    const { answers } = handler();
    answers.on('distributionResolver', (() => undefined) as never);
    const result = await answers.simulate(fixtureRequest('distributionResolver'));
    expect(result.error).toBeInstanceOf(AppHandlerError);
    expect(result.answer).toBeNull();
  });

  it('names only the resend command in the line for a failed ask, since Siren Cloud lists the ask only once it needs attention', async () => {
    const http = new FakeHttpClient([]);
    const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: http, maxRetries: 0 });
    const answers = siren.apps.requestHandler({ signingSecret: SECRET });
    answers.on('distributionResolver', () => {
      throw new Error('ledger down');
    });
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args);
    try {
      const request = fixtureRequest('distributionResolver');
      const id = (JSON.parse(request.rawBody) as AppRequest).id;
      await (await answers.handle(request)).after!();
      expect(String(lines[0]![1])).toMatch(new RegExp(`answer window closes\\. Resend it sooner with \`siren apps resend ${id}\`\\.$`));
      expect(String(lines[0]![1])).not.toContain('Needs attention');
    } finally {
      console.error = original;
    }
  });
});

describe('DX pass 3, lower findings: the README leads with on, later and simulate, and shows FeatureKind once', () => {
  it('registers one function with FeatureKind, so the screen name shows on hover', () => {
    expect(read('README.md')).toContain('answers.on(FeatureKind.IncentiveResolver,');
  });

  it('names on, later and simulate first where it lists what the handler has', () => {
    expect(read('README.md')).toContain('The handler you mostly call: `on()`, `later()` and `simulate()`.');
  });

  it('says what the handler throws for a mistake in the code', () => {
    expect(read('README.md')).toContain('`AppHandlerError`');
  });
});
