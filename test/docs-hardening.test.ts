import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The README's configuration section and the CHANGELOG's Unreleased section
 * are what a caller reads, so each of the bearer token, option and
 * own-property rules must appear in both.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + heading.length + 1);
  const level = heading.split(' ')[0]!;
  const next = rest.search(new RegExp(`\\n${level} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const RULES: Array<[string, RegExp]> = [
  ['the bearer token rule', /control character[\s\S]*U\+00FF/],
  ['the timeout range', /timeout[\s\S]*1 to 2147483647/],
  ['the maxRetries range', /maxRetries[\s\S]*whole number of 0 or more/],
  ['the baseUrl rule', /baseUrl[\s\S]*non-empty string/],
  ['the own-property rule', /own properties/],
];

describe('the docs describe the option and token rules', () => {
  it.each(RULES)('the README configuration section states %s', (_name, rule) => {
    expect(section(read('README.md'), '## Configuration')).toMatch(rule);
  });

  it.each(RULES)('the CHANGELOG Unreleased section states %s', (_name, rule) => {
    expect(section(read('CHANGELOG.md'), '## [Unreleased]')).toMatch(rule);
  });
});
