import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appLines } from '../src/cli/commands/apply';
import type { App } from '../src/record-types';
import { APP_KEY } from './apps-siren-answers';
import { harness } from './cli-fakes';
import { capturedBody, capturedReply } from './cloud-captures';

/*
 * What the `siren` command says about what a real Siren Cloud answered, for
 * the follow-ups after the merge (docs/architecture/apps-cli.md, "Follow-ups
 * after the merge"). The answers are captures from a local sandbox Cloud
 * built from Novatorius/siren feat/apps at 57999d085 (the run folder's
 * e2e2/captures), copied to test/fixtures/cloud-captures.
 */

const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
const appEnv = { SIREN_APP_URL: 'https://acme.example/siren' };
const DROPPED = 'apps-declare-200-dropped-selected-item';
const ARCHIVED_LINE = '  app:1  postConversionAction  notify-crm  Tell the CRM  archived, so Siren no longer calls it';

describe('apps-sdk-followups-1: an archived item', () => {
  it('apply marks the archived item beside it, and says once what archiving means and how to bring it back', async () => {
    const h = harness([capturedReply(DROPPED)], { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    const lines = h.out().split('\n');
    expect(lines).toContain(ARCHIVED_LINE);
    expect(lines).toContain('  app:2  fulfillmentMethod  acme-ledger  Acme ledger');
    expect(lines).toContain(
      'An archived item is one siren.app.json no longer names while a record still selects it. ' +
        'Siren keeps it so that record still points at it, never calls it, and deletes it once nothing selects it. ' +
        'To bring it back, name it in siren.app.json again with the same kind and key, and run siren apps apply.',
    );
    expect(h.out().match(/An archived item is/g)).toHaveLength(1);
  });

  it('keeps the target flags in the apply hint, and names the file as it was given', async () => {
    const h = harness([capturedReply(DROPPED)], { env: appEnv });
    h.signedIn();
    h.write('my.app.json', exampleFile);
    expect(await h.run(['apps', 'apply', 'my.app.json', '--sandbox']), h.err()).toBe(0);
    expect(h.out()).toContain('name it in my.app.json again with the same kind and key, and run siren apps apply my.app.json --sandbox.');
  });

  it('says nothing about archiving when no item is archived', async () => {
    const body = capturedBody<App>(DROPPED);
    const h = harness([capturedReply(DROPPED)].map(() => ({ status: 200, headers: {}, body: JSON.stringify({ ...body, items: body.items.map((item) => ({ ...item, status: 'active' })) }) })), { env: appEnv });
    h.signedIn();
    h.write('siren.app.json', exampleFile);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.out()).not.toContain('archived');
  });

  it('show and list mark the archived item beside it', async () => {
    const body = capturedBody<App>(DROPPED);
    const h = harness([capturedReply(DROPPED), { status: 200, headers: {}, body: JSON.stringify([body]) }]);
    h.signedIn();
    expect(await h.run(['apps', 'show', APP_KEY]), h.err()).toBe(0);
    expect(h.out().split('\n')).toContain(ARCHIVED_LINE);
    expect(h.out()).not.toContain('An archived item is');
    const before = h.out().length;
    expect(await h.run(['apps', 'list']), h.err()).toBe(0);
    expect(h.out().slice(before).split('\n')).toContain(ARCHIVED_LINE);
    expect(appLines(body)).toContain(ARCHIVED_LINE);
  });
});
