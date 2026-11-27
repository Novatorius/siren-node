import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * DX pass 1, the README and the install (findings 1, 2, 4 and 5 of
 * review/sdk-dx/pass-1-review.md): the lead order, the first sample with no
 * baseUrl, "Try it without Siren" as the tested file, the install notes, and
 * a prepare script that a folder install survives.
 */

const root = join(__dirname, '..');
function raw(name: string): string {
  return readFileSync(join(root, name), 'utf8');
}
function section(readme: string, from: string, to: string): string {
  const start = readme.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  return readme.slice(start, readme.indexOf(to, start + from.length));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('finding 5: the README leads with answering Siren', () => {
  it('names answering Siren in the tagline', () => {
    expect(raw('README.md').split('\n')[2]).toMatch(/^Answer Siren from your own app/);
  });

  it('runs What you can do, Install, Answer Siren in a few lines, Try it without Siren, then the rest', () => {
    const headings = raw('README.md')
      .split('\n')
      .filter((line) => line.startsWith('## '));
    const lead = ['## What you can do', '## Install', '## Answer Siren in a few lines', '## Try it without Siren'];
    const at = lead.map((heading) => headings.indexOf(heading));
    expect(at.every((index) => index >= 0), String(at)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at[3]! - at[2]!).toBe(1);
    for (const later of ['## Quickstart: record a sale', '## Quickstart: verify a webhook']) {
      expect(headings.indexOf(later), later).toBeGreaterThan(at[3]!);
    }
  });

  it('says in the webhook section that an app address gets the V2 signature, which the handler checks', () => {
    const webhooks = section(raw('README.md'), '## Quickstart: verify a webhook', '\n## ');
    expect(webhooks).toContain('An app\'s address gets `X-Siren-Signature-V2`');
  });
});

describe('finding 1: the first samples name no baseUrl', () => {
  it('drops baseUrl from the handler sections and says once what it is for', () => {
    const readme = raw('README.md');
    expect(section(readme, '## Answer Siren in a few lines', '## Feature kinds')).not.toContain('baseUrl:');
    expect(readme).not.toContain('cloud.example.com');
    expect(readme).toContain('Set `baseUrl` only for a local or sandbox Siren.');
  });
});

describe('finding 2: Try it without Siren', () => {
  const sample = raw('test/readme-samples/try-it-without-siren.js');

  it('shows the tested file whole, and says the request can be posted to a running app', () => {
    const text = section(raw('README.md'), '## Try it without Siren', '\n## ');
    expect(text).toContain('```js\n' + sample.trimEnd() + '\n```');
    expect(text).toContain('any HTTP client');
  });

  it('runs as written, against the package', async () => {
    vi.stubEnv('SIREN_API_KEY', `sk_live_${'a'.repeat(64)}`);
    vi.stubEnv('SIREN_SIGNING_SECRET', 'a-test-secret');
    const name = 'try-it-without-siren';
    await expect(import(`./readme-samples/${name}.js`)).resolves.toBeDefined();
  });
});

describe('finding 4 and the lower findings: Install', () => {
  const install = (): string => section(raw('README.md'), '## Install', '\n## ');

  it('says the apps code is unreleased, and how to install the branch or a folder', () => {
    const text = install();
    expect(text).toContain('unreleased');
    expect(text).toContain('npm install github:Novatorius/siren-node#feat/apps');
    expect(text).toContain('npm install /path/to/siren-node');
  });

  it('says the samples are ES modules with top-level await', () => {
    expect(install()).toContain('`"type": "module"`');
    expect(install()).toContain('top-level `await`');
  });

  it('says new Siren() and requestHandler() read SIREN_API_KEY and SIREN_SIGNING_SECRET', () => {
    const text = section(raw('README.md'), '## Answer Siren in a few lines', '### Mount it on your server');
    expect(text).toContain('`SIREN_API_KEY`');
    expect(text).toContain('`SIREN_SIGNING_SECRET`');
  });

  it('shows the SDK calls first in Check a request, not the example app', () => {
    const text = section(raw('README.md'), '### Check a request', '### Answer an ask');
    const firstCode = text.slice(text.indexOf('```ts'), text.indexOf('```\n', text.indexOf('```ts') + 5));
    expect(firstCode).toContain('appSiren.apps.verifyRequest(');
    expect(firstCode).not.toContain('createAcmeApp');
  });
});

describe('finding 4: prepare survives an install from a folder', () => {
  const pkg = JSON.parse(raw('package.json')) as { scripts: Record<string, string>; files: string[] };

  it('runs scripts/prepare.mjs, which the package ships', () => {
    expect(pkg.scripts.prepare).toBe('node scripts/prepare.mjs');
    expect(pkg.files).toContain('scripts/prepare.mjs');
  });

  function prepareIn(withDist: boolean): { status: number; output: string } {
    const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'siren-prepare-'));
    try {
      cpSync(join(root, 'scripts', 'prepare.mjs'), join(folder, 'scripts', 'prepare.mjs'));
      if (withDist) cpSync(join(root, 'package.json'), join(folder, 'dist', 'index.js'));
      // prepare writes its lines to standard error, so npm pack --json keeps standard output for JSON.
      const run = spawnSync(process.execPath, ['scripts/prepare.mjs'], { cwd: folder, encoding: 'utf8' });
      return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it('skips the build cleanly with no tsup when dist is there', () => {
    expect(prepareIn(true)).toEqual({ status: 0, output: expect.stringContaining('dist is already built') });
  });

  it('says to run npm ci first with no tsup and no dist', () => {
    const result = prepareIn(false);
    expect(result.status).toBe(1);
    expect(result.output).toContain('npm ci');
  });

  it.skipIf(!existsSync(join(root, 'node_modules', '.bin', 'tsup')))('finds tsup in a checkout with its dev dependencies', () => {
    expect(existsSync(join(root, 'node_modules', '.bin', 'tsup'))).toBe(true);
  });
});
