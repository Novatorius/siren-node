import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/cli/run';

/*
 * apps-cli docs, packet docs: the README, the CHANGELOG and openapi.yaml
 * describe the apps calls and the `siren` command, as test/docs-apps-sdk-gaps.test.ts
 * pins the slice before. The parity rows have their own test in
 * test/docs-parity.test.ts, which runs now.
 *
 * Pending: the packet turns `describe.skip` into `describe`.
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

function operation(openapi: string, key: string, method: string): string {
  const start = openapi.indexOf(`\n  ${key}:\n`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = openapi.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\/|\n\S/);
  const block = end < 0 ? rest : rest.slice(0, end + 1);
  const at = block.search(new RegExp(`\\n {4}${method}:\\n`));
  expect(at, `${key} ${method}`).toBeGreaterThan(-1);
  const tail = block.slice(at + 1);
  const next = tail.slice(1).search(/\n {4}[a-z]+:\n/);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

const ROUTES: Array<[string, string]> = [
  ['/apps', 'get'],
  ['/apps/{key}', 'get'],
  ['/apps/{key}', 'put'],
  ['/apps/{key}', 'delete'],
  ['/apps/{key}/status', 'post'],
  ['/apps/{key}/rotate', 'post'],
  ['/apps/requests', 'get'],
  ['/apps/requests/{id}/resend', 'post'],
];

describe.skip('apps-cli docs', () => {
  it.each(ROUTES)('openapi.yaml documents %s %s for a signed-in admin only', (key, method) => {
    const block = operation(read('openapi.yaml'), key, method);
    expect(block).toContain('dashboardSession: []');
    expect(block).not.toContain('apiKey:');
  });

  it("openapi.yaml documents the answer route for the app's key or an admin, and its codes", () => {
    const block = operation(read('openapi.yaml'), '/apps/requests/{id}/answer', 'post');
    expect(block).toContain('apiKey: []');
    expect(block).toContain('dashboardSession: []');
    for (const code of ['app_request_already_answered', 'app_answer_invalid', 'app_inactive', 'app_request_not_found']) {
      expect(block).toContain(code);
    }
  });

  it('the README shows the command-line tool, each command, and how to check a request', () => {
    const readme = read('README.md');
    const tool = section(readme, '## Command-line tool');
    for (const command of COMMANDS) expect(tool, command).toContain(`siren ${command}`);
    expect(tool).toContain('--live');
    expect(tool).toContain('.env.sandbox');
    const apps = section(readme, '## Siren apps');
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

  it('the parity section counts thirteen Node-only methods', () => {
    const parity = section(read('README.md'), '## Parity with the PHP SDK');
    expect(parity.replace(/\s+/g, ' ')).toContain('It also has thirteen methods the PHP SDK does not have yet');
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
});
