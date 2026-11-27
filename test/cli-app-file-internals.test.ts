import { describe, expect, it } from 'vitest';
import { declarationFor, parseAppFile } from '../src/cli/app-file';
import type { AppFileProblem } from '../src/cli/app-file';

/*
 * The implementer's tests for packet cli-app-file, beside the acceptance
 * tests in test/cli-app-file.test.ts. They hold the rules those tests do not
 * reach: a placeholder that is not closed, an empty variable, the lists and
 * the address's host, a key JSON.parse keeps as a plain key, and the
 * reader's escapes and endings.
 */

const env = { SIREN_APP_URL: 'https://acme.example/siren' };
const good = { name: 'Acme', url: 'https://acme.example/siren' };

function file(app: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: '', apps: { 'acme-payouts': app } }, null, 2);
}

function problems(text: string, environment: Record<string, string> = env): AppFileProblem[] {
  const parsed = parseAppFile(text, environment);
  expect(parsed.file, 'the file passed').toBeNull();
  return parsed.problems;
}

describe('the app file, beyond the contract', () => {
  it('refuses a placeholder with no closing brace, and an empty variable, without quoting the url', () => {
    const open = problems(file({ ...good, url: 'https://${SIREN_APP_HOST/x' }));
    expect(open.map((problem) => problem.path)).toEqual(['apps.acme-payouts.url']);
    expect(open[0]!.message).toContain('not closed');

    const empty = problems(file({ ...good, url: '${SIREN_APP_URL}' }), { SIREN_APP_URL: '' });
    expect(empty.map((problem) => problem.path)).toEqual(['apps.acme-payouts.url']);
    expect(empty[0]!.message).toContain('SIREN_APP_URL');
  });

  it('refuses scopes or events that are not lists of text, and an address with no host', () => {
    expect(problems(file({ ...good, scopes: 'event:sale' })).map((problem) => problem.path)).toContain('apps.acme-payouts.scopes');
    expect(problems(file({ ...good, events: [1] })).map((problem) => problem.path)).toContain('apps.acme-payouts.events');
    expect(problems(file({ ...good, url: 'https://' })).map((problem) => problem.path)).toContain('apps.acme-payouts.url');
  });

  it('refuses a file that is not a JSON object, at its start', () => {
    expect(problems('[1]')).toEqual([expect.objectContaining({ path: '', line: 1, column: 1 })]);
  });

  it('keeps __proto__ as a plain key, as JSON.parse does, and refuses it as an unknown field', () => {
    const text = '{"version":1,"name":"Acme","description":"","apps":{"acme-payouts":{"name":"Acme","url":"https://acme.example","__proto__":{"x":1}}}}';
    expect(problems(text).map((problem) => problem.path)).toContain('apps.acme-payouts.__proto__');
  });

  it('reads \\u escapes and refuses an escape JSON does not read, at the backslash', () => {
    const text = file({ ...good, description: '\u00e9\u2028' }).replace('\u00e9', '\\u00e9');
    const parsed = parseAppFile(text, env);
    expect(parsed.problems).toEqual([]);
    expect(declarationFor(parsed.file!).params.description).toBe('\u00e9\u2028');

    const bad = '{\n  "name": "A\\x41"\n}';
    expect(() => JSON.parse(bad)).toThrow();
    expect(problems(bad)).toEqual([expect.objectContaining({ path: '', line: 2, column: 13 })]);
  });

  it('refuses a file that ends inside a string or before its object closes', () => {
    expect(problems('{\n  "name": "Acme')).toEqual([expect.objectContaining({ path: '', line: 2, column: 11 })]);
    expect(problems('{\n  "name": "Acme",')).toEqual([expect.objectContaining({ path: '', line: 2, column: 18 })]);
  });
});
