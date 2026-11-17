import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The records of the SDK follow-ups lane: the README, the CHANGELOG, the
 * architecture note (docs/architecture/apps-cli.md, "Follow-ups after the
 * merge") and openapi.yaml say what each follow-up changed.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('apps-sdk-followups-1: the records', () => {
  it('say plainly that a tell carries the stored integer, and name the helper that reads it', () => {
    const readme = read('README.md');
    expect(readme).toContain('`value` is not the amount a person reads');
    expect(readme).toContain('apps.shownAmount(value, currency)');
    expect(readme).toContain('`AppConversionApprovedData`');
    expect(readme).toContain('`AppAllocationCompletedData`');
    expect(read('CHANGELOG.md')).toContain('`siren.apps.shownAmount(value, currency)`');
    expect(read('docs/architecture/apps-cli.md')).toContain('`siren.apps.shownAmount(value, currency)`');
    expect(read('examples/apps/acme/README.md')).toContain('siren.apps.shownAmount(value, currency)');
  });

  it('say a follow run reads the edition before each poll, and what that costs', () => {
    const note = read('docs/architecture/apps-cli.md');
    expect(note).not.toContain('every loop of `apps requests --follow` use it');
    expect(note).toContain('reads it again before each poll');
    expect(note).toContain('one more GET every 2 seconds while following');
    expect(read('CHANGELOG.md')).toContain('`apps requests --follow` reads it again before each poll');
  });

  it('say the edition read gives up well under ten seconds', () => {
    const note = read('docs/architecture/apps-cli.md');
    expect(note).not.toContain('retried like any read');
    expect(note).toContain('is given up after 6.5 seconds');
    expect(read('CHANGELOG.md')).toContain('That read gives up after 6.5 seconds');
  });

  it("give both of Siren's wordings of the answer route's 404", () => {
    for (const file of ['README.md', 'docs/architecture/apps-cli.md', 'CHANGELOG.md']) {
      expect(read(file), file).toContain('"This organization has no request with this key."');
      expect(read(file), file).toContain('"No request with this key was sent to this app."');
    }
    expect(read('README.md')).not.toContain("and that the key is the app's the request went to");
  });

  it('say what an archived item is and how to bring it back', () => {
    const readme = read('README.md');
    expect(readme).toContain('An item the file no longer names while a record still selects it is archived');
    expect(readme).toContain('naming it in the file again brings it back');
    expect(read('docs/architecture/apps-cli.md')).toContain('"archived, so Siren no longer calls it"');
    expect(read('CHANGELOG.md')).toContain('`siren apps apply`, `list` and `show` mark an archived item');
  });
});
