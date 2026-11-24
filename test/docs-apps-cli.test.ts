import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/cli/run';
import { AppAnswers } from './apps-siren-answers';
import { specServes } from './spec-routes';

/*
 * apps-cli docs, packet docs: the README and the CHANGELOG describe the apps calls and the `siren` command, as test/docs-apps-sdk-gaps.test.ts
 * pins the slice before. The parity rows have their own test in
 * test/docs-parity.test.ts.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.split(' ')[0]!;
  const rest = markdown.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const ROUTES: Array<[string, string]> = [
  ['/apps', 'get'],
  ['/apps/{key}', 'get'],
  ['/apps/{key}', 'put'],
  ['/apps/{key}', 'delete'],
  ['/apps/{key}/status', 'post'],
  ['/apps', 'post'],
  ['/apps/{key}', 'patch'],
  ['/apps/{key}/key', 'post'],
  ['/apps/{key}/key', 'delete'],
  ['/apps/{key}/key/rotate', 'post'],
  ['/apps/{key}/secret/rotate', 'post'],
  ['/apps/{key}/test', 'post'],
  ['/apps/{key}/deliveries', 'get'],
  ['/apps/{key}/features', 'post'],
  ['/apps/{key}/features/{id}', 'get'],
  ['/apps/{key}/features/{id}', 'patch'],
  ['/apps/{key}/features/{id}', 'delete'],
  ['/apps/events', 'get'],
  ['/apps/scopes', 'get'],
  ['/apps/kinds', 'get'],
  ['/apps/requests', 'get'],
  ['/apps/requests/{id}/resend', 'post'],
];

describe('apps-cli docs', () => {
  it.each(ROUTES)("openapi.json, Siren's spec, serves %s %s", (key, method) => {
    expect(specServes(method, key)).toBe(true);
  });

  it("openapi.json, Siren's spec, serves the answer route", () => {
    expect(specServes('post', '/apps/requests/{id}/answer')).toBe(true);
  });

  it('the README shows the command-line tool, each command, and how to check a request', () => {
    const readme = read('README.md');
    const tool = section(readme, '## Command-line tool');
    for (const command of COMMANDS) expect(tool, command).toContain(`siren ${command}`);
    expect(tool).toContain('--live');
    expect(tool).toContain('.env.sandbox');
    const apps = section(readme, '## Check and answer by hand');
    expect(apps).toContain('verifyRequest(');
    expect(apps).toContain('requests.answer(');
    expect(apps).toContain('X-Siren-Signature-V2');

    // A receiver drops a repeat by the request's `id`. Idempotency-Key is
    // not signed (AP-A616), so the README never tells anyone to trust it.
    const sentences = apps.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    expect(sentences.some((line) => /repeat|again|twice|duplicate/i.test(line) && line.includes('`id`'))).toBe(true);
    const keyLines = sentences.filter((line) => line.includes('Idempotency-Key'));
    expect(keyLines.length).toBeGreaterThan(0);
    for (const line of keyLines) expect(line).toMatch(/\b(not|never)\b/);
  });

  it('the parity section counts thirty-one Node-only methods', () => {
    const parity = section(read('README.md'), '## Parity with the PHP SDK');
    expect(parity.replace(/\s+/g, ' ')).toContain('It also has thirty-one methods the PHP SDK does not have yet');
  });

  it('the CHANGELOG names the apps calls, the siren command and the sandbox key rule', () => {
    const unreleased = section(read('CHANGELOG.md'), '## [Unreleased]');
    for (const name of ['siren.apps', 'verifyRequest', 'requests.answer', '`siren`', 'sk_test_', 'SANDBOX_BASE_URL', 'AppErrorCode']) {
      expect(unreleased, name).toContain(name);
    }
    const changed = section(unreleased, '### Changed');
    expect(changed).toContain('new Siren()');
    expect(changed).toContain('sk_test_');
  });

  it('every description of resend follows merged Siren: an answered or held answer is applied, and only an applied request or a send to an off app is refused', async () => {
    // lib/Apps/Service/Rest/ResendAppRequest.php lines 31 to 38 and 82 to 87, and
    // AppRequestService::resend() lines 371 to 386, on Novatorius/siren feat/apps at 1557b0030.
    for (const name of ['src/resources/apps.ts', 'src/errors.ts', 'docs/architecture/apps-cli.md', 'README.md']) {
      expect(read(name), name).not.toMatch(/answered or applied/);
    }
    const readme = section(read('README.md'), '### See what Siren sent');
    for (const [name, text] of [['README.md', readme], ['src/resources/apps.ts', read('src/resources/apps.ts')]] as const) {
      expect(text, name).toMatch(/`answered`/);
      expect(text, name).toMatch(/app is off/);
    }
    const body = JSON.parse((AppAnswers.notResendable()).body) as { error: { message: string; context: Record<string, unknown> } };
    expect(body.error.message).toBe('This request cannot be sent again: it is applied, or its app is off.');
    expect(body.error.context).toMatchObject({ reason: 'app_request_not_resendable' });
  });

  it("the README's Check a request shows the SDK calls first, then points to the example's tested handler", () => {
    const check = section(read('README.md'), '### Check a request');
    const code = check.slice(check.indexOf('```ts'), check.indexOf('```', check.indexOf('```ts') + 5));
    // DX pass 1: the by-hand path shows verifyRequest itself, and the example app follows in words.
    expect(code).toMatch(/\.apps\.verifyRequest\(req\.body, req\.headers/);
    expect(code).toContain('SignatureVerificationError');
    expect(check.slice(check.indexOf('```', check.indexOf('```ts') + 5))).toContain('examples/apps/acme/handler.mjs');
    expect(check).toMatch(/`createAcmeApp`/);
    // The answer, its repeat and its failure belong to the handler, which test/apps-example.test.ts drives.
    expect(code).not.toContain('requests.answer(');
    expect(code).not.toMatch(/\bawait\b/);
  });
});
