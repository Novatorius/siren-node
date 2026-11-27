import { ConnectionError, RateLimitError, SirenError, UnexpectedResponseError, errorFromResponse } from '../errors';
import { HttpClientError } from '../http';
import type { HttpClient, HttpResponse } from '../http';
import type { CliIo } from './io';
import { clean } from './style';
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

/** How the tool settled a Siren's edition: by its address, by what it reported, or as a sandbox because it reported none. */
export type EditionSource = 'host' | 'reported' | 'unreported';

/** Siren Cloud's sandbox and live API hosts, which are what they are by their address when they name no edition. */
const KNOWN_HOSTS: Readonly<Record<string, Edition>> = {
  'sandbox.sirenaffiliates.com': 'sandbox',
  'api.sirenaffiliates.com': 'production',
};

/**
 * The edition the tool acts on for `baseUrl`, and how it was settled (CLI
 * review round 1, C1). A Siren that names its edition is what it names.
 * Siren Cloud's own sandbox host is a sandbox and its live host is live by
 * their address, since both answer with no edition today. Any other Siren
 * that names none is never assumed live: the tool treats it as a sandbox
 * and says so in one line. Before this, the sandbox host itself was refused
 * as live.
 */
export function editionOf(baseUrl: string, reported: Edition | undefined): { edition: Edition; source: EditionSource } {
  if (reported !== undefined) return { edition: reported, source: 'reported' };
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = '';
  }
  const known = KNOWN_HOSTS[host];
  if (known !== undefined) return { edition: known, source: 'host' };
  return { edition: 'sandbox', source: 'unreported' };
}

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

/** What `POST /auth/cli/code` answers, in the tool's names. */
export interface DeviceCode {
  /** The secret the tool polls with. Never printed. */
  deviceCode: string;
  /** The short code the person checks on the page, such as `BCDF-GHJK`. */
  userCode: string;
  /** The dashboard's approval page with the code filled in. */
  page: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** What `GET /personal-tokens/current` answers about the token in use. */
export interface PersonalToken {
  id: number;
  name: string;
  lastFour: string;
  /** ISO 8601, or null when Siren gave none. */
  expiresAt: string | null;
  user: { id: number; email: string; role: string };
  org: Membership;
}

/** What `signup` sends. Siren refuses a sign-up without `acceptTerms`. */
export interface RegisterOrgParams {
  orgName: string;
  email: string;
  password: string;
  acceptTerms: true;
}

/** The SDK's `User-Agent`, the one `HttpTransport` sends. */
const USER_AGENT = 'siren-sdk-typescript/0.4.0';

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
const TOKEN_FIELDS: ReadonlySet<string> = new Set(['accesstoken', 'refreshtoken', 'verificationtoken', 'confirmationtoken', 'password', 'devicecode', 'token']);

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

  /** The Siren this client calls, such as `https://sandbox.sirenaffiliates.com/siren/v1`. */
  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * `GET /auth/signup-options`, and the edition it names, or undefined when
   * it names none, as a Siren older than slice 7 does. Siren Cloud's own
   * sandbox and live hosts answer with no edition today, so
   * {@link editionOf} settles those by their address. Each attempt may take
   * {@link EDITION_TIMEOUT_MS}, and it is sent again once, so a target that
   * hangs raises `ConnectionError` after 6.5 seconds.
   */
  async edition(): Promise<Edition | undefined> {
    const body = await this.send('GET', '/auth/signup-options', undefined, undefined, true, [], { timeout: EDITION_TIMEOUT_MS, retries: EDITION_RETRIES });
    if (!isObject(body)) throw unexpected('/auth/signup-options', 200);
    return body.edition === 'sandbox' || body.edition === 'production' ? body.edition : undefined;
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

  /**
   * `POST /auth/cli/code`: a code for the browser sign-in (contract/cli-signin.md,
   * section 1). Sent once. Refuses an answer whose page is not an http or
   * https address, or whose code holds anything but letters, digits and
   * dashes, since the tool prints both and may open the page.
   */
  async cliCode(machine: string): Promise<DeviceCode> {
    const body = await this.send('POST', '/auth/cli/code', { machine });
    if (!isObject(body)) throw unexpected('/auth/cli/code', 200);
    const { device_code: deviceCode, user_code: userCode, verification_uri_complete: page, expires_in: expiresIn, interval } = body;
    if (
      !isFilled(deviceCode) ||
      typeof userCode !== 'string' ||
      !/^[A-Za-z0-9-]{1,32}$/.test(userCode) ||
      typeof page !== 'string' ||
      !isWebAddress(page) ||
      typeof expiresIn !== 'number' ||
      typeof interval !== 'number'
    ) {
      throw unexpected('/auth/cli/code', 200);
    }
    // The parsed form, which percent-encodes any character that could move the cursor when printed.
    return { deviceCode, userCode, page: new URL(page).href, expiresInSeconds: expiresIn, intervalSeconds: interval };
  }

  /**
   * `POST /auth/cli/token`: one poll. Answers the session once the person
   * approved, the same shape `POST /auth/login` answers with an `orgId`.
   * Siren's 400 answers (`authorization_pending`, `slow_down`,
   * `access_denied`, `expired_token`, `invalid_grant`) raise the error
   * `errorFromResponse` builds, with the code on `error.code` and
   * `context.interval` on `error.data`. The device code never appears in an
   * error.
   */
  async cliToken(deviceCode: string): Promise<LoginResult> {
    const body = await this.send('POST', '/auth/cli/token', { device_code: deviceCode }, undefined, false, [deviceCode]);
    const memberships = isObject(body) ? asMemberships(body.memberships) : null;
    if (memberships === null) throw unexpected('/auth/cli/token', 200);
    return { kind: 'session', tokens: asTokens(body, '/auth/cli/token'), memberships };
  }

  /** `GET /personal-tokens/current` with a personal access token as the bearer: the token describes itself. A read, so it retries. */
  async personalToken(token: string): Promise<PersonalToken> {
    const body = await this.send('GET', '/personal-tokens/current', undefined, token, true);
    const person = isObject(body) ? body.user : undefined;
    const org = isObject(body) ? body.organization : undefined;
    if (
      !isObject(body) ||
      typeof body.id !== 'number' ||
      typeof body.name !== 'string' ||
      typeof body.lastFour !== 'string' ||
      !isObject(person) ||
      typeof person.id !== 'number' ||
      typeof person.email !== 'string' ||
      !isObject(org) ||
      typeof org.orgId !== 'number' ||
      typeof org.orgName !== 'string'
    ) {
      throw unexpected('/personal-tokens/current', 200);
    }
    return {
      id: body.id,
      name: clean(body.name),
      lastFour: clean(body.lastFour),
      expiresAt: typeof body.expiresAt === 'string' ? clean(body.expiresAt) : null,
      user: { id: person.id, email: clean(person.email), role: typeof person.role === 'string' ? clean(person.role) : '' },
      org: {
        orgId: org.orgId,
        orgName: clean(org.orgName),
        orgSlug: typeof org.orgSlug === 'string' ? clean(org.orgSlug) : '',
        role: typeof person.role === 'string' ? clean(person.role) : '',
      },
    };
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

/** An absolute http or https address. */
function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
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
  // Siren's text reaches the terminal and credentials.json, so no escape or control character is kept.
  const membership: Membership = { orgId, orgName: clean(orgName), orgSlug: clean(orgSlug), role: clean(role) };
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
  const user: SessionUser = { id, email: clean(email) };
  if (typeof role === 'string') user.role = clean(role);
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
 * How `siren login` proves who the person is: {@link DeviceSignIn}, a code
 * approved in the browser, by default in a terminal, or
 * {@link PasswordSignIn} with `--password` or `--password-stdin`. Both end
 * with the same {@link LoginResult}, so nothing after sign-in changes.
 */
export interface SignInMethod {
  signIn(auth: SessionAuthClient, io: CliIo, request: { email?: string; passwordFromStdin: boolean; orgId?: number }): Promise<LoginResult>;
}

/** Where the password login asks its questions: the terminal's prompts, or the logo screen's. */
export interface LinePrompts {
  prompt(question: string): Promise<string>;
  promptSecret(question: string): Promise<string>;
}

/** What the password login shows while it asks and while Siren checks the password. */
export interface PasswordSignInView extends LinePrompts {
  /** Shows that the login is on its way while `work` runs, and answers what it answers. */
  during<T>(work: Promise<T>): Promise<T>;
}

/**
 * Email and password. The password comes from a hidden prompt, or from
 * standard input with `--password-stdin`, and is never a flag, because a
 * flag lands in the shell's history and the process list. It is sent once
 * to `POST /auth/login` and kept nowhere.
 *
 * Asks for the email at a prompt when `request.email` is absent, at the
 * view's prompts when there is a view, else at the terminal's. Throws
 * `CliUsageError` when it would need a prompt and `io.interactive` is false,
 * and `CliRefusal` for an empty email or password, before sending.
 */
export class PasswordSignIn implements SignInMethod {
  constructor(private readonly view?: PasswordSignInView) {}

  async signIn(auth: SessionAuthClient, io: CliIo, request: { email?: string; passwordFromStdin: boolean; orgId?: number }): Promise<LoginResult> {
    const email = request.email ?? (await askLine(io, 'Email: ', '--email', this.view));
    const password = await readPassword(io, request.passwordFromStdin, this.view);
    if (email.trim() === '') throw new CliRefusal('No email given.', { why: 'Siren needs an email address to log you in.', fix: 'siren login --password --email you@example.com' });
    const login = auth.login(email.trim(), password, request.orgId);
    return this.view === undefined ? login : this.view.during(login);
  }
}

/** A line typed at a prompt, or `CliUsageError` naming `flag` when no person can answer one. */
export async function askLine(io: CliIo, question: string, flag: string, prompts: LinePrompts = io): Promise<string> {
  if (!io.interactive) throw new CliUsageError(`Pass ${flag}, since there is no terminal to ask in.`);
  return (await prompts.prompt(question)).trim();
}

/**
 * The password: all of standard input with one line break at its end taken
 * off for `--password-stdin`, else typed at a hidden prompt. Refuses an
 * empty one. The value is never printed.
 */
export async function readPassword(io: CliIo, fromStdin: boolean, prompts: LinePrompts = io): Promise<string> {
  let password: string;
  if (fromStdin) password = (await io.readStdin()).replace(/\r?\n$/, '');
  else if (io.interactive) password = await prompts.promptSecret('Password: ');
  else throw new CliUsageError('Pass --password-stdin and send the password on standard input, since there is no terminal to ask in.');
  if (password === '') {
    throw new CliRefusal('No password given.', {
      why: fromStdin ? '--password-stdin read an empty line, so nothing was sent.' : 'The password was empty, so nothing was sent.',
      fixText: fromStdin ? 'Send the password on standard input, as in: echo "$PASSWORD" | siren login --password-stdin' : 'Run siren login --password again and type it.',
    });
  }
  return password;
}

/** The longest wait between two polls, whatever interval Siren names, in seconds. */
const MAX_POLL_SECONDS = 60;

/**
 * A code the person approves in the browser (RFC 8628, contract/cli-signin.md
 * section 1). Asks Siren for a code with this machine's name, prints the
 * short code and the approval page, opens the page when it can, then polls
 * at the interval Siren sets until the person approves or denies, or the
 * code expires. The device code is never printed.
 *
 * - `authorization_pending` waits `context.interval` seconds, and
 *   `slow_down` waits the longer interval Siren names.
 * - A network fault, a 5xx or a 429 waits and polls again, until the code's
 *   life runs out, since the person may still be approving.
 * - `access_denied`, `expired_token` and `invalid_grant` stop with one line.
 * - Ctrl-C during a wait stops it, and nothing is kept.
 */
/** What the device login shows while it waits: the code and the link, then the wait, then how it ended. */
export interface DeviceSignInView {
  /** True once the person pressed Ctrl-C, which wins over an approval that lands at the same moment. */
  stopped?(): boolean;
  /** Shows the code and the page, whether the browser opened it, and the host of the Siren the tool polls. */
  show(code: DeviceCode, opened: boolean, siren: string): void;
  /** Waits `ms` before the next poll. */
  wait(ms: number): Promise<void>;
  /** The wait ended with no session. The tool prints why next. */
  failed(): Promise<void>;
}

/** Plain lines on standard error, for a caller with no view of its own. */
function plainView(io: CliIo): DeviceSignInView {
  return {
    show(code, opened, siren) {
      io.stderr(`${opened ? 'Your browser is open. Approve the code there.' : 'Open the link in your browser, and approve the code there.'}\n`);
      io.stderr(`Code: ${code.userCode}\nLink: ${code.page}\nSiren: ${siren}\nWaiting for approval...\n`);
    },
    wait: (ms) => io.sleep(ms),
    failed: async () => undefined,
  };
}

export class DeviceSignIn implements SignInMethod {
  constructor(
    private readonly login: string,
    private readonly view?: DeviceSignInView,
  ) {}

  async signIn(auth: SessionAuthClient, io: CliIo): Promise<LoginResult> {
    const code = await auth.cliCode(machineName(io.machine));
    const problem = pageProblem(code.page, auth.baseUrl);
    if (problem !== undefined) throw problem;
    const opened = io.openUrl === undefined ? false : await io.openUrl(code.page).catch(() => false);
    const view = this.view ?? plainView(io);
    view.show(code, opened, new URL(auth.baseUrl).host);
    try {
      return await this.poll(auth, io, code, view);
    } catch (error) {
      await view.failed();
      throw error;
    }
  }

  private async poll(auth: SessionAuthClient, io: CliIo, code: DeviceCode, view: DeviceSignInView): Promise<LoginResult> {
    // The tool's own limit holds whatever life Siren names for the code.
    const deadline = io.now() + Math.min(Math.max(code.expiresInSeconds, 0), MAX_WAIT_SECONDS) * 1000;
    let wait = seconds(code.intervalSeconds);
    for (;;) {
      await view.wait(wait * 1000);
      if (io.signal?.aborted) throw stopped();
      if (io.now() >= deadline) throw this.expired();
      let result: LoginResult;
      try {
        result = await auth.cliToken(code.deviceCode);
      } catch (error) {
        if (view.stopped?.() === true || io.signal?.aborted) throw stopped();
        const next = this.nextWait(error, wait);
        if (next === null) throw this.refusal(error);
        wait = next;
        continue;
      }
      // Ctrl-C pressed while the approving poll was on the wire wins: the session is not kept.
      if (view.stopped?.() === true || io.signal?.aborted) throw stopped();
      return result;
    }
  }

  /** The seconds to wait before the next poll after `error`, or null when the poll should stop. */
  private nextWait(error: unknown, wait: number): number | null {
    if (error instanceof ConnectionError) return wait;
    if (!(error instanceof SirenError)) return null;
    const named = isObject(error.data) && typeof error.data.interval === 'number' ? seconds(error.data.interval) : undefined;
    if (error.code === 'authorization_pending') return named ?? wait;
    if (error.code === 'slow_down') return named ?? Math.min(wait + 5, MAX_POLL_SECONDS);
    if (error instanceof RateLimitError) return seconds(Math.max(wait, error.retryAfter ?? wait));
    if (error.statusCode !== undefined && error.statusCode >= 500) return wait;
    return null;
  }

  /** The one line a poll that stops gets. Any other error is answered as it is. */
  private refusal(error: unknown): unknown {
    const code = error instanceof SirenError ? error.code : undefined;
    if (code === 'access_denied') return new CliRefusal('The login was denied in the browser.', { why: 'Nothing was kept.', fix: this.login, fixWords: 'to try again' });
    if (code === 'expired_token') return this.expired();
    if (code === 'invalid_grant') return new CliRefusal('Siren no longer knows this code.', { why: 'It was used or replaced, so nothing was kept.', fix: this.login, fixWords: 'again' });
    return error;
  }

  private expired(): CliRefusal {
    return new CliRefusal('The code expired before anyone approved it.', { why: 'A code lasts a few minutes, so nothing was kept.', fix: this.login, fixWords: 'again' });
  }
}

/** The refusal a login gets when the person pressed Ctrl-C while it waited. */
function stopped(): CliRefusal {
  return new CliRefusal('Stopped waiting for approval.', { why: 'You pressed Ctrl-C, so nothing was kept.', fixText: 'Run siren login again when you are ready.' });
}

/** The longest the tool waits for an approval, whatever life Siren names for the code. */
const MAX_WAIT_SECONDS = 15 * 60;

/** Siren Cloud's hosts, whose API and dashboard sit on different names under one domain. */
const CLOUD_DOMAIN = 'sirenaffiliates.com';

/**
 * Why the tool will not open the approval page Siren named, or undefined
 * when it will. A page in plain http must be on this machine, as the API
 * must be. The page must be on the API's own host, or, for a Siren Cloud
 * API, on a Siren Cloud host, where the dashboard lives apart from the API.
 * A server that answers for Siren cannot send the person to a look-alike
 * page this way.
 */
export function pageProblem(page: string, apiBase: string): CliRefusal | undefined {
  const pageUrl = new URL(page);
  const api = new URL(apiBase);
  if (pageUrl.protocol === 'http:' && !isThisMachine(pageUrl.hostname)) {
    return new CliRefusal(`Siren sent an approval page at ${pageUrl.origin}, which is not https.`, {
      why: 'The tool opens a plain http page only on this machine, so it opened nothing and kept nothing.',
      fixText: "Check the Siren address you logged in to, or ask that Siren's owner.",
    });
  }
  const sameHost = pageUrl.hostname === api.hostname;
  const cloud = isCloudHost(api.hostname) && isCloudHost(pageUrl.hostname);
  if (sameHost || cloud) return undefined;
  return new CliRefusal(`Siren at ${api.host} sent an approval page on ${pageUrl.host}.`, {
    why: `The tool opens a page only on ${api.host} itself${isCloudHost(api.hostname) ? ` or another ${CLOUD_DOMAIN} host` : ''}, so it opened nothing and kept nothing.`,
    fixText: "Check the Siren address you logged in to, or ask that Siren's owner.",
  });
}

/** True for `sirenaffiliates.com` and its subdomains. */
function isCloudHost(host: string): boolean {
  return host === CLOUD_DOMAIN || host.endsWith(`.${CLOUD_DOMAIN}`);
}

/** True for a name or address that means this machine. */
function isThisMachine(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** An interval Siren named, held between 1 second and {@link MAX_POLL_SECONDS}. */
function seconds(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.ceil(value), 1), MAX_POLL_SECONDS) : 5;
}

/**
 * The host name as Siren takes it for `machine`: 1 to 63 letters, digits,
 * dots, hyphens or underscores, or `POST /auth/cli/code` answers 422
 * `invalid_machine_name` (contract/cli-signin.md, 2026-11-24). Any other
 * character becomes a hyphen, the name is cut to 63 characters, and an
 * empty one becomes `siren-cli`. The approval page shows it, so the person
 * can tell their own terminal's request from another.
 */
export function machineName(host: string | undefined): string {
  const name = Array.from(host ?? '', (character) => (/^[A-Za-z0-9._-]$/.test(character) ? character : '-')).join('').slice(0, 63);
  return name === '' ? 'siren-cli' : name;
}
