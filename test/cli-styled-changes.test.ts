import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run';
import { SANDBOX_BASE_URL } from '../src/http';
import { harness, session } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * on, off, delete, rotate-key, rotate-secret and add-key in the report
 * shape (review/cli-dx/output-catalog.md in the run folder, "Apps: read
 * and change"): a ✓ line with the app in bold and what it means, a dim ›
 * tip, and a refusal that says nothing was sent, why, and the command
 * with --yes.
 */

const ESC = '\u001b[';
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const RAW_KEY_2 = `sk_test_${'1b'.repeat(32)}`;
const SECRET = 'ef'.repeat(32);
const SECRET_2 = 'cd'.repeat(32);
const tty = (h: ReturnType<typeof harness>) => ({ ...h.io, stdoutTty: true, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } });

function withEnvFile(replies: ReturnType<typeof reply>[], options: Parameters<typeof harness>[1] = {}) {
  const h = harness(replies, options);
  mkdirSync(join(h.cwd, 'acme'));
  h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(h.cwd, 'acme', '.env.sandbox') } }) });
  h.write('acme/.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SECRET}\n`);
  return h;
}

describe('siren apps on and off', () => {
  it('says the new state with what it means, and for off, the command that turns it back on', async () => {
    const h = harness([reply(200, appRecord({ status: 'inactive' })), reply(200, appRecord())]);
    h.signedIn();
    expect(await h.run(['apps', 'off', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toBe('acme-payouts is off. Siren sends it nothing.\nsiren apps on acme-payouts turns it back on.\n');
    const before = h.out().length;
    expect(await h.run(['apps', 'on', APP_KEY]), h.err()).toBe(0);
    expect(h.out().slice(before)).toBe('acme-payouts is on. Siren sends it requests again.\n');
  });

  it('in a terminal: a green ✓, the app in bold, and the command in bold', async () => {
    const h = harness([reply(200, appRecord({ status: 'inactive' }))]);
    h.signedIn();
    expect(await runCli(['apps', 'off', APP_KEY], tty(h))).toBe(0);
    expect(strip(h.out())).toBe('✓ acme-payouts is off. Siren sends it nothing.\n› siren apps on acme-payouts turns it back on.\n');
    expect(h.out()).toContain(`${ESC}1macme-payouts${ESC}0m is off`);
    expect(h.out()).toContain(`${ESC}1msiren apps on acme-payouts${ESC}0m`);
  });
});

describe('siren apps delete', () => {
  it('says it deleted the app and that its key no longer works, with no address', async () => {
    const h = harness([reply(200, { success: true })]);
    h.signedIn();
    expect(await h.run(['apps', 'delete', APP_KEY, '--yes']), h.err()).toBe(0);
    expect(h.out()).toBe('Deleted acme-payouts. Its key no longer works.\n');
    expect(h.out()).not.toContain(SANDBOX_BASE_URL);
  });

  it('with no --yes and no terminal: nothing deleted, why, and the command with --yes', async () => {
    const h = harness([]);
    h.signedIn();
    expect(await runCli(['apps', 'delete', APP_KEY], { ...tty(h), interactive: false })).toBe(1);
    expect(strip(h.err())).toBe(
      ['✗ Nothing deleted: deleting needs a yes.', '  It revokes the key and cannot be undone.', '› Run siren apps delete acme-payouts --yes.', ''].join('\n'),
    );
    expect(h.paths()).toEqual([]);
  });
});

describe('siren apps rotate-key, rotate-secret and add-key', () => {
  it('rotate-key: a ✓ line, where the new key went with a short prefix, and a tip to restart the app', async () => {
    const h = withEnvFile([reply(200, { ...appRecord(), rawKey: RAW_KEY_2 })]);
    expect(await h.run(['apps', 'rotate-key', APP_KEY, '--yes']), h.err()).toBe(0);
    expect(h.out()).toBe(
      ['Rotated the key of acme-payouts', '', `  Key   ${RAW_KEY_2.slice(0, 16)}… in acme/.env.sandbox`, '', 'Siren revoked the old key. Restart your app so it reads the new one.', ''].join('\n'),
    );
    expect(h.printed()).not.toContain(RAW_KEY_2);
  });

  it('rotate-secret: a ✓ line, where the secret went, and a tip to restart the app', async () => {
    const h = withEnvFile([reply(200, { ...appRecord(), signingSecret: SECRET_2 })]);
    expect(await h.run(['apps', 'rotate-secret', APP_KEY, '--yes']), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        'Rotated the signing secret of acme-payouts',
        '',
        '  Secret   in acme/.env.sandbox',
        '',
        'Siren signs with the new secret from now on. Restart your app so it reads it.',
        '',
      ].join('\n'),
    );
    expect(h.printed()).not.toContain(SECRET_2);
  });

  it('add-key: a ✓ line, where the key went, and apply as the next step', async () => {
    const h = harness([reply(201, { ...appRecord(), rawKey: RAW_KEY_2 })]);
    mkdirSync(join(h.cwd, 'acme'));
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(h.cwd, 'acme', '.env.sandbox') } }) });
    h.write('acme/.env.sandbox', `SIREN_BASE_URL=${SANDBOX_BASE_URL}\n`);
    expect(await h.run(['apps', 'add-key', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toBe(
      [
        'Made a key for acme-payouts',
        '',
        `  Key   ${RAW_KEY_2.slice(0, 16)}… in acme/.env.sandbox`,
        '',
        'Next',
        '  1  siren apps apply   give the key the scopes your app file names',
        '',
      ].join('\n'),
    );
  });

  it('with no --yes and no terminal: nothing sent, why, and the command with --yes', async () => {
    const h = withEnvFile([]);
    expect(await runCli(['apps', 'rotate-key', APP_KEY], { ...tty(h), interactive: false })).toBe(1);
    expect(strip(h.err())).toBe(
      ['✗ Nothing sent: rotating needs a yes.', '  The old key stops working at once.', '› Run siren apps rotate-key acme-payouts --yes.', ''].join('\n'),
    );
    expect(h.paths()).toEqual([]);
  });

  it('asks with an amber ! in a terminal, and a no sends nothing in one dim line with exit 1', async () => {
    const h = withEnvFile([], { interactive: true, typed: ['n'] });
    expect(await runCli(['apps', 'rotate-secret', APP_KEY], tty(h))).toBe(1);
    expect(h.out()).toContain(`${ESC}33m!${ESC}0m Rotating the signing secret makes Siren sign with the new one at once.`);
    expect(strip(h.err())).toBe('Nothing sent. The old signing secret still works.\n');
    expect(h.paths()).toEqual([]);

    const plain = withEnvFile([], { interactive: true, typed: ['n'] });
    expect(await plain.run(['apps', 'rotate-key', APP_KEY])).toBe(1);
    expect(plain.err()).toBe('siren: Nothing was sent, and the old key still works.\n');
  });

  it('fits 80 columns in a terminal', async () => {
    const h = withEnvFile([reply(200, { ...appRecord(), rawKey: RAW_KEY_2 })]);
    expect(await runCli(['apps', 'rotate-key', APP_KEY, '--yes'], tty(h))).toBe(0);
    for (const line of strip(h.out()).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
    await expect(h.out()).toMatchFileSnapshot('./__snapshots__/cli-styled-rotate.txt');
  });
});
