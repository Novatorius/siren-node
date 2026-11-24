import { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
import { Siren } from '../client';
import { ApiError, ConnectionError, SirenError } from '../errors';
import { CredentialStore } from './credentials';
import type { StoredMembership, StoredSession } from './credentials';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { APP_FILE_NAME } from './app-file';
import type { CliIo } from './io';
import { SessionAuthClient } from './session-auth';
import type { Edition, Membership, PersonalToken, SessionTokens } from './session-auth';
import { SANDBOX_BASE_URL } from '../http';
import { CliRefusal, LIVE_BASE_URL, assertEditionAllowed, assertSessionMatches, commandLine } from './targets';
import type { Target } from './targets';

/** How long before the access token's `exp` the tool refreshes it, in seconds. */
const REFRESH_EARLY_SECONDS = 60;

/** How long Siren's access token lasts (AuthService::TOKEN_TTL), used when a token's `exp` cannot be read. */
const ACCESS_TOKEN_SECONDS = 3600;

/** A personal access token's form: `siren_pat_` and 48 lowercase hex characters (contract/cli-signin.md, section 2). */
const PERSONAL_TOKEN = /^siren_pat_[0-9a-f]{48}$/;

/**
 * The personal access token in SIREN_TOKEN, or undefined when it is unset or
 * empty. Throws `CliRefusal` for a value of any other form, before it is sent
 * anywhere, and never quotes it.
 */
export function tokenFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env.SIREN_TOKEN;
  if (value === undefined || value === '') return undefined;
  if (!PERSONAL_TOKEN.test(value.trim())) {
    throw new CliRefusal(
      'SIREN_TOKEN does not hold a Siren personal access token, which starts siren_pat_ and comes from API keys in the Siren dashboard. Nothing was sent.',
    );
  }
  return value.trim();
}

/**
 * The refusal Siren's refusals of a personal access token get, with `login`
 * the `siren login` line for this Siren, or undefined for any other error.
 */
export function tokenRefusal(error: unknown, login: string): CliRefusal | undefined {
  const code = error instanceof SirenError ? error.code : undefined;
  if (code === 'invalid_token') {
    return new CliRefusal('SIREN_TOKEN was revoked or has expired.', {
      why: 'Make a new one in the Siren dashboard, or unset SIREN_TOKEN.',
      fix: login,
      fixWords: 'to log in',
    });
  }
  if (code === 'token_not_accepted') {
    return new CliRefusal('Siren takes no personal access token for this.', { why: 'Unset SIREN_TOKEN.', fix: login, fixWords: 'to log in, then run the command again' });
  }
  return undefined;
}

/**
 * The line Siren's plan code gets, on login, organization choice, switch and
 * refresh (lib/Users/Service/Rest/Login.php, EntitlementException.php), with
 * `login` the `siren login` line for this Siren, or undefined for a code
 * that is no plan code.
 */
export function planLine(code: string | undefined, login: string): string | undefined {
  switch (code) {
    case 'no_entitlement':
      return `The organization has no plan. Choose a plan in the Siren dashboard, then run ${login} again.`;
    case 'entitlement_lapsed':
      return `The organization's plan has lapsed. Renew it in the Siren dashboard, then run ${login} again.`;
    case 'trial_ended':
      return `The organization's trial has ended. Choose a plan in the Siren dashboard, then run ${login} again.`;
    case 'entitlements_unavailable':
      return "Siren could not check the organization's plan just now. Try again in a minute.";
    default:
      return undefined;
  }
}

/** What `runCli` hands each command: its context, its own options and its arguments after the command words. */
export interface CommandInput {
  /** Null for a command that sends nothing, such as `apps init`. */
  context: CommandContext | null;
  io: CliIo;
  values: Readonly<Record<string, string | boolean | undefined>>;
  args: readonly string[];
  /**
   * A `siren` command line for a hint, with the flags that reach the Siren
   * this command line named (`commandLine`). Set for every command, `apps
   * init` included, which sends nothing.
   */
  command(words: string): string;
  /** The session kept for the Siren this command line names, read from credentials.json, or null. Sends nothing. */
  kept?(): Promise<StoredSession | null>;
}

/** One command's body. Answers the exit code. Throws `CliRefusal`, `CliUsageError` or a `SirenError` to refuse. */
export type CommandHandler = (input: CommandInput) => Promise<number>;

/** The context of a command that talks to Siren. Throws when `runCli` built none, which is a fault in its table. */
export function contextOf(input: CommandInput): CommandContext {
  if (input.context === null) throw new Error('siren: this command has no Siren to talk to.');
  return input.context;
}

/**
 * What one command run shares: the terminal, the Siren it talks to, the
 * stored sessions, the session client and, once a command needs one, the
 * signed-in session. The command files under src/cli/commands use it, so
 * none of them reads `credentials.json` or refreshes a token itself.
 */
export class CommandContext {
  readonly store: CredentialStore;
  readonly auth: SessionAuthClient;
  private session: StoredSession | null = null;
  private editionRead: Promise<Edition> | null = null;
  /** The token from SIREN_TOKEN and what Siren said about it, once {@link signedIn} chose it. */
  private personal: { token: string; about: PersonalToken } | null = null;
  /** The organization --org names, which wins over every other way to pick one. */
  orgFlag: string | undefined;
  /** The app file whose "org" picks the organization after --org and SIREN_ORG: siren.app.json here, or the file apply reads. */
  appFilePath: string;

  constructor(
    readonly io: CliIo,
    readonly target: Target,
    /** True for a command that only reads, which a live organization serves without `--live`. */
    readonly readsOnly: boolean = false,
    /**
     * The command's name when Siren takes no personal access token on its
     * route, such as `apps answer`: it uses the stored session even when
     * SIREN_TOKEN is set, and refuses before sending when there is none.
     */
    readonly sessionOnly?: string,
  ) {
    this.store = new CredentialStore(io.configDir);
    this.auth = new SessionAuthClient({ baseUrl: target.baseUrl, httpClient: io.httpClient });
    this.appFilePath = join(io.cwd, APP_FILE_NAME);
  }

  /**
   * One edition read. A target that sends no answer, after the read's own
   * short timeout and one retry, is refused with one line that says it did
   * not answer, in place of the transport's line.
   */
  private async readEdition(): Promise<Edition> {
    try {
      return await this.auth.edition();
    } catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      throw new CliRefusal(
        `${this.target.baseUrl} did not answer when the tool asked which edition it is, so nothing was sent. Check the address, or try again in a minute.`,
      );
    }
  }

  /** Writes one line to standard output. */
  print(line: string): void {
    this.io.stdout(`${line}\n`);
  }

  /** Writes one line to standard error. */
  warn(line: string): void {
    this.io.stderr(`${line}\n`);
  }

  /**
   * The edition the target reports now, from `GET /auth/signup-options`.
   * Read at the first call, and the same answer is given to every later call
   * until {@link recheckEdition} reads it again, so a refresh never reads it
   * twice. A Siren that names none counts as live.
   */
  targetEdition(): Promise<Edition> {
    this.editionRead ??= this.readEdition();
    return this.editionRead;
  }

  /**
   * Reads the target's edition again and checks the session in use against
   * it with `assertSessionMatches`, for a command that keeps sending:
   * `apps requests --follow` calls it before each poll. A target that became
   * live, or became a sandbox, stops the command with the one line every
   * other command gives, before the next poll is sent. `signedIn()` already
   * held `--live` to the session's edition, so any change of edition is a
   * session mismatch first. It costs one GET with no credential, a few dozen
   * bytes, per poll.
   */
  async recheckEdition(): Promise<void> {
    this.editionRead = this.readEdition();
    assertSessionMatches(this.target, this.current(), await this.editionRead);
  }

  /**
   * The stored session for this Siren, checked before anything else is sent
   * with it: refused when there is none, naming `siren login`, and, once the
   * target's edition is read, refused when the session was made for another
   * address or edition (`assertSessionMatches`), or when `--live` does not
   * match the edition (`assertEditionAllowed`). With no session nothing is
   * sent at all.
   */
  async signedIn(options: { org?: boolean } = {}): Promise<StoredSession> {
    const pick = options.org !== false;
    const token = tokenFrom(this.io.env);
    if (token !== undefined && this.sessionOnly === undefined) {
      const session = await this.withToken(token);
      if (pick) await this.checkTokenOrg(session);
      return session;
    }
    const session = await this.store.get(this.target.baseUrl);
    if (session === null && token !== undefined) {
      throw new CliRefusal(`siren ${this.sessionOnly} needs you to log in, since Siren takes no personal access token there.`, {
        fix: this.command('login'),
        fixWords: 'to log in',
      });
    }
    if (session === null) throw await notSignedIn(this.store, this.target, this.command('login'));
    // Which organization is decided before anything is sent, so a refusal sends nothing.
    const org = pick ? await this.pickOrg(membershipsOf(session)) : undefined;
    const edition = await this.targetEdition();
    assertSessionMatches(this.target, session, edition);
    if (!(this.readsOnly && edition === 'production')) assertEditionAllowed(this.target, edition);
    this.adopt(session);
    if (org !== undefined && org.orgId !== session.orgId) return this.switchTo(org);
    return session;
  }

  /**
   * What names the organization this command acts in, and where it came
   * from: --org, then SIREN_ORG, then "org" in the app file. Undefined when
   * none of them names one.
   */
  private async wantedOrg(): Promise<{ value: string; from: string } | undefined> {
    if (this.orgFlag !== undefined && this.orgFlag !== '') return { value: this.orgFlag, from: '--org' };
    const env = this.io.env.SIREN_ORG;
    if (env !== undefined && env !== '') return { value: env, from: 'SIREN_ORG' };
    const fromFile = await orgInFile(this.appFilePath);
    return fromFile === undefined ? undefined : { value: fromFile, from: basename(this.appFilePath) };
  }

  /**
   * The organization this command acts in, from {@link wantedOrg}, else the
   * person's only one. With neither it asks in a terminal and refuses
   * elsewhere, naming each organization. Sends nothing.
   */
  async pickOrg(memberships: readonly StoredMembership[]): Promise<StoredMembership> {
    const wanted = await this.wantedOrg();
    if (wanted !== undefined) {
      const found = findOrg(memberships, wanted.value);
      if (found === undefined) {
        throw new CliRefusal(`You are not in an organization named ${wanted.value}. Yours are ${orgList(memberships)}.`, {
          fix: this.command('orgs'),
          fixWords: 'to list them',
        });
      }
      return found;
    }
    if (memberships.length === 1) return memberships[0]!;
    if (!this.io.interactive) {
      throw new CliRefusal(
        `You belong to ${memberships.length} organizations: ${orgList(memberships)}. Pick one with --org <slug>, SIREN_ORG, or "org" in siren.app.json.`,
      );
    }
    return askOrg(this.io, memberships);
  }

  /** Refuses a SIREN_TOKEN run when --org, SIREN_ORG or the app file names another organization than the token's. */
  private async checkTokenOrg(session: StoredSession): Promise<void> {
    const wanted = await this.wantedOrg();
    if (wanted === undefined) return;
    const own = { orgId: session.orgId, orgName: session.orgName, orgSlug: session.orgSlug ?? '', role: session.role };
    if (findOrg([own], wanted.value) !== undefined) return;
    throw new CliRefusal(`SIREN_TOKEN acts in ${session.orgName} (${session.orgSlug ?? session.orgId}), and ${wanted.from} names ${wanted.value}.`, {
      why: 'A personal access token works only in the organization it was made in.',
    });
  }

  /**
   * Moves the session in use to `org` with `POST /auth/switch-org` and saves
   * the new pair, which acts there. The person's other organizations stay
   * kept, so a later command can switch again.
   */
  private async switchTo(org: StoredMembership): Promise<StoredSession> {
    const session = this.current();
    let tokens: SessionTokens;
    try {
      tokens = await this.withAccessToken((accessToken) => this.auth.switchOrg(accessToken, org.orgId));
    } catch (error) {
      const plan = planLine(error instanceof SirenError ? error.code : undefined, this.command('login'));
      throw plan === undefined ? error : new CliRefusal(plan);
    }
    const moved: StoredSession = {
      ...this.current(),
      orgId: org.orgId,
      orgName: org.orgName,
      ...(org.orgSlug ? { orgSlug: org.orgSlug } : {}),
      role: org.role,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: this.expiryOf(tokens.accessToken),
      memberships: membershipsOf(session),
    };
    this.session = moved;
    await this.store.put(this.target.baseUrl, moved);
    return moved;
  }


  /**
   * The SIREN_TOKEN path of {@link signedIn}: the edition read and the
   * `--live` rule as for a session, then `GET /personal-tokens/current`
   * once, so the commands know the person and organization the token acts
   * as. The token is held for this run only and never written to
   * credentials.json.
   */
  private async withToken(token: string): Promise<StoredSession> {
    const edition = await this.targetEdition();
    if (!(this.readsOnly && edition === 'production')) assertEditionAllowed(this.target, edition);
    let about: PersonalToken;
    try {
      about = await this.auth.personalToken(token);
    } catch (error) {
      throw tokenRefusal(error, this.command('login')) ?? error;
    }
    this.personal = { token, about };
    const session: StoredSession = {
      edition,
      baseUrl: this.target.baseUrl,
      email: about.user.email,
      userId: about.user.id,
      orgId: about.org.orgId,
      orgName: about.org.orgName,
      ...(about.org.orgSlug ? { orgSlug: about.org.orgSlug } : {}),
      role: about.user.role,
      accessToken: token,
      refreshToken: '',
      accessExpiresAt: Number.MAX_SAFE_INTEGER,
    };
    this.session = session;
    return session;
  }

  /** True when this run acts with SIREN_TOKEN rather than a stored session. */
  usesToken(): boolean {
    return this.personal !== null;
  }

  /** A `siren` command line for a hint, with the flags that reach this Siren (`commandLine`). */
  command(words: string): string {
    return commandLine(this.target, words);
  }

  /** Uses this session for the rest of the run, without the edition check. `logout` alone calls it directly. */
  adopt(session: StoredSession): void {
    this.session = session;
  }

  /** The session in use. Throws when no command step adopted one, which is a fault in the tool. */
  current(): StoredSession {
    if (this.session === null) throw new Error('siren: no session is in use.');
    return this.session;
  }

  /**
   * A client for the app routes, over the command's `HttpClient`, carrying
   * the session's access token. It refreshes the token 60 seconds before its
   * `exp`, and once after a 401, and saves each new pair at once.
   */
  siren(): Siren {
    return new Siren({
      accessToken: new CallbackAccessTokenSource(
        () => this.accessToken(),
        () => this.refresh(),
      ),
      httpClient: this.io.httpClient,
      baseUrl: this.target.baseUrl,
    });
  }

  /** The access token, refreshed first when it ends within 60 seconds. */
  async accessToken(): Promise<string> {
    if (this.personal !== null) return this.personal.token;
    const session = this.current();
    if (session.accessExpiresAt - REFRESH_EARLY_SECONDS <= this.io.now() / 1000) return this.refresh();
    return session.accessToken;
  }

  /**
   * Spends the refresh token for a new pair and saves it before anything
   * else, since Siren has spent the old one. A refused refresh says to sign
   * in again. A plan Siren refused says what to do about the plan, and a
   * Siren that could not answer says to try again, keeping the session.
   */
  async refresh(): Promise<string> {
    // A personal access token never refreshes. A 401 means Siren no longer takes it.
    if (this.personal !== null) throw tokenRefusal(new SirenError('', { code: 'invalid_token' }), this.command('login'))!;
    const session = this.current();
    let tokens: SessionTokens;
    try {
      tokens = await this.auth.refresh(session.refreshToken);
    } catch (error) {
      throw refreshRefusal(error, this.command('login'));
    }
    this.session = { ...session, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: this.expiryOf(tokens.accessToken) };
    await this.store.put(this.target.baseUrl, this.session);
    return tokens.accessToken;
  }

  /**
   * Runs a session route that takes the access token, and once more with a
   * refreshed token when Siren answers 401, as the app routes' transport does.
   */
  async withAccessToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    try {
      return await call(token);
    } catch (error) {
      // A 401 with a code, such as a plan refusal, is no spent token.
      if (!(error instanceof SirenError) || error.statusCode !== 401 || error.code !== undefined) throw error;
      return call(await this.refresh());
    }
  }

  /**
   * Saves a new session for this Siren from a sign-in, a sign-up or a switch.
   * The env file paths of the session before are kept only when it was the
   * same person in the same organization, since another organization's apps
   * are other apps.
   */
  async keep(tokens: SessionTokens, org: Membership, edition: Edition, email: string, memberships?: readonly Membership[]): Promise<StoredSession> {
    const before = await this.store.get(this.target.baseUrl);
    const session: StoredSession = {
      edition,
      baseUrl: this.target.baseUrl,
      email: tokens.user.email || email,
      userId: tokens.user.id,
      orgId: org.orgId,
      orgName: org.orgName,
      ...(org.orgSlug ? { orgSlug: org.orgSlug } : {}),
      role: org.role,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: this.expiryOf(tokens.accessToken),
      ...(memberships === undefined ? {} : { memberships: memberships.map(({ orgId, orgName, orgSlug, role }) => ({ orgId, orgName, orgSlug, role })) }),
    };
    if (before?.envFiles !== undefined && before.userId === session.userId) session.envFiles = before.envFiles;
    await this.store.put(this.target.baseUrl, session, true);
    this.session = session;
    return session;
  }

  /** Records, by app key, the absolute path of the env file that holds the app's key, in the session in use. */
  async remember(key: string, envPath: string): Promise<void> {
    const session = this.current();
    this.session = { ...session, envFiles: { ...(session.envFiles ?? {}), [key]: envPath } };
    // A run on SIREN_TOKEN writes nothing to credentials.json.
    if (this.personal === null) await this.store.put(this.target.baseUrl, this.session);
  }

  /** The env file an app's key goes to for this session: `.env.live` for a live organization, else `.env.sandbox`. */
  envFileName(): string {
    return this.current().edition === 'production' ? '.env.live' : '.env.sandbox';
  }

  /** The access token's `exp` in Unix seconds, or an hour from now when it cannot be read. */
  private expiryOf(accessToken: string): number {
    const exp = jwtClaim(accessToken, 'exp');
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : Math.floor(this.io.now() / 1000) + ACCESS_TOKEN_SECONDS;
  }
}

/**
 * The refusal for a Siren with no session here: it names `login`, and the
 * Siren a session is kept for, when there is one, so a person who signed in
 * elsewhere learns where.
 */
export async function notSignedIn(store: CredentialStore, target: Target, login: string): Promise<CliRefusal> {
  const here = target.baseUrl === SANDBOX_BASE_URL || target.baseUrl === LIVE_BASE_URL ? {} : { note: `Siren: ${shortAddress(target.baseUrl)}` };
  const detail = [`Siren: ${shortAddress(target.baseUrl)}`];
  const sessions = Object.entries(await store.all().catch(() => ({}) as Record<string, StoredSession>));
  const [base, other] = sessions.find(([key]) => key !== target.baseUrl) ?? [];
  if (base === undefined || other === undefined) return new CliRefusal('Not logged in.', { fix: login, fixWords: 'to log in', ...here, detail });
  const live = other.edition === 'production' ? ' --live' : '';
  return new CliRefusal('Not logged in.', {
    why: `You are logged in to ${other.orgName} on ${base}. Pass --base-url ${base}${live} to use it.`,
    fix: login,
    fixWords: 'to log in here',
    ...here,
    detail,
  });
}

/** A Siren's address without `https://`, and without `/siren/v1` when it ends there, for a line a person reads. */
export function shortAddress(baseUrl: string): string {
  return baseUrl.replace(/^https:\/\//, '').replace(/\/siren\/v1$/, '');
}

/** One claim of a JWT's payload, read without checking the signature, or undefined. */
export function jwtClaim(token: string, claim: string): unknown {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>)[claim] : undefined;
  } catch {
    return undefined;
  }
}

/** The one line a failed refresh gets, with `login` the `siren login` line for this Siren. */
function refreshRefusal(error: unknown, login: string): CliRefusal {
  const plan = planLine(error instanceof SirenError ? error.code : undefined, login);
  if (plan !== undefined) return new CliRefusal(plan);
  if (error instanceof ConnectionError || error instanceof ApiError) {
    return new CliRefusal('Siren could not renew your session just now. Try again in a minute.');
  }
  return new CliRefusal(`Your session has ended. Run ${login} to sign in again.`);
}

/** The person's organizations from a stored session: those kept at login, else the session's own one. */
export function membershipsOf(session: StoredSession): StoredMembership[] {
  if (session.memberships !== undefined && session.memberships.length > 0) return [...session.memberships];
  return [{ orgId: session.orgId, orgName: session.orgName, orgSlug: session.orgSlug ?? '', role: session.role }];
}

/** The membership whose slug or id is `wanted`. */
export function findOrg<T extends { orgId: number; orgSlug: string }>(memberships: readonly T[], wanted: string): T | undefined {
  return memberships.find((membership) => (membership.orgSlug !== '' && membership.orgSlug === wanted) || String(membership.orgId) === wanted);
}

/** "acme (Acme) and acme-two (Acme Two)". */
export function orgList(memberships: readonly StoredMembership[]): string {
  const names = memberships.map((membership) => `${membership.orgSlug || membership.orgId} (${membership.orgName})`);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The "org" an app file names at its top, or undefined when it names none or cannot be read. */
export async function orgInFile(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const org = typeof parsed === 'object' && parsed !== null ? (parsed as { org?: unknown }).org : undefined;
    return typeof org === 'string' && org !== '' ? org : undefined;
  } catch {
    return undefined;
  }
}

/** Lists the person's organizations on standard error, asks which one, and answers it, or refuses one they are not in. */
export async function askOrg(io: CliIo, memberships: readonly StoredMembership[]): Promise<StoredMembership> {
  io.stderr(`You belong to ${memberships.length} organizations:\n`);
  for (const membership of memberships) io.stderr(`  ${membership.orgSlug}  ${membership.orgName}\n`);
  const typed = (await io.prompt('Organization (slug): ')).trim();
  const chosen = findOrg(memberships, typed);
  if (chosen === undefined) throw new CliRefusal(`You are not in an organization named ${typed}. Yours are ${orgList(memberships)}.`);
  return chosen;
}
