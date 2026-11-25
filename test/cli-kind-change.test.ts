import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * CLI pass 2, finding 3 (review/cli-dx/pass-2-review.md): changing a
 * feature's kind in siren.app.json planned an add and a remove, so Siren
 * deleted the feature and made a new one with a new app:{id}. A record that
 * stores the old id lost it, and nothing said so. A kind locks once Siren
 * makes the feature, so apply now refuses before it sends anything, and
 * names the id and what selects it.
 */

const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };

/** The app as GET /apps/{key} answers an admin: each feature with how many records select it (GetApp.php). */
function appWithUses(uses: number) {
  const [notify, ledger] = appRecord().features;
  return appRecord({ features: [{ ...notify, uses, openRequests: 0, usedBy: [] }, { ...ledger, uses: 0, openRequests: 0, usedBy: [] }] });
}

function file(notifyKind: string): string {
  return JSON.stringify({
    version: 1,
    name: 'Acme payouts',
    description: '',
    apps: {
      [APP_KEY]: {
        name: 'Acme',
        url: '${SIREN_APP_URL}',
        features: {
          'notify-crm': { kind: notifyKind, name: 'Tell the CRM' },
          'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['usd'], answerWindowMinutes: 1 },
        },
      },
    },
  });
}

describe('cli pass 2, finding 3: a feature whose kind changes', () => {
  it('refuses, sends nothing, and names the id and how many records select it', async () => {
    const h = harness([reply(200, appWithUses(2))], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file('postAllocationAction'));
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.paths()).toEqual([`GET /apps/${APP_KEY}`]);
    expect(h.err()).toBe(
      "siren: notify-crm can't change kind. Siren holds it, app:11, as a Post-conversion action (postConversionAction), and siren.app.json makes it a Post-allocation action (postAllocationAction). " +
        'A kind locks once made, so this would replace it with a new id. The 2 records that select it would keep the old one. Nothing was sent. ' +
        'Give the Post-allocation action (postAllocationAction) its own key in siren.app.json, and keep or remove notify-crm on its own.\n',
    );
  });

  it('says when nothing selects it, and still refuses', async () => {
    const h = harness([reply(200, appWithUses(0))], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', file('postAllocationAction'));
    expect(await h.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(h.err()).toContain('this would replace it with a new id. Nothing selects it today.');
    expect(h.paths()).toEqual([`GET /apps/${APP_KEY}`]);
  });

  it('applies a file that keeps every kind, as before', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\n`);
    h.write('siren.app.json', file('postConversionAction'));
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
  });
});
