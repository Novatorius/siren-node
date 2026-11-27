import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quietOnClosedPipe } from '../src/cli/pipe';
import { APP_KEY, appRecord, requestRow } from './apps-siren-answers';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * Two faults the demo kit found in feat/apps 56f7609, logged in
 * review/cli-dx/pass-1-review.md, "Found while building the demo kit".
 */

describe('demo fix 1: a pipe the reader closed ends the command quietly', () => {
  it('exits 0 on EPIPE, and lets any other stream error through', () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    quietOnClosedPipe(stream, (code) => exits.push(code));
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(exits).toEqual([0]);
    expect(() => stream.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }))).toThrow('EIO');
  });

  const cli = join(__dirname, '..', 'dist', 'cli.js');
  it.skipIf(!existsSync(cli))('the built siren prints no stack trace when the reader closes its output, as `| head` does', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SIREN_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'siren-cli-pipe-')) };
    const child = spawn(process.execPath, [cli, '--help'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(stderr).not.toMatch(/EPIPE|at .*\(/);
    expect(code).toBe(0);
  });
});

describe('demo fix 2: apps requests shows a request that needs attention, however old', () => {
  const attention = requestRow({ id: 'apr_ec16a240198d5bc956c9a55c01103dd4', status: 'needs_attention', createdAt: '2026-11-22T10:00:00+00:00' });
  const recent = Array.from({ length: 50 }, (_, at) => requestRow({ id: `apr_${String(at).padStart(32, '0')}`, appId: 9, status: 'delivered', createdAt: '2026-11-24T10:00:00+00:00' }));

  it('lists an app\'s request that needs attention though the latest 50 are all another app\'s', async () => {
    const h = harness([reply(200, [appRecord()]), reply(200, { requests: recent }), reply(200, { requests: [attention] })]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--app', APP_KEY]), h.err()).toBe(0);
    expect(h.out()).toContain('ec16a240');
    expect(h.out()).not.toContain('No requests');
  });

  it('shows it in the list for every app too, once', async () => {
    // The last is the idPrefix lookup for the newest, which shows the short ids find a request.
    const h = harness([reply(200, [appRecord()]), reply(200, { requests: [attention, ...recent.slice(0, 2)] }), reply(200, { requests: [attention] }), reply(200, { requests: [recent[1]], total: 1 })]);
    h.signedIn();
    expect(await h.run(['apps', 'requests']), h.err()).toBe(0);
    expect(h.out().split('\nec16a240')).toHaveLength(2);
  });

  it('says in one short line when an app has none there, and names the command that watches for them', async () => {
    // Siren keeps both lists to the app with appId, so another app's 50 never reach it (pass 3 re-check, must-fix 1).
    const h = harness([reply(200, [appRecord()]), reply(200, { requests: [] }), reply(200, { requests: [] })]);
    h.signedIn();
    expect(await h.run(['apps', 'requests', '--app', APP_KEY]), h.err()).toBe(0);
    expect(h.err()).toBe(`No requests for ${APP_KEY} yet.\nsiren apps requests --app ${APP_KEY} --follow watches for them.\n`);
    expect(h.out()).toBe('');
  });
});
