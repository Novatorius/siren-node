import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { specServes } from './spec-routes';

/*
 * Slice 2 acceptance tests for packet P8: the reference docs describe the
 * slice's public surface. The README's configuration section, the CHANGELOG's
 * Unreleased section and Siren's openapi.json are what a caller reads, so each new
 * option, class and route must appear there, and no sentence may still say
 * every 401 is sent once.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

/** The text from a heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.split(' ')[0]!;
  const rest = markdown.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Sentences, split on a full stop followed by white space. */
function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').split(/(?<=\.)\s/);
}

describe('P8: README configuration', () => {
  it('documents accessToken, AccessTokenSource, CallbackAccessTokenSource and httpClient', () => {
    const config = section(read('README.md'), '## Configuration');

    for (const name of ['accessToken', 'AccessTokenSource', 'CallbackAccessTokenSource', 'httpClient', 'HttpClient']) {
      expect(config, name).toContain(name);
    }
  });

  it('says a 401 is resent once with a refreshed token, that an apiKey is never refreshed, and what a host HttpClient must do', () => {
    const all = sentences(section(read('README.md'), '## Configuration'));

    expect(
      all.some((s) => /\b401\b/.test(s) && /\brefresh/i.test(s) && /\bresen(?:ds?|t)\b[^.]*\bonce\b/i.test(s)),
      'a sentence says a 401 is refreshed and resent once',
    ).toBe(true);
    expect(
      all.some((s) => /`apiKey`/.test(s) && /\b401\b/.test(s) && /\bnever\b|\bnot\b|\bno\b/.test(s)),
      'a sentence says an apiKey 401 is not refreshed',
    ).toBe(true);
    expect(
      all.some((s) => /\bHttpClient\b/.test(s) && /\b(?:never|must not|does not) follows? (?:a |any )?redirects?\b/i.test(s)),
      'a sentence says an HttpClient never follows a redirect',
    ).toBe(true);
    expect(
      all.some((s) => /\brequest headers\b/i.test(s) && /\bout of (?:every |its |any )?errors?\b/i.test(s)),
      'a sentence says an HttpClient keeps the request headers out of its errors',
    ).toBe(true);
    expect(
      all.some((s) => /\bA 401, 403 or 409 is sent once\b/.test(s)),
      'the old sentence that every 401 is sent once is gone',
    ).toBe(false);
  });
});

describe('P8: CHANGELOG', () => {
  it('names every new option, class and method under Unreleased', () => {
    const changelog = read('CHANGELOG.md');
    const start = changelog.indexOf('## [Unreleased]');
    const end = changelog.indexOf('\n## [', start + 1);
    const unreleased = changelog.slice(start, end < 0 ? undefined : end);

    for (const name of [
      '`accessToken`',
      '`AccessTokenSource`',
      '`StaticAccessToken`',
      '`CallbackAccessTokenSource`',
      '`httpClient`',
      '`HttpClient`',
      '`FetchHttpClient`',
      '`HttpClientError`',
      '`ConnectorScope`',
      '`conversions.retrieve`',
      '`transactions.retrieve`',
    ]) {
      expect(unreleased, name).toContain(name);
    }
  });
});

describe("P8: openapi.json, Siren's spec", () => {
  it.each(['/conversions/{id}', '/transactions/{id}'])('serves GET %s', (key) => {
    expect(specServes('get', key)).toBe(true);
  });
});

