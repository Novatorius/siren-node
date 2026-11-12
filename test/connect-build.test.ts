import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as connectSource from '../src/connect/index';
import * as mainSource from '../src/index';

/*
 * Slice 5 tests for the `@novatorius/siren/connect` entry. The entry, its
 * export map and the shared build chunk are written in the architecture
 * commit, so these tests hold now and belong to no packet.
 *
 * The build tests need `npm run build` first, as CI runs it. They check that
 * the two entries share one copy of every class: an error the connect entry
 * throws is an instance of the class the main entry exports.
 */

const root = join(__dirname, '..');
const dist = (file: string) => join(root, 'dist', file);

/** What `@novatorius/siren/connect` exports, and nothing else. */
const CONNECT_EXPORTS = [
  'CallbackAccessTokenSource',
  'ConnectResource',
  'ConnectScope',
  'ConnectWebhookResource',
  'ConnectorScope',
  'ConnectorSoftware',
  'DEFAULT_CONSENT_SCREEN_URL',
  'DEFAULT_OAUTH_TIMEOUT_MS',
  'FORWARDED_EVENT_VERSION',
  'ForwardedEventSlug',
  'OAuthClient',
  'OAuthError',
  'OAuthErrorCode',
  'SirenConnect',
  'StaticAccessToken',
  'codeChallengeS256',
  'createCodeVerifier',
  'createState',
];

/** The connect classes stay out of the main entry, so a store that never connects loads none of them. */
const CONNECT_ONLY = ['SirenConnect', 'ConnectResource', 'ConnectWebhookResource', 'OAuthClient', 'OAuthError', 'codeChallengeS256', 'createCodeVerifier', 'createState', 'ConnectScope'];

/** Values both entries export, which must be the same object. */
const SHARED = ['StaticAccessToken', 'CallbackAccessTokenSource', 'ConnectorScope', 'ForwardedEventSlug', 'FORWARDED_EVENT_VERSION'];

describe('connect entry source', () => {
  it('exports the connected-site API', () => {
    expect(Object.keys(connectSource).sort()).toEqual([...CONNECT_EXPORTS].sort());
  });

  it('keeps the connect classes out of the main entry, and exports the envelope vocabulary there', () => {
    for (const name of CONNECT_ONLY) expect(Object.keys(mainSource), name).not.toContain(name);
    expect(mainSource.ForwardedEventSlug).toBe(connectSource.ForwardedEventSlug);
  });

  it('maps ./connect in package.json for import, require and types', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      typesVersions: Record<string, Record<string, string[]>>;
    };

    expect(pkg.exports['./connect']).toEqual({
      import: { types: './dist/connect.d.ts', default: './dist/connect.js' },
      require: { types: './dist/connect.d.cts', default: './dist/connect.cjs' },
    });
    expect(pkg.typesVersions['*']!.connect).toEqual(['./dist/connect.d.ts']);
  });
});

// Outside CI a run without a build skips the build checks. CI builds first,
// so there a missing build fails instead of skipping.
describe('connect build output', () => {
  it('is present when CI runs the tests', () => {
    if (process.env.CI) expect(existsSync(dist('connect.js')), 'run npm run build before npm test').toBe(true);
  });
});

describe.skipIf(!existsSync(dist('connect.js')))('connect build', () => {
  it('builds every file the export map names', () => {
    for (const file of ['connect.js', 'connect.cjs', 'connect.d.ts', 'connect.d.cts']) {
      expect(existsSync(dist(file)), file).toBe(true);
    }
  });

  it('shares one copy of each class with the main entry in ESM', async () => {
    const main = (await import(dist('index.js'))) as Record<string, unknown>;
    const connect = (await import(dist('connect.js'))) as Record<string, unknown>;

    expect(Object.keys(connect).sort()).toEqual([...CONNECT_EXPORTS].sort());
    for (const name of SHARED) expect(connect[name], name).toBe(main[name]);
    expect(Object.getPrototypeOf(connect.OAuthError)).toBe(main.SirenError);
  });

  it('shares one copy of each class with the main entry in CommonJS', () => {
    const require = createRequire(import.meta.url);
    const main = require(dist('index.cjs')) as Record<string, unknown>;
    const connect = require(dist('connect.cjs')) as Record<string, unknown>;

    expect(Object.keys(connect).sort()).toEqual([...CONNECT_EXPORTS].sort());
    for (const name of SHARED) expect(connect[name], name).toBe(main[name]);
    expect(Object.getPrototypeOf(connect.OAuthError)).toBe(main.SirenError);
  });
});
