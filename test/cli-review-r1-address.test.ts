import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harness, session } from './cli-fakes';
import { BASE } from './record-fakes';
import { APP_KEY } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * Review round 1, C2: init said to leave SIREN_APP_URL unset on a sandbox,
 * and a sandbox without siren listen then refused the app with Siren's own
 * sentence. apply now names the fix, and init's advice holds on both.
 */

const missing = () => reply(404, { error: { message: 'App not found.', context: { reason: 'app_not_found' } } });
const needsAddress = () =>
  reply(409, {
    error: {
      message: 'An app with features needs a key and an address, and "acme-payouts" would lack an address. Siren asks the app at its address, and the app answers with its key.',
      context: { reason: 'app_features_need_key_and_address', missing: ['address'] },
    },
  });
const file = JSON.stringify({ version: 1, apps: { [APP_KEY]: { name: 'Acme', url: '${SIREN_APP_URL}', features: { notify: { kind: 'postConversionAction', name: 'Tell' } } } } });

describe('review round 1, C2: a sandbox without siren listen', () => {
  it('says the Siren needs the address, and to set SIREN_APP_URL, in place of Siren\'s sentence', async () => {
    const h = harness([missing(), needsAddress()]);
    h.signedIn();
    h.write('siren.app.json', file);
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    const said = h.err().replace(/\s+/g, ' ');
    expect(said).toContain('sandbox.sirenaffiliates.com needs an address for an app with features, so nothing was sent.');
    expect(said).toContain("Set SIREN_APP_URL to your handler's https address in .env, then run siren apps apply again.");
    expect(said).not.toContain('would lack an address');
  });

  it("keeps Siren's sentence when the app named an address", async () => {
    const h = harness([missing(), needsAddress()], { env: { SIREN_APP_URL: 'https://acme.example/siren' } });
    h.signedIn();
    h.write('siren.app.json', file);
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.err()).not.toContain('needs an address for an app with features');
  });
});

describe('review round 1, C10: init on a live Siren', () => {
  it('names no siren listen step, which a live Siren refuses, and says to set the address first', async () => {
    const h = harness([], { edition: 'production' });
    h.signedIn({ [BASE]: session({ edition: 'production', baseUrl: BASE }) });
    // A live login names its Siren as the current one, so init's hints reach it with no flags typed.
    writeFileSync(join(h.io.configDir, 'credentials.json'), JSON.stringify({ ...h.credentials(), current: BASE }), { mode: 0o600 });
    expect(await h.run(['apps', 'init']), h.err()).toBe(0);
    const out = h.out();
    expect(out).not.toContain('siren listen');
    expect(out).not.toContain('On a sandbox');
    expect(out).toMatch(/1 {2}Set SIREN_APP_URL to your https address +in \.env/);
    expect(out).toMatch(/2 {2}siren apps apply\b.*--live/);
  });

  it('keeps the listen step on a sandbox', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await h.run(['apps', 'init']), h.err()).toBe(0);
    expect(h.out()).toContain('siren listen --forward-to localhost:3000/siren');
    expect(h.out()).toContain('On a sandbox, you may leave SIREN_APP_URL unset');
  });
});
