import { ConnectionError, SirenError, UnexpectedResponseError, errorFromResponse } from '../errors';
import { HttpClientError } from '../http';
import type { HttpClient, HttpResponse } from '../http';
import type { CliIo } from './io';
import { CliRefusal, CliUsageError } from './targets';

/*
 * Signing a person in from a terminal, against Siren's session routes
 * (lib/Users/Service/Rest, base `/auth`, read at 20c47873d). These routes
 * take no API key. The dashboard uses the same ones, so the tokens are an
 * ordinary session: the access token lasts one hour (AuthService::TOKEN_TTL)
 * and the refresh token thirty days from its last use, since every refresh
 * answers a new pair (REFRESH_TOKEN_TTL, buildTokenResponse()).
 *
 * Internal to the command-line tool. The package does not export it.
 */

/** Which kind of Siren Cloud answered. `GET /auth/signup-options` names it from slice 7 on. */
export type Edition = 'sandbox' | 'production';

/** The person, as Siren's auth answers describe them (AuthService::userPayload()). */
export interface SessionUser {
  id: number;
  email: string;
  role?: string;
  status?: string;
}

/** A session for one person in one organization. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
  /**
   * Present when the address still waits for confirmation and Siren gave a
   * session anyway (AuthService::authenticate()). `signup` and `login` say
   * how many days are left.
   */
  emailConfirmation?: EmailConfirmationWindow;
}

/** One organization the person belongs to (AuthService::buildMembershipsList()). */
export interface Membership {
  orgId: number;
  orgName: string;
  orgSlug: string;
  role: string;
  orgLogoUrl?: string | null;
}

/**
 * What `POST /auth/login` answers with no `orgId`: a session when the person
 * belongs to one organization, or a five-minute verification token and the
 * list to choose from when they belong to several (AuthService::completeAuthentication()).
 */
export type LoginResult =
  | { kind: 'session'; tokens: SessionTokens; memberships: Membership[] }
  | { kind: 'choose-org'; verificationToken: string; memberships: Membership[] };

/**
 * A confirmation window on a new account (AuthService::windowPayload()).
 * Siren closes an account nobody confirmed when it ends
 * (saas/Users/UnconfirmedAccounts).
 */
export interface EmailConfirmationWindow {
  pending: true;
  /** Unix seconds. */
  deadline: number;
  daysUntilClosed?: number;
}

/** What `POST /auth/register-org` answers (OrgRegistrationService::register()). */
export interface RegisteredOrg {
  org: Membership;
  /**
   * Null when Siren answered `emailConfirmationRequired`: no session until
   * the person confirms the address in the email Siren sent and signs in.
   */
  tokens: SessionTokens | null;
  /** Present when Siren gave a session that still waits for the address to be confirmed. */
  emailConfirmation?: EmailConfirmationWindow;
}

/** What `signup` sends. Siren refuses a sign-up without `acceptTerms`. */
export interface RegisterOrgParams {
  orgName: string;
  email: string;
  password: string;
  acceptTerms: true;
}

/** The SDK's `User-Agent`, the one `HttpTransport` sends. */
const USER_AGENT = 'siren-sdk-typescript/0.3.0';

/** How long a session call may take, the SDK's default. */
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;

/** How many times a read is sent again after a network error, 429 or 5xx. */
const READ_RETRIES = 2;

/**
 * How long one edition read may take, in milliseconds. Every command waits
 * on it before it sends anything else, so it gets a short timeout of its own
 * and one retry: a target that never answers is given up after 3 seconds,
 * half a second, and 3 seconds more, 6.5 seconds in all. With the session
 * timeout and two retries it took 92 seconds.
 */
const EDITION_TIMEOUT_MS = 3000;

/** How many times the edition read is sent again after a network error, 429 or 5xx. */
const EDITION_RETRIES = 1;

/**
 * Fields of a session answer that hold a credential, in lower case with no
 * `_` or `-`. No error built from an answer carries their values.
 */
const TOKEN_FIELDS: ReadonlySet<string> = new Set(['accesstoken', 'refreshtoken', 'verificationtoken', 'confirmationtoken', 'password']);

/**
 * Siren's session routes, called through an `HttpClient` the way the
 * connect entry's `OAuthClient` calls the OAuth routes: one JSON request
 * per call to `{baseUrl}/auth/...`, the SDK's `Accept`, `Content-Type` and
 * `User-Agent`, never a redirect followed, and no error that carries a
 * password or a token.
 *
 * - `edition()` and `memberships()` are reads and retry on a network
 *   error, 429 or 5xx, up to twice. Every other call is sent once.
 * - A 2xx answer of the wrong shape raises `UnexpectedResponseError`, with
 *   the status and no copy of the body, since a body may hold a token.
 * - Any other status raises the error `errorFromResponse` builds, so a wrong
 *   password is `AuthenticationError` with Siren's own message. The body it
 *   reads has every token field replaced first.
 */
export class SessionAuthClient {
  constructor(private readonly options: { baseUrl: string; httpClient: HttpClient; timeout?: number }) {}

  /**
   * `GET /auth/signup-options`, and its `edition`. An answer with no
   * `edition`, from a Siren older than slice 7, counts as `production`, so
   * the tool treats an unknown Cloud as live. Each attempt may take
   * {@link EDITION_TIMEOUT_MS}, and it is sent again once, so a target that
   * hangs raises `ConnectionError` after 6.5 seconds.
   */
  async edition(): Promise<Edition> {
    const body = await this.send('GET', '/auth/signup-options', undefined, undefined, true, [], { timeout: EDITION_TIMEOUT_MS, retries: EDITION_RETRIES });
    if (!isObject(body)) throw unexpected('/auth/signup-options', 200);
    return body.edition === 'sandbox' ? 'sandbox' : 'production';
  }

  /**
   * `POST /auth/register-org`. Sent once: a second send would make a second
   * org or answer 409. A 404 means sign-up is turned off on that Siren
   * (`SIREN_SAAS_SIGNUP_ENABLED`), and the command says so.
   */
  async registerOrg(params: RegisterOrgParams): Promise<RegisteredOrg> {
    const body = await this.send('POST', '/auth/register-org', { ...params }, undefined, false, [params.password]);
    const org = isObject(body) ? asMembership(body.org) : null;
    if (!isObject(body) || org === null) throw unexpected('/auth/register-org', 201);
    if (body.emailConfirmationRequired === true) return { org, tokens: null };
    const tokens = asTokens(body, '/auth/register-org');
    const window = tokens.emailConfirmation;
    return window === undefined ? { org, tokens } : { org, tokens, emailConfirmation: window };
  }

  /**
   * `POST /auth/login` with `email` and `password`, and `orgId` when given.
   * Siren answers 403 `email_unconfirmed` for an address not yet confirmed,
   * and 401 with `no_entitlement`, `entitlement_lapsed`, `trial_ended` or
   * `entitlements_unavailable` for an organization with no usable plan
   * (lib/Users/Service/Rest/Login.php). The command turns each into one line
   * that says what to do next.
   */
  async login(email: string, password: string, orgId?: number): Promise<LoginResult> {
    const sent: Record<string, unknown> = { email, password };
    if (orgId !== undefined) sent.orgId = orgId;
    const body = await this.send('POST', '/auth/login', sent, undefined, false, [password]);
    if (!isObject(body)) throw unexpected('/auth/login', 200);
    const memberships = asMemberships(body.memberships);
    if (memberships === null) throw unexpected('/auth/login', 200);
    if (typeof body.verificationToken === 'string' && body.verificationToken !== '' && body.accessToken === undefined) {
      return { kind: 'choose-org', verificationToken: body.verificationToken, memberships };
    }
    return { kind: 'session', tokens: asTokens(body, '/auth/login'), memberships };
  }

  /** `POST /auth/select-org`, the second step for a person in several organizations. */
  async selectOrg(verificationToken: string, orgId: number): Promise<SessionTokens> {
    const body = await this.send('POST', '/auth/select-org', { verificationToken, orgId }, undefined, false, [verificationToken]);
    return asTokens(body, '/auth/select-org');
  }

  /** `POST /auth/refresh`. Siren answers a new pair, and the old refresh token is spent. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const body = await this.send('POST', '/auth/refresh', { refreshToken }, undefined, false, [refreshToken]);
    return asTokens(body, '/auth/refresh');
  }

  /** `GET /auth/memberships` with the access token as the bearer. */
  async memberships(accessToken: string): Promise<Membership[]> {
    const body = await this.send('GET', '/auth/memberships', undefined, accessToken, true);
    const memberships = isObject(body) ? asMemberships(body.memberships) : null;
    if (memberships === null) throw unexpected('/auth/memberships', 200);
    return memberships;
  }

  /** `POST /auth/switch-org` with the access token as the bearer: a new session in another organization. */
  async switchOrg(accessToken: string, orgId: number): Promise<SessionTokens> {
    return asTokens(await this.send('POST', '/auth/switch-org', { orgId }, accessToken), '/auth/switch-org');
  }

  /**
   * `POST /auth/logout` with the access token as the bearer and the refresh
   * token in the body, so Siren revokes both. Siren answers 200 with a
   * message, and the body is not read.
   */
  async logout(accessToken: string, refreshToken: string): Promise<void> {
    await this.send('POST', '/auth/logout', { refreshToken }, accessToken, false, [refreshToken]);
  }

  /**
   * Sends one JSON request to `{baseUrl}{path}` and answers the parsed 2xx
   * body. `read` lets a network error, 429 or 5xx send it again, up to
   * {@link READ_RETRIES} times, or `limits.retries`. `limits.timeout` takes
   * the place of the session timeout for each attempt. `secrets` are the
   * values this call sent that no error may show. The bearer is always one of
   * them.
   */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    bearer?: string,
    read = false,
    secrets: readonly string[] = [],
    limits: { timeout?: number; retries?: number } = {},
  ): Promise<unknown> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
    const hidden = bearer === undefined ? [...secrets] : [...secrets, bearer];
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = limits.timeout ?? this.options.timeout ?? DEFAULT_SESSION_TIMEOUT_MS;
    const retries = limits.retries ?? READ_RETRIES;

    for (let attempt = 0; ; attempt += 1) {
      const retry = read && attempt < retries;
      let reply: HttpResponse;
      try {
        reply = await this.options.httpClient.send({
          method,
          url,
          headers: { ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          timeout,
        });
      } catch (error) {
        if (!(error instanceof HttpClientError)) throw error;
        if (retry) {
          await pause(attempt);
          continue;
        }
        throw new ConnectionError(`Siren: ${method} ${url} failed: ${redact(error.message, hidden)}`);
      }

      const status = reply.status;
      if (status >= 200 && status < 300) return parseJson(reply.body);
      if (retry && (status === 429 || status >= 500)) {
        await pause(attempt);
        continue;
      }
      if (status >= 300 && status < 400) {
        throw new SirenError(`Siren: ${method} ${path} answered a redirect (${status}), which the tool never follows.`, { statusCode: status });
      }
      throw errorFromResponse(status, redact(reply.statusText ?? '', hidden), scrub(parseJson(reply.body), hidden), headerOf(reply, 'retry-after'));
    }
  }
}

/** Waits before a read is sent again: half a second, then a second. */
function pause(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
}

/** A 2xx answer of the wrong shape, with no copy of the body. */
function unexpected(path: string, status: number): UnexpectedResponseError {
  return new UnexpectedResponseError(`Siren answered ${path} with a body the tool cannot read.`, { statusCode: status });
}

/** A JSON object, not an array or `null`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string. */
function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** One membership as `buildMembershipsList()` gives it, or null. */
function asMembership(value: unknown): Membership | null {
  if (!isObject(value)) return null;
  const { orgId, orgName, orgSlug, role } = value;
  if (typeof orgId !== 'number' || !Number.isSafeInteger(orgId) || typeof orgName !== 'string' || typeof orgSlug !== 'string' || typeof role !== 'string') {
    return null;
  }
  const membership: Membership = { orgId, orgName, orgSlug, role };
  if (typeof value.orgLogoUrl === 'string' || value.orgLogoUrl === null) membership.orgLogoUrl = value.orgLogoUrl;
  return membership;
}

/** A list of memberships, or null when it is not one. */
function asMemberships(value: unknown): Membership[] | null {
  if (!Array.isArray(value)) return null;
  const memberships = value.map(asMembership);
  return memberships.every((membership): membership is Membership => membership !== null) ? memberships : null;
}

/** The session in an answer that `buildTokenResponse()` built, or `UnexpectedResponseError`. */
function asTokens(body: unknown, path: string): SessionTokens {
  if (!isObject(body) || !isFilled(body.accessToken) || !isFilled(body.refreshToken) || !isObject(body.user)) {
    throw unexpected(path, 200);
  }
  const { id, email, role, status } = body.user;
  if (typeof id !== 'number' || typeof email !== 'string') throw unexpected(path, 200);
  const user: SessionUser = { id, email };
  if (typeof role === 'string') user.role = role;
  if (typeof status === 'string') user.status = status;
  const tokens: SessionTokens = { accessToken: body.accessToken, refreshToken: body.refreshToken, user };
  const window = body.emailConfirmation;
  if (isObject(window) && window.pending === true && typeof window.deadline === 'number') {
    tokens.emailConfirmation = { pending: true, deadline: window.deadline };
    if (typeof window.daysUntilClosed === 'number') tokens.emailConfirmation.daysUntilClosed = window.daysUntilClosed;
  }
  return tokens;
}

/** The parsed body, or `undefined` when it is empty or not JSON. */
function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A reply header, looked up in any case. */
function headerOf(reply: HttpResponse, name: string): string | null {
  const found = Object.entries(reply.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : null;
}

/** Replaces every secret in `text`, longest first. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter(isFilled).sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]');
  return out;
}

/** A copy of a parsed answer with every secret and every token field replaced, for an error to carry. */
function scrub(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= 32) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: TOKEN_FIELDS.has(key.toLowerCase().replace(/[_-]/g, '')) ? '[redacted]' : scrub(item, secrets, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * How `siren login` proves who the person is. The first step has one,
 * {@link PasswordSignIn}. Device sign-in (slice 9) adds a second that shows
 * a code to approve in a browser and ends with the same {@link LoginResult},
 * so nothing after sign-in changes.
 */
export interface SignInMethod {
  signIn(auth: SessionAuthClient, io: CliIo, request: { email?: string; passwordFromStdin: boolean; orgId?: number }): Promise<LoginResult>;
}

/**
 * Email and password. The password comes from a hidden prompt, or from
 * standard input with `--password-stdin`, and is never a flag, because a
 * flag lands in the shell's history and the process list. It is sent once
 * to `POST /auth/login` and kept nowhere.
 *
 * Asks for the email at a prompt when `request.email` is absent. Throws
 * `CliUsageError` when it would need a prompt and `io.interactive` is false,
 * and `CliRefusal` for an empty email or password, before sending.
 */
export class PasswordSignIn implements SignInMethod {
  async signIn(auth: SessionAuthClient, io: CliIo, request: { email?: string; passwordFromStdin: boolean; orgId?: number }): Promise<LoginResult> {
    const email = request.email ?? (await askLine(io, 'Email: ', '--email'));
    const password = await readPassword(io, request.passwordFromStdin);
    if (email.trim() === '') throw new CliRefusal('Siren needs an email address to sign in.');
    return auth.login(email.trim(), password, request.orgId);
  }
}

/** A line typed at a prompt, or `CliUsageError` naming `flag` when no person can answer one. */
export async function askLine(io: CliIo, question: string, flag: string): Promise<string> {
  if (!io.interactive) throw new CliUsageError(`Pass ${flag}, since there is no terminal to ask in.`);
  return (await io.prompt(question)).trim();
}

/**
 * The password: all of standard input with one line break at its end taken
 * off for `--password-stdin`, else typed at a hidden prompt. Refuses an
 * empty one. The value is never printed.
 */
export async function readPassword(io: CliIo, fromStdin: boolean): Promise<string> {
  let password: string;
  if (fromStdin) password = (await io.readStdin()).replace(/\r?\n$/, '');
  else if (io.interactive) password = await io.promptSecret('Password: ');
  else throw new CliUsageError('Pass --password-stdin and send the password on standard input, since there is no terminal to ask in.');
  if (password === '') throw new CliRefusal('Siren needs a password, and none was given.');
  return password;
}
