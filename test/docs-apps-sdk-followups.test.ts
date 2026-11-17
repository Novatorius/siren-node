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
});
