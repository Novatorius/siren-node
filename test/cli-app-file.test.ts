import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appFileTemplate, declarationFor, parseAppFile } from '../src/cli/app-file';
import type { AppFileProblem } from '../src/cli/app-file';

/*
 * Acceptance tests for the app file, packet cli-app-file. Contract:
 * docs/architecture/apps-cli.md, "The app file".
 */

const example = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
const env = { SIREN_APP_URL: 'https://acme.example/siren' };

function file(app: Record<string, unknown>, top: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: 'Example.', apps: { 'acme-payouts': app }, ...top }, null, 2);
}

const good = { name: 'Acme', url: 'https://acme.example/siren', items: { 'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' } } };

function problems(text: string, environment: Record<string, string> = env): AppFileProblem[] {
  const parsed = parseAppFile(text, environment);
  expect(parsed.file, 'the file passed').toBeNull();
  expect(parsed.problems.length).toBeGreaterThan(0);
  return parsed.problems;
}

function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`${needle} is not in the text`);
  return text.slice(0, index).split('\n').length;
}

describe('apps-cli: the app file', () => {
  it('reads the example app and turns it into the declaration Siren takes', () => {
    const parsed = parseAppFile(example, env);
    expect(parsed.problems).toEqual([]);
    expect(parsed.file).not.toBeNull();
    expect(parsed.file === null ? [] : parsed.filled).toEqual(['SIREN_APP_URL']);
    expect(declarationFor(parsed.file!)).toEqual({
      key: 'acme-payouts',
      params: {
        name: 'Acme',
        description: "Siren's example app.",
        url: 'https://acme.example/siren',
        scopes: ['event:site-visited', 'event:sale'],
        events: [],
        items: [
          { kind: 'postConversionAction', key: 'notify-crm', name: 'Tell the CRM' },
          { kind: 'payoutMethod', key: 'acme-ledger', name: 'Acme ledger', currencies: ['USD'], answerWindowMinutes: 1 },
          { kind: 'distributionResolver', key: 'acme-split', name: 'Acme split', answerWindowMinutes: 1 },
        ],
      },
    });
  });

  it('names the key and the variable when ${NAME} is not set', () => {
    const [problem] = problems(example, {});
    expect(problem).toMatchObject({ path: 'apps.acme-payouts.url', line: lineOf(example, '"url"') });
    expect(problem!.message).toContain('SIREN_APP_URL');
  });

  it('fills a placeholder only in the url and only from a SIREN_APP_ name', () => {
    const leaky = { ...env, GITHUB_TOKEN: 'ghp_secret', SIREN_APP_NAME: 'Acme' };
    const inUrl = file({ ...good, url: 'https://collector.example/x?k=${GITHUB_TOKEN}' });
    const [wrongName] = problems(inUrl, leaky);
    expect(wrongName).toMatchObject({ path: 'apps.acme-payouts.url' });
    expect(wrongName!.message).toContain('SIREN_APP_');
    expect(JSON.stringify(problems(inUrl, leaky))).not.toContain('ghp_secret');

    const inName = file({ ...good, name: '${SIREN_APP_NAME}' });
    expect(problems(inName, leaky).map((problem) => problem.path)).toContain('apps.acme-payouts.name');
    const inItem = file({ ...good, items: { notify: { kind: 'postConversionAction', name: 'x', description: '${SIREN_APP_URL}' } } });
    expect(problems(inItem, leaky).map((problem) => problem.path)).toContain('apps.acme-payouts.items.notify.description');
    const atTop = file(good, { description: 'For ${SIREN_APP_NAME}' });
    expect(problems(atTop, leaky).map((problem) => problem.path)).toContain('description');
  });

  it('refuses any recipe stanza but apps, naming it', () => {
    const text = file(good, { programs: { referral: { name: 'Referral' } } });
    const [problem] = problems(text);
    expect(problem).toMatchObject({ path: 'programs', line: lineOf(text, '"programs"') });
    expect(problem!.message).toContain('programs');
  });

  it('refuses a file with no app or with two', () => {
    problems(JSON.stringify({ version: 1, name: 'Acme', description: '', apps: {} }));
    const two = JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { 'acme-a': good, 'acme-b': good } });
    expect(problems(two)[0]!.path).toBe('apps');
  });

  it('refuses each broken app or item field at its path', () => {
    const cases: Array<[string, string]> = [
      [file(good, { version: 2 }), 'version'],
      [JSON.stringify({ version: 1, description: '', apps: { 'acme-payouts': good } }), 'name'],
      [JSON.stringify({ version: 1, name: 'Acme', apps: { 'acme-payouts': good } }), 'description'],
      [JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { Acme: good } }), 'apps.Acme'],
      [JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { requests: good } }), 'apps.requests'],
      [file({ ...good, url: 'http://acme.example/siren' }), 'apps.acme-payouts.url'],
      [file({ ...good, owner: 'me' }), 'apps.acme-payouts.owner'],
      [file({ ...good, name: undefined }), 'apps.acme-payouts.name'],
      [file({ ...good, items: [] }), 'apps.acme-payouts.items'],
      [file({ ...good, items: { 'Notify CRM': { kind: 'postConversionAction', name: 'x' } } }), 'apps.acme-payouts.items.Notify CRM'],
      [file({ ...good, items: { notify: { kind: 'webhook', name: 'x' } } }), 'apps.acme-payouts.items.notify.kind'],
      [file({ ...good, items: { notify: { kind: 'postConversionAction' } } }), 'apps.acme-payouts.items.notify.name'],
      [
        file({ ...good, items: { notify: { kind: 'postConversionAction', name: 'x', currencies: ['USD'] } } }),
        'apps.acme-payouts.items.notify.currencies',
      ],
      [file({ ...good, items: { pay: { kind: 'payoutMethod', name: 'x' } } }), 'apps.acme-payouts.items.pay.currencies'],
      [
        file({ ...good, items: { pay: { kind: 'payoutMethod', name: 'x', currencies: ['USD'], answerWindowMinutes: 0 } } }),
        'apps.acme-payouts.items.pay.answerWindowMinutes',
      ],
      [
        file({ ...good, items: { pay: { kind: 'payoutMethod', name: 'x', currencies: ['USD'], answerWindowMinutes: 43201 } } }),
        'apps.acme-payouts.items.pay.answerWindowMinutes',
      ],
    ];
    for (const [text, path] of cases) {
      expect(problems(text).map((problem) => problem.path), path).toContain(path);
    }
  });

  it('takes http only for an address that a local Cloud reaches', () => {
    for (const url of ['http://localhost:8787/siren', 'http://127.0.0.1:8787', 'http://host.docker.internal:8787/siren']) {
      expect(parseAppFile(file({ ...good, url }), env).problems, url).toEqual([]);
    }
    for (const url of ['http://acme.example/siren', 'http://localhost.acme.example', 'ftp://acme.example', 'acme.example']) {
      expect(problems(file({ ...good, url })).map((problem) => problem.path), url).toContain('apps.acme-payouts.url');
    }
  });

  it('refuses a key written twice, at the second one', () => {
    const text = '{\n  "version": 1,\n  "name": "Acme",\n  "name": "Acme again",\n  "description": "",\n  "apps": {}\n}';
    const found = problems(text).find((problem) => problem.path === 'name');
    expect(found?.line).toBe(4);
  });

  it('gives the line and column of a JSON mistake', () => {
    const text = '{\n  "version": 1,\n  "name": "Acme"\n  "description": ""\n}';
    const [problem] = problems(text);
    expect(problem).toMatchObject({ path: '', line: 4, column: 3 });
  });

  it('writes a template that reads back once SIREN_APP_URL is set', () => {
    const text = appFileTemplate('acme-payouts', 'Acme');
    const parsed = parseAppFile(text, { SIREN_APP_URL: 'https://acme.example/siren' });
    expect(parsed.problems).toEqual([]);
    const { key, params } = declarationFor(parsed.file!);
    expect(key).toBe('acme-payouts');
    expect(params.name).toBe('Acme');
    expect(params.items?.map((item) => [item.kind, item.key])).toEqual([
      ['postConversionAction', 'notify'],
      ['payoutMethod', 'pay'],
    ]);
    expect(parseAppFile(text, {}).problems[0]?.message).toContain('SIREN_APP_URL');
  });
});

describe("apps-cli: the app file's JSON reader", () => {
  it('reads strings, numbers and nesting exactly as JSON.parse does', () => {
    const tricky = 'Tab\there, \u00e9, "quoted", a \\ slash, and \ud83d\ude00.';
    const text = file({ ...good, description: tricky, items: { pay: { kind: 'payoutMethod', name: 'Pay', currencies: ['USD', 'EUR'], answerWindowMinutes: 1.5e1 } } });
    const parsed = parseAppFile(text, env);
    expect(parsed.problems).toEqual([]);
    const { params } = declarationFor(parsed.file!);
    expect(params.description).toBe(tricky);
    expect(params.items).toEqual([{ kind: 'payoutMethod', key: 'pay', name: 'Pay', currencies: ['USD', 'EUR'], answerWindowMinutes: 15 }]);
  });

  it.each([
    ['a trailing comma', '{\n  "version": 1,\n}', 3, 1],
    ['single quotes', "{\n  'version': 1\n}", 2, 3],
    ['a comment', '{\n  // note\n  "version": 1\n}', 2, 3],
    ['NaN', '{\n  "version": NaN\n}', 2, 14],
    ['text after the object', '{ "version": 1 }\n{}', 2, 1],
    ['a raw line break in a string, at the string', '{\n  "name": "Ac\nme"\n}', 2, 11],
  ])('refuses %s at its line and column', (_label, text, line, column) => {
    expect(() => JSON.parse(text)).toThrow();
    const [problem] = problems(text);
    expect(problem).toMatchObject({ path: '', line, column });
  });

  it('places a problem deep in an item at that key', () => {
    const text = file({ ...good, items: { pay: { kind: 'payoutMethod', name: 'Pay', currencies: ['USD'], colour: 'red' } } });
    const found = problems(text).find((problem) => problem.path === 'apps.acme-payouts.items.pay.colour');
    expect(found?.line).toBe(lineOf(text, '"colour"'));
    expect(found?.column).toBe(text.split('\n')[found!.line - 1]!.indexOf('"colour"') + 1);
  });
});
