import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturedBody } from './cloud-captures';
import { renamedBody } from './cli-renamed-captures';
import { jwt } from './cli-fakes';

/*
 * A fake Siren Cloud on 127.0.0.1, for tests that run the built `siren`
 * command as a child process: the hidden password prompt in a
 * pseudo-terminal, and the edition check across two commands. Its answers
 * are the captures in test/fixtures/cloud-captures, with made-up tokens.
 * It sends nothing off this machine and stops with `close()`.
 */

export const root = join(__dirname, '..');

/**
 * Builds src/cli/index.ts with tsup, as the package build does, into a new
 * temporary folder, and answers the built file's path. A test builds from
 * the source in front of it, so a change to src/cli shows without
 * `npm run build`, and a mutation run tests the mutated code.
 */
export function buildCli(): string {
  const out = mkdtempSync(join(tmpdir(), 'siren-cli-built-'));
  execFileSync(
    join(root, 'node_modules', '.bin', 'tsup'),
    ['src/cli/index.ts', '--no-config', '--format', 'esm', '--out-dir', out, '--target', 'node18', '--platform', 'node', '--silent'],
    { cwd: root, stdio: 'ignore' },
  );
  // The package's own package.json says "type": "module", which makes Node
  // load dist/cli.js as ESM. A temporary folder has no such file, and Node
  // before 20.19 and 22.7 does not detect ESM syntax on its own, so it would
  // load index.js as CommonJS and stop at the first import.
  writeFileSync(join(out, 'package.json'), '{ "type": "module" }\n');
  return join(out, 'index.js');
}

/** One request the fake Cloud saw. */
export interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeCloud {
  /** `http://127.0.0.1:<port>/siren/v1`. */
  baseUrl: string;
  /** What `GET /auth/signup-options` reports. A test may change it between two commands. */
  edition: 'sandbox' | 'production';
  /** When true, `GET /auth/signup-options` gets no answer at all, as a target that hangs. */
  hangEdition: boolean;
  seen: SeenRequest[];
  close(): Promise<void>;
}

/** The access token the fake Cloud gives, valid for an hour from now on the real clock. */
export function loopbackAccessToken(): string {
  return jwt({ type: 'access', userId: 1, orgId: 1, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
}

/** Starts the fake Cloud on a free port of 127.0.0.1. */
export async function startFakeCloud(edition: 'sandbox' | 'production' = 'sandbox'): Promise<FakeCloud> {
  const seen: SeenRequest[] = [];
  const state = { edition, hangEdition: false };
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]!.replace(/^\/siren\/v1/, '');
    seen.push({ method: request.method ?? '', path, authorization: request.headers.authorization });
    request.resume();
    request.on('end', () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const route = `${request.method} ${path}`;
      if (route === 'GET /auth/signup-options' && state.hangEdition) return undefined;
      if (route === 'GET /auth/signup-options') return send(200, capturedBody(`auth-signup-options-${state.edition === 'production' ? 'production' : 'sandbox'}`));
      if (route === 'POST /auth/login') {
        return send(200, capturedBody('auth-login-200', { '<ACCESSTOKEN>': loopbackAccessToken(), '<REFRESHTOKEN>': 'made-up-refresh-token' }));
      }
      if (route === 'GET /apps') return send(200, renamedBody('apps-list-200'));
      if (route === 'GET /apps/requests') return send(200, capturedBody('apps-requests-list-empty'));
      if (route === 'POST /auth/logout') return send(200, capturedBody('auth-logout-200'));
      return send(404, { error: 'Not found.' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/siren/v1`,
    get edition() {
      return state.edition;
    },
    set edition(value) {
      state.edition = value;
    },
    get hangEdition() {
      return state.hangEdition;
    },
    set hangEdition(value) {
      state.hangEdition = value;
    },
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A new, empty config folder for the child's credentials.json. */
export function configFolder(): string {
  return mkdtempSync(join(tmpdir(), 'siren-cli-loopback-'));
}

/**
 * Runs the built `siren` with these arguments, a config folder and standard
 * input, without blocking the event loop, so the fake Cloud in this process
 * can answer it.
 */
export function runBuilt(
  cli: string,
  args: readonly string[],
  configDir: string,
  stdin = '',
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SIREN_CONFIG_DIR: configDir };
    delete env.SIREN_BASE_URL;
    const child = execFile(process.execPath, [cli, ...args], { env, timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ status, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}
