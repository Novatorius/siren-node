import { describe, expect, it } from 'vitest';
import { harness } from './cli-fakes';
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
