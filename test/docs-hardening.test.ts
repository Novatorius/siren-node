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

/** The section's paragraphs and list items, so a rule must sit inside one of them. */
function blocks(text: string): string[] {
  return text.split(/\n\s*\n|\n(?=- )/);
}

/** True when one paragraph or list item of `text`, its line breaks read as spaces, matches `rule`. */
function stated(text: string, rule: RegExp): boolean {
  return blocks(text).some((block) => rule.test(block.replace(/\s+/g, ' ')));
}

const RULES: Array<[string, RegExp]> = [
  ['the bearer token rule', /control character[\s\S]*U\+00FF/],
  ['the timeout range', /timeout[\s\S]*1 to 2147483647/],
  ['the timeout for each send', /timeout[\s\S]*for each send/],
  ['the maxRetries range', /maxRetries[\s\S]*whole number of 0 or more/],
  ['the maxRetries rule with no ceiling', /maxRetries[\s\S]*no ceiling/],
  ['the baseUrl rule', /baseUrl[\s\S]*http or https URL with no user name or password/],
  ['the own-property rule', /own properties/],
];

describe('the docs describe the option and token rules', () => {
  it.each(RULES)('the README configuration section states %s', (_name, rule) => {
    expect(stated(section(read('README.md'), '## Configuration'), rule)).toBe(true);
  });

  it.each(RULES)('the CHANGELOG Unreleased section states %s', (_name, rule) => {
    expect(stated(section(read('CHANGELOG.md'), '## [Unreleased]'), rule)).toBe(true);
  });

  it('the README retries section states the most sends a call makes', () => {
    expect(stated(section(read('README.md'), '### Retries'), /maxRetries \+ 2/)).toBe(true);
  });
});
