import { describe, expect, it } from 'vitest';
import { harness } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * Review round 1, C3: a feature no program, distributor or autofulfiller
 * picks never fires, and nothing in the CLI said so. apply and apps show
 * now say which feature waits on a pick and how to pick it.
 */

const picked = (usedBy: unknown[]) => {
  const record = appRecord();
  const [notify, ledger] = record.features as Array<Record<string, unknown>>;
  return appRecord({ features: [{ ...notify, uses: usedBy.length, openRequests: 0, usedBy }, { ...ledger, uses: 0, openRequests: 0, usedBy: [] }] });
};
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('review round 1, C3: apps show says what picks each feature', () => {
  it('counts the records that pick each feature, and says how to pick one nothing picks', async () => {
    const h = harness([reply(200, picked([{ record: 'program', id: 9, name: 'Partners' }]))]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toMatch(/PICKED BY/);
    expect(h.out()).toMatch(/notify-crm\t[^\n]*\t1\t/);
    expect(h.out()).toMatch(/acme-ledger\t[^\n]*\tnone\t/);
    // Piped, the advice goes to stderr, so stdout stays the table.
    expect(flat(h.err())).toContain('No autofulfiller picks acme-ledger yet, so Siren never sends it. Pick it on an autofulfiller in the dashboard, or in a recipe with "method":"app:12".');
    expect(h.err()).not.toContain('notify-crm');
  });

  it('adds no column and no advice for a Siren that sends no counts', async () => {
    const h = harness([reply(200, appRecord())]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).not.toContain('PICKED BY');
    expect(h.err()).not.toContain('picks');
  });
});

describe('review round 1, C3: apply names only the features nothing picks', () => {
  it('leaves out a feature a program already picks', async () => {
    const file = JSON.stringify({
      version: 1,
      apps: {
        [APP_KEY]: {
          name: 'Acme',
          description: "Siren's example app.",
          url: 'https://acme.example/siren',
          features: {
            'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM, now' },
            'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['USD'], answerWindowMinutes: 1 },
          },
        },
      },
    });
    const now = picked([{ record: 'program', id: 9 }]);
    const h = harness([reply(200, now), reply(200, { ...now, created: false })]);
    h.signedIn();
    h.write('siren.app.json', file);
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    const said = flat(h.printed());
    expect(said).toContain('No autofulfiller picks acme-ledger yet');
    expect(said).not.toContain('picks notify-crm');
  });
});
