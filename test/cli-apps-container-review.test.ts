import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthenticationError } from '../src/errors';
import { SANDBOX_BASE_URL } from '../src/http';
import { Siren } from '../src/client';
import { FakeHttpClient, reply } from './http-fakes';
import { harness, session } from './cli-fakes';
import { APP_KEY, PartAnswers, appRecord } from './apps-siren-answers';
import { capturedReply } from './cloud-captures';

/*
 * Slice C6, the review's fixes (review/apps-sdk-container-review.md in the
 * run folder). Contract: docs/architecture/apps-sdk-container.md. The
 * answers are Siren's, from test/apps-siren-answers.ts.
 */

const KEY = APP_KEY;
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const URL_ENV = { SIREN_APP_URL: 'https://acme.example/siren' };

function exampleFile(scopes: string[] = []): string {
  return JSON.stringify({
    version: 1,
    name: 'Acme payouts',
    description: 'Example.',
    apps: {
      [KEY]: {
        name: 'Acme',
        description: "Siren's example app.",
        url: '${SIREN_APP_URL}',
        scopes,
        events: [],
        items: {
          'notify-crm': { kind: 'postConversionAction', name: 'Tell the CRM' },
          'acme-ledger': { kind: 'payoutMethod', name: 'Acme ledger', currencies: ['usd'], answerWindowMinutes: 1 },
        },
      },
    },
  });
}

/** An app made in the dashboard as an address only: Siren holds no key for it. */
const noKey = appRecord({ apiKey: null, apiKeyPrefix: null, scopes: [] });

describe('apps-sdk-container review fix 1: the command for a missing key fits the app', () => {
  it('apply names add-key, never rotate-key, when the app holds no key and this machine has none', async () => {
    for (const scopes of [[], ['records:programs:read']]) {
      const h = harness([reply(200, { ...noKey, name: 'Old' }), reply(200, noKey)], { env: URL_ENV });
      h.signedIn();
      h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
      h.write('siren.app.json', exampleFile(scopes));
      expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
      expect(h.out()).toContain(
        `${KEY} holds no key, so ${join(h.cwd, '.env.sandbox')} has none. Run siren apps add-key ${KEY} to make one and save it there.`,
      );
      expect(h.printed(), String(scopes)).not.toContain('rotate-key');
    }
  });

  it('apply names rotate-key, never add-key, when the app holds a key this machine lacks', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    h.write('siren.app.json', exampleFile());
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain(`Run siren apps rotate-key ${KEY} to make a new key and save it there.`);
    expect(h.printed()).not.toContain('add-key');
  });

  function keyed(replies: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) {
    const h = harness(replies, options);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [KEY]: join(h.cwd, '.env.sandbox') } }) });
    h.write('.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
    return h;
  }

  it('rotate-key on an app with no key names add-key, and leaves the env file alone', async () => {
    const h = keyed([PartAnswers.keyMissing()]);
    expect(await h.run(['apps', 'rotate-key', KEY, '--yes'])).toBe(1);
    expect(h.paths()).toEqual([`POST /apps/${KEY}/key/rotate`]);
    expect(h.err()).toBe(`siren: ${KEY} holds no key to rotate, so nothing changed. Run siren apps add-key ${KEY} to make one.\n`);
    expect(h.file('.env.sandbox')).toBe(`SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`);
  });

  it('add-key on an app that holds a key names rotate-key', async () => {
    const h = keyed([PartAnswers.keyExists()]);
    expect(await h.run(['apps', 'add-key', KEY])).toBe(1);
    expect(h.err()).toBe(
      `siren: ${KEY} already holds a key, so nothing changed. Run siren apps rotate-key ${KEY} for a new one, which revokes the old one at once.\n`,
    );
  });

  it('rotate-secret on an app with no address says it has no secret, and names apply with a url', async () => {
    const h = keyed([PartAnswers.addressMissing()]);
    expect(await h.run(['apps', 'rotate-secret', KEY, '--yes'])).toBe(1);
    expect(h.err()).toBe(
      `siren: ${KEY} has no address, so it has no signing secret to rotate. Give it a url in its app file, then run siren apps apply.\n`,
    );
  });

  it('the 401 hint on the answer route names add-key for an app that holds no key, and rotate-key for a lost one', async () => {
    const siren = new Siren({
      apiKey: 'made-up-key',
      baseUrl: SANDBOX_BASE_URL,
      httpClient: new FakeHttpClient([capturedReply('apps-answer-401-unknown-key')]),
      maxRetries: 0,
    });
    const error = await siren.apps.requests.answer('apr_e221f712e2dd08c2daa566d3ac5ce340', { outcome: 'paid' }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toContain('When that key is lost, run siren apps rotate-key <app key> to make a new one.');
    expect((error as Error).message).toContain('When the app holds no key, as after its key was revoked, run siren apps add-key <app key>.');
  });
});

describe('apps-sdk-container review fix 2: apply says what will change, and claims no dashboard change', () => {
  it('a change made only in the file prints a header that names no dashboard change', async () => {
    const h = harness([reply(200, appRecord({ name: 'Old' })), reply(200, appRecord())], { env: URL_ENV });
    h.signedIn();
    h.write('siren.app.json', exampleFile());
    expect(await h.run(['apps', 'apply', '--yes']), h.err()).toBe(0);
    expect(h.out()).toContain(`Applying siren.app.json changes ${KEY} on ${SANDBOX_BASE_URL}:\n  name: Old becomes Acme\n`);
    expect(h.out()).not.toContain('made in the dashboard');
  });
});
