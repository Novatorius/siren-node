import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf } from './record-fakes';
import { harness } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';

/*
 * Slice C6: the `siren` command for the app as a container of its key, its
 * address and its features. Contract: docs/architecture/apps-sdk-container.md.
 * The answers are Siren's, from test/apps-siren-answers.ts.
 */

const KEY = APP_KEY;
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);

function appFile(app: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, name: 'Acme', description: 'Example.', apps: { [KEY]: app } }, null, 2);
}

const keyOnlyFile = appFile({ name: 'Acme', scopes: ['records:programs:read'] });
const keyOnly = appRecord({ url: null, address: null, events: [], items: [] });

describe('apps-sdk-container item 3: a key-only app from the file', () => {
  it('declares an app with no url, and writes only its key, never an empty signing secret', async () => {
    const h = harness([reply(201, { ...keyOnly, rawKey: RAW_KEY })]);
    h.signedIn();
    h.write('siren.app.json', keyOnlyFile);
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(bodyOf(h.http.requests.at(-1))).toEqual({ name: 'Acme', scopes: ['records:programs:read'] });
    const lines = h.file('.env.sandbox').trimEnd().split('\n');
    expect(lines).toEqual([`SIREN_BASE_URL=${SANDBOX_BASE_URL}`, `SIREN_API_KEY=${RAW_KEY}`]);
    expect(h.out()).toContain(`Key ${RAW_KEY.slice(0, 16)} is in ${join(h.cwd, '.env.sandbox')}.`);
    expect(h.printed()).not.toContain(RAW_KEY);
  });

  it('saves the signing secret a later apply gets when the file adds a url, and keeps the key', async () => {
    const h = harness([reply(200, { ...appRecord(), signingSecret: SIGNING_SECRET })], { env: { SIREN_APP_URL: 'https://acme.example/siren' } });
    h.signedIn();
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\n`);
    h.write('siren.app.json', appFile({ name: 'Acme', url: '${SIREN_APP_URL}' }));
    expect(await h.run(['apps', 'apply']), h.err()).toBe(0);
    expect(h.file('.env.sandbox').trimEnd().split('\n')).toEqual([
      `SIREN_BASE_URL=${SANDBOX_BASE_URL}`,
      `SIREN_API_KEY=${RAW_KEY}`,
      `SIREN_SIGNING_SECRET=${SIGNING_SECRET}`,
    ]);
    expect(h.out()).toContain(`Its new signing secret is in ${join(h.cwd, '.env.sandbox')}.`);
    expect(h.printed()).not.toContain(SIGNING_SECRET);
  });

  it('refuses a file with features and no url before anything is sent', async () => {
    const h = harness([reply(201, keyOnly)]);
    h.signedIn();
    h.write('siren.app.json', appFile({ name: 'Acme', items: { notify: { kind: 'postConversionAction', name: 'Tell me' } } }));
    expect(await h.run(['apps', 'apply'])).toBe(1);
    expect(h.http.requests).toHaveLength(0);
    expect(h.err()).toContain('has features and no url');
  });
});
