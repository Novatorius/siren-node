import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_BASE_URL } from '../src/http';
import { reply } from './http-fakes';
import { harness, session } from './cli-fakes';
import { APP_KEY, appMissing, appRecord } from './apps-siren-answers';

/*
 * The env file that holds an app's key and signing secret. Every write of
 * it is watched here: after each `writeFile` and `rename` the tool makes,
 * the file it touched is read, and when it holds the new key its mode is
 * kept. A file that ever holds the new key with a mode wider than 0600 is a
 * key other users of the machine could read.
 */

const watch = vi.hoisted(() => ({ key: '', failWith: '', marks: [] as Array<{ path: string; mode: number }> }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const record = async (path: unknown) => {
    if (watch.key === '') return;
    try {
      if ((await real.readFile(String(path), 'utf8')).includes(watch.key)) {
        watch.marks.push({ path: String(path), mode: (await real.stat(String(path))).mode & 0o777 });
      }
    } catch {
      // A path that is gone or not a file holds no key.
    }
  };
  const writeFile = async (path: Parameters<typeof real.writeFile>[0], data: Parameters<typeof real.writeFile>[1], options?: Parameters<typeof real.writeFile>[2]) => {
    if (watch.failWith !== '' && typeof data === 'string' && data.includes(watch.failWith)) {
      // A full disk: the file is opened, and so emptied or made, and nothing lands in it.
      await real.writeFile(path, '', options);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    await real.writeFile(path, data, options);
    await record(path);
  };
  const rename = async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
    await real.rename(from, to);
    await record(to);
  };
  return { ...real, default: { ...real, writeFile, rename }, writeFile, rename };
});

const posix = process.platform !== 'win32';
const RAW_KEY = `sk_test_${'0a'.repeat(32)}`;
const SIGNING_SECRET = 'ef'.repeat(32);
const RAW_KEY_2 = `sk_test_${'1b'.repeat(32)}`;
const SIGNING_SECRET_2 = '9c'.repeat(32);
const appEnv = { SIREN_APP_URL: 'https://acme.example/siren' };
const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
const OLD_ENV = `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`;
const NEW_ENV = `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY_2}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET_2}\n`;
/** The env file after `rotate-key`: the new key beside the signing secret it already held. */
const KEY_ROTATED_ENV = `PORT=8787\nSIREN_BASE_URL=${SANDBOX_BASE_URL}\nSIREN_API_KEY=${RAW_KEY_2}\nSIREN_SIGNING_SECRET=${SIGNING_SECRET}\n`;
const rotated = () => reply(200, { ...appRecord(), rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 });
const declared = () => reply(201, { ...appRecord(), rawKey: RAW_KEY_2, signingSecret: SIGNING_SECRET_2 });

beforeEach(() => {
  watch.key = '';
  watch.failWith = '';
  watch.marks = [];
});

describe.runIf(posix)('apps-cli internals: the env file', () => {
  it('never leaves the new key in a file wider than 0600, on rotate and on a first apply over a 0644 file', async () => {
    const rotate = harness([rotated()]);
    rotate.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(rotate.cwd, '.env.sandbox') } }) });
    rotate.write('.env.sandbox', OLD_ENV);
    chmodSync(join(rotate.cwd, '.env.sandbox'), 0o644);
    watch.key = RAW_KEY_2;
    expect(await rotate.run(['apps', 'rotate-key', APP_KEY, '--yes']), rotate.err()).toBe(0);
    expect(rotate.file('.env.sandbox')).toBe(KEY_ROTATED_ENV);
    expect(watch.marks.length).toBeGreaterThan(0);
    for (const mark of watch.marks) expect(mark.mode, mark.path).toBe(0o600);
    expect(rotate.modeOf(join(rotate.cwd, '.env.sandbox'))).toBe(0o600);

    watch.marks = [];
    const apply = harness([appMissing(), declared()], { env: appEnv });
    apply.signedIn();
    apply.write('siren.app.json', exampleFile);
    apply.write('.env.sandbox', 'PORT=8787\n');
    chmodSync(join(apply.cwd, '.env.sandbox'), 0o644);
    expect(await apply.run(['apps', 'apply', '--yes']), apply.err()).toBe(0);
    expect(apply.file('.env.sandbox')).toBe(NEW_ENV);
    expect(watch.marks.length).toBeGreaterThan(0);
    for (const mark of watch.marks) expect(mark.mode, mark.path).toBe(0o600);
  });

  it('names every file that ever holds the key so the ignore line apps init writes covers it', async () => {
    const init = harness([]);
    expect(await init.run(['apps', 'init', '--key', APP_KEY, '--name', 'Acme']), init.err()).toBe(0);
    const patterns = init
      .file('.gitignore')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => new RegExp(`^${line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`));

    const rotate = harness([rotated()]);
    rotate.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(rotate.cwd, '.env.sandbox') } }) });
    rotate.write('.env.sandbox', OLD_ENV);
    watch.key = RAW_KEY_2;
    expect(await rotate.run(['apps', 'rotate-key', APP_KEY, '--yes']), rotate.err()).toBe(0);
    const names = [...new Set(watch.marks.map((mark) => mark.path.slice(mark.path.lastIndexOf('/') + 1)))];
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(patterns.some((pattern) => pattern.test(name)), name).toBe(true);
  });

  it('refuses an env file that is a symbolic link or not a regular file, before anything is sent or written', async () => {
    const rotate = harness([rotated()]);
    rotate.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(rotate.cwd, '.env.sandbox') } }) });
    mkdirSync(join(rotate.cwd, 'elsewhere'));
    rotate.write('elsewhere/target.env', 'OTHER=1\n');
    symlinkSync(join(rotate.cwd, 'elsewhere', 'target.env'), join(rotate.cwd, '.env.sandbox'));
    expect(await rotate.run(['apps', 'rotate-key', APP_KEY, '--yes'])).toBe(1);
    expect(rotate.http.requests).toHaveLength(0);
    expect(rotate.err()).toMatch(/symbolic link/);
    expect(rotate.file('elsewhere/target.env')).toBe('OTHER=1\n');
    expect(lstatSync(join(rotate.cwd, '.env.sandbox')).isSymbolicLink()).toBe(true);

    const apply = harness([declared()], { env: appEnv });
    apply.signedIn();
    apply.write('siren.app.json', exampleFile);
    mkdirSync(join(apply.cwd, 'elsewhere'));
    apply.write('elsewhere/target.env', 'OTHER=1\n');
    symlinkSync(join(apply.cwd, 'elsewhere', 'target.env'), join(apply.cwd, '.env.sandbox'));
    expect(await apply.run(['apps', 'apply'])).toBe(1);
    expect(apply.http.requests).toHaveLength(0);
    expect(apply.err()).toMatch(/symbolic link/);
    expect(apply.file('elsewhere/target.env')).toBe('OTHER=1\n');

    const folder = harness([rotated()]);
    folder.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(folder.cwd, '.env.sandbox') } }) });
    mkdirSync(join(folder.cwd, '.env.sandbox'));
    expect(await folder.run(['apps', 'rotate-key', APP_KEY, '--yes'])).toBe(1);
    expect(folder.http.requests).toHaveLength(0);
    expect(folder.err()).toMatch(/not a regular file/);
  });

  it('leaves the old env file whole when a write no check foresaw fails, and says the pair is lost and how to get a new one, never printing it', async () => {
    const h = harness([rotated()]);
    h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(h.cwd, '.env.sandbox') } }) });
    h.write('.env.sandbox', OLD_ENV);
    chmodSync(join(h.cwd, '.env.sandbox'), 0o600);
    watch.failWith = RAW_KEY_2;
    expect(await h.run(['apps', 'rotate-key', APP_KEY, '--yes'])).toBe(1);
    expect(h.file('.env.sandbox')).toBe(OLD_ENV);
    expect(readdirSync(h.cwd).sort()).toEqual(['.env.sandbox']);
    expect(h.err()).toMatch(/Siren issued/);
    expect(h.err()).toMatch(/could not be saved/);
    expect(h.err()).toContain(`siren apps rotate-key ${APP_KEY}`);
    expect(h.err()).toMatch(/old key .*revoked/);
    expect(h.printed()).not.toContain(RAW_KEY_2);
    expect(h.printed()).not.toContain(SIGNING_SECRET_2);

    const apply = harness([appMissing(), declared()], { env: appEnv });
    apply.signedIn();
    apply.write('siren.app.json', exampleFile);
    expect(await apply.run(['apps', 'apply', '--yes'])).toBe(1);
    expect(apply.err()).toMatch(/Siren issued/);
    expect(apply.err()).toContain(`siren apps rotate-key ${APP_KEY} to issue a new key, and siren apps rotate-secret ${APP_KEY} to issue a new signing secret`);
    expect(apply.printed()).not.toContain(RAW_KEY_2);
    expect(apply.printed()).not.toContain(SIGNING_SECRET_2);
  });

  it('refuses before sending an env path whose folder is missing or cannot be written', async () => {
    const gone = harness([rotated()]);
    gone.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: join(gone.cwd, 'moved', '.env.sandbox') } }) });
    expect(await gone.run(['apps', 'rotate-key', APP_KEY, '--yes'])).toBe(1);
    expect(gone.http.requests).toHaveLength(0);
    expect(gone.err()).toMatch(/does not exist/);

    // A folder the test cannot write to, whoever runs it: /etc belongs to another user unless
    // the run is the machine's real root, and a user namespace's root gets no write to it either.
    if (statSync('/etc').uid !== process.getuid?.()) {
      const system = harness([rotated()]);
      system.signedIn();
      expect(await system.run(['apps', 'rotate-key', APP_KEY, '--yes', '--app-file', '/etc/passwd'])).toBe(1);
      expect(system.http.requests).toHaveLength(0);
      expect(system.err()).toMatch(/cannot write to \/etc/);
    }

    const shut = harness([declared()], { env: appEnv });
    shut.signedIn();
    mkdirSync(join(shut.cwd, 'shut'));
    shut.write('shut/siren.app.json', exampleFile);
    chmodSync(join(shut.cwd, 'shut'), 0o555);
    let writable = true;
    try {
      accessSync(join(shut.cwd, 'shut'), constants.W_OK);
    } catch {
      writable = false;
    }
    if (!writable) {
      expect(await shut.run(['apps', 'apply', 'shut/siren.app.json'])).toBe(1);
      expect(shut.http.requests).toHaveLength(0);
      expect(shut.err()).toMatch(/cannot write to/);
    }
    chmodSync(join(shut.cwd, 'shut'), 0o755);
  });
});
