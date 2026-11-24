import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../src/cli/io';
import { runCli } from '../src/cli/run';
import type { StoredSession } from '../src/cli/credentials';
import { SANDBOX_BASE_URL } from '../src/http';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http';
import { FakeHttpClient, reply } from './http-fakes';

/*
 * A terminal for `runCli` with no network, no real home folder and a fixed
 * clock. Each harness gets its own temporary folder, which holds the
 * working folder and the config folder.
 */

/** The fixed clock, the signed time of Siren's request fixture, in milliseconds. */
export const NOW_MS = 1794913200 * 1000;
export const NOW_S = NOW_MS / 1000;

export const EMAIL = 'dev@acme.example';
export const PASSWORD = 'correct horse battery staple';

/** An access token as Siren makes one: a JWT whose claims the tool reads for `exp`. The signature is not checked. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ typ: 'JWT', alg: 'HS256' })}.${part(claims)}.c2lnbmF0dXJl`;
}

export const ACCESS_1 = jwt({ type: 'access', userId: 7, orgId: 3, role: 'admin', exp: NOW_S + 3600 });
export const ACCESS_2 = jwt({ type: 'access', userId: 7, orgId: 4, role: 'admin', exp: NOW_S + 3600 });
export const REFRESH_1 = 'refresh-token-one';
export const REFRESH_2 = 'refresh-token-two';

export const membershipAcme = { orgId: 3, orgName: 'Acme', orgSlug: 'acme', orgLogoUrl: null, role: 'admin' };
export const membershipTwo = { orgId: 4, orgName: 'Acme Two', orgSlug: 'acme-two', orgLogoUrl: null, role: 'admin' };
export const user = { id: 7, email: EMAIL, role: 'admin', status: 'active' };

/** Siren's answers on its session routes (lib/Users/Service/Rest, AuthService), read at 20c47873d. */
export const AuthAnswers = {
  sandbox: () => reply(200, { shortSignup: false, edition: 'sandbox' }),
  production: () => reply(200, { shortSignup: false, edition: 'production' }),
  /** A Siren from before slice 7, whose signup-options names no edition. */
  noEdition: () => reply(200, { shortSignup: false }),
  /**
   * register-org: the organization carries no `orgLogoUrl`, unlike a
   * membership (capture auth-register-org-201).
   */
  registered: () =>
    reply(201, { org: { orgId: 3, orgName: 'Acme', orgSlug: 'acme', role: 'admin' }, user, accessToken: ACCESS_1, refreshToken: REFRESH_1 }),
  oneOrg: () => reply(200, { accessToken: ACCESS_1, refreshToken: REFRESH_1, user, memberships: [membershipAcme] }),
  severalOrgs: () =>
    reply(200, { verificationToken: 'verification-token', user: { id: 7, email: EMAIL }, memberships: [membershipAcme, membershipTwo] }),
  tokens: (accessToken = ACCESS_2, refreshToken = REFRESH_2) => reply(200, { accessToken, refreshToken, user }),
  /**
   * A wrong password: Login.php line 193 answers `setError(self::NO_MATCH, 401)`,
   * a bare string (saas/Http/Response.php line 112), with NO_MATCH from
   * Login.php line 51, on `feat/apps` at 1557b0030.
   */
  wrongPassword: () =>
    reply(401, { error: "Invalid email or password. If you haven't set up your login yet, check your email for a link to set it up." }),
  /**
   * A spent or unknown refresh token: AuthService::refreshToken() throws
   * InvalidCredentialsException('Invalid refresh token.') (AuthService.php
   * line 1173) and RefreshToken.php line 84 answers it with setError(), a
   * bare string (saas/Http/Response.php line 112), read on pkt/apps-exchange
   * at 651704b75.
   */
  refreshRefused: () => reply(401, { error: 'Invalid refresh token.' }),
  /**
   * The plan check could not reach the entitlement service: AuthService.php
   * lines 416 to 419 throw this message and code, and RefreshToken.php lines
   * 75 to 82 answer it with 503, since the refresh token stays good.
   */
  refreshUnavailable: () =>
    reply(503, { error: { message: 'Account service is unavailable. Please try again shortly.', code: 'entitlements_unavailable' } }),
  memberships: () => reply(200, { memberships: [membershipAcme, membershipTwo] }),
  /** lib/Users/Service/Rest/Logout.php line 121, on pkt/apps-exchange at 651704b75. */
  loggedOut: () => reply(200, { message: 'Logged out successfully.' }),
};

export function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    edition: 'sandbox',
    email: EMAIL,
    userId: 7,
    orgId: 3,
    orgName: 'Acme',
    role: 'admin',
    accessToken: ACCESS_1,
    refreshToken: REFRESH_1,
    accessExpiresAt: NOW_S + 3600,
    ...overrides,
  };
}

/** What the harness answers on `GET /auth/signup-options`. */
export type EditionAnswer = 'sandbox' | 'production' | 'none' | HttpResponse | Error;

export interface HarnessOptions {
  /**
   * What the target's `GET /auth/signup-options` answers, which every command
   * that sends anything reads first: `sandbox` (the default), `production`,
   * `none` for a Siren that names no edition, or any reply or error. The
   * harness answers that route itself, apart from the queued replies. A
   * function is asked at each read, with the number of the read from 1, so
   * a test can change the edition during a run.
   */
  edition?: EditionAnswer | ((read: number) => EditionAnswer);
  env?: Record<string, string>;
  interactive?: boolean;
  /** Lines typed at each `prompt`, in order. */
  typed?: string[];
  /** Lines typed at each `promptSecret`, in order. */
  secrets?: string[];
  stdin?: string;
  /** Called on each `sleep`, with the number of the call, from 1. */
  onSleep?: (count: number, abort: () => void) => void;
  /** What opening the browser answers: true when it opened. Defaults to true. */
  opens?: boolean;
}

export function harness(replies: Array<HttpResponse | Error>, options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'siren-cli-'));
  const cwd = join(root, 'work');
  const configDir = join(root, 'config');
  mkdirSync(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const secretPrompts: string[] = [];
  const typed = [...(options.typed ?? [])];
  const secrets = [...(options.secrets ?? [])];
  const http = new FakeHttpClient(replies);
  const controller = new AbortController();
  let sleeps = 0;
  const slept: number[] = [];
  const opened: string[] = [];
  const editionReads: HttpRequest[] = [];
  const sent: string[] = [];
  const editionOption = options.edition ?? 'sandbox';
  const editionAnswer = (): HttpResponse | Error => {
    const edition = typeof editionOption === 'function' ? editionOption(editionReads.length) : editionOption;
    return edition === 'sandbox' ? AuthAnswers.sandbox() : edition === 'production' ? AuthAnswers.production() : edition === 'none' ? AuthAnswers.noEdition() : edition;
  };
  const pathOf = (request: HttpRequest) => `${request.method} ${new URL(request.url).pathname.replace(/^\/siren\/v1/, '')}`;
  // The edition read goes to its own list, so `http.requests` and `paths()` hold what the command itself sent.
  const client: HttpClient = {
    send: async (request) => {
      sent.push(pathOf(request));
      if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/auth/signup-options')) {
        editionReads.push(request);
        const answer = editionAnswer();
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return http.send(request);
    },
  };

  const io: CliIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    interactive: options.interactive ?? false,
    prompt: async (question) => {
      prompts.push(question);
      return typed.shift() ?? '';
    },
    promptSecret: async (question) => {
      secretPrompts.push(question);
      return secrets.shift() ?? '';
    },
    readStdin: async () => options.stdin ?? '',
    env: options.env ?? {},
    cwd,
    configDir,
    httpClient: client,
    now: () => NOW_MS,
    sleep: async (ms) => {
      sleeps += 1;
      slept.push(ms);
      options.onSleep?.(sleeps, () => controller.abort());
    },
    signal: controller.signal,
    machine: 'test-laptop',
    openUrl: async (url) => {
      opened.push(url);
      return options.opens ?? true;
    },
  };

  const credentialsPath = join(configDir, 'credentials.json');

  return {
    io,
    http,
    cwd,
    configDir,
    credentialsPath,
    prompts,
    secretPrompts,
    out: () => out.join(''),
    err: () => err.join(''),
    /** Everything the tool printed, both streams. */
    printed: () => out.join('') + err.join(''),
    run: (argv: string[]) => runCli(argv, io),
    /** Writes `credentials.json` as a sign-in would, mode 0600. */
    signedIn(sessions: Record<string, StoredSession> = { [SANDBOX_BASE_URL]: session() }) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(credentialsPath, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
      chmodSync(credentialsPath, 0o600);
    },
    credentials(): { version: number; current?: string; sessions: Record<string, StoredSession> } {
      return JSON.parse(readFileSync(credentialsPath, 'utf8')) as { version: number; current?: string; sessions: Record<string, StoredSession> };
    },
    credentialsText: () => readFileSync(credentialsPath, 'utf8'),
    modeOf: (path: string) => statSync(path).mode & 0o777,
    file: (name: string) => readFileSync(join(cwd, name), 'utf8'),
    write: (name: string, text: string) => writeFileSync(join(cwd, name), text),
    /** What the command sent, the edition read left out. */
    paths: () => http.requests.map(pathOf),
    /** Each `GET /auth/signup-options` the command sent. */
    editionReads,
    /** Every request in the order sent, the edition read included. */
    sent: () => [...sent],
    /** Each wait, in milliseconds. */
    slept,
    /** Each address the tool opened in the browser. */
    opened,
  };
}
