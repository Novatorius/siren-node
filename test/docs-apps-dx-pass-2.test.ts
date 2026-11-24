import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * DX pass 2's README records (review/sdk-dx/pass-2-builder-spec.md in the
 * apps run folder). The "How Siren talks to your app" block is the same,
 * word for word, at the top of the Node, PHP and Python READMEs. Each SDK's
 * test holds its own README's block equal to this text.
 */

const MODEL = `## How Siren talks to your app

- **An app** is your own code that works with Siren. It holds a key, which it calls Siren with, and an address, where Siren sends it signed requests.
- **The signing secret** belongs to the address. Siren signs every request with it, and the handler checks each one.
- **A feature** is what the app adds to one of Siren's pickers. Its kind says what it does, such as \`distributionResolver\`, and its key names it in your app.
- **A tell** lets the app know something happened, such as an approved conversion. The handler runs your function and replies 200.
- **An ask** needs an answer, and the work it's about waits for it. The handler replies 200 at once, runs your function and posts what it returns.
- **A custom event** goes the other way: the app sends it to Siren.
`;

function raw(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

describe('DX pass 2: the README', () => {
  it('opens with the same "How Siren talks to your app" block as the other SDKs, after the tagline and before What you can do', () => {
    const readme = raw('README.md');
    const at = readme.indexOf(MODEL);
    expect(at).toBeGreaterThan(readme.indexOf('## What is Siren?'));
    expect(at).toBeLessThan(readme.indexOf('## What you can do'));
    expect(readme.indexOf(MODEL + '\n## What you can do')).toBe(at);
  });

  it('says how to answer later, and that returning nothing is an error', () => {
    const readme = flat(raw('README.md'));
    expect(readme).not.toContain('or `undefined` when the app answers later');
    expect(readme).toContain('return `answers.later()`');
    expect(readme).toContain('returns nothing, `onError` gets an error that says so');
  });

  it('has a reply row for a failed function, with the tell and the ask side by side', () => {
    const readme = raw('README.md');
    const row = readme.split('\n').find((line) => line.startsWith('| When your function fails |'));
    expect(row).toBeDefined();
    expect(row).toContain('about 1, 2, 4 and 8 minutes later');
    expect(row).toContain('when its answer window closes');
    expect(row).toContain('`siren apps resend <id>`');
  });

  it('says an ask can run more than once, so it writes once by id and answers the same each time', () => {
    const readme = flat(raw('README.md'));
    expect(readme).toContain(
      "An ask's function can run more than once for one request: on a repeat delivery, and on each resend after its answer window closes.",
    );
    expect(readme).toContain('return the same answer each time');
  });

  it('names extraKinds and the kind check in one line each', () => {
    const readme = flat(raw('README.md'));
    expect(readme).toContain('`extraKinds`');
    expect(readme).toContain('refuses a kind Siren never sends');
  });

  it("warns that a running app posts to real Siren Cloud, while simulate() posts nothing", () => {
    const readme = raw('README.md');
    const section = flat(readme.slice(readme.indexOf('## Try it without Siren'), readme.indexOf('## Mount it on your server')));
    expect(section).toContain('A running app posts its answers to the real Siren Cloud');
    expect(section).toContain('`simulate` posts nothing');
  });

  it('drops the old payout alias and says simulate checks answers as Siren does', () => {
    const readme = flat(raw('README.md'));
    expect(readme).not.toContain('AppItemKind.FulfillmentMethod');
    expect(readme).toContain("checks the answer with Siren's own rules for its kind");
  });

  it('records the changes in the CHANGELOG', () => {
    const changelog = flat(raw('CHANGELOG.md'));
    const unreleased = changelog.slice(0, changelog.indexOf('## [', changelog.indexOf('## [Unreleased]') + 5));
    for (const words of ['`answers.later()`', '`extraKinds`', '`AppItemKind.FulfillmentMethod`', '`app_answer_invalid`', '`siren apps resend']) {
      expect(unreleased, words).toContain(words);
    }
  });
});
