import { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
import { Siren } from '../client';
import { ApiError, ConnectionError, SirenError } from '../errors';
import { CredentialStore } from './credentials';
import type { StoredSession } from './credentials';
import type { CliIo } from './io';
import { SessionAuthClient } from './session-auth';
import type { Edition, Membership, SessionTokens } from './session-auth';
import { CliRefusal, assertEditionAllowed, assertSessionMatches, commandLine } from './targets';
import type { Target } from './targets';

/** How long before the access token's `exp` the tool refreshes it, in seconds. */
const REFRESH_EARLY_SECONDS = 60;

/** How long Siren's access token lasts (AuthService::TOKEN_TTL), used when a token's `exp` cannot be read. */
const ACCESS_TOKEN_SECONDS = 3600;

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

  constructor(
    readonly io: CliIo,
    readonly target: Target,
    /** True for a command that only reads, which a live organization serves without `--live`. */
    readonly readsOnly: boolean = false,
  ) {
    this.store = new CredentialStore(io.configDir);
    this.auth = new SessionAuthClient({ baseUrl: target.baseUrl, httpClient: io.httpClient });
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
  async signedIn(): Promise<StoredSession> {
    const session = await this.store.get(this.target.baseUrl);
    if (session === null) throw await notSignedIn(this.store, this.target, this.command('login'));
    const edition = await this.targetEdition();
    assertSessionMatches(this.target, session, edition);
    if (!(this.readsOnly && edition === 'production')) assertEditionAllowed(this.target, edition);
    this.adopt(session);
    return session;
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
  async keep(tokens: SessionTokens, org: Membership, edition: Edition, email: string): Promise<StoredSession> {
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
    };
    if (before?.envFiles !== undefined && before.orgId === session.orgId && before.userId === session.userId) session.envFiles = before.envFiles;
    await this.store.put(this.target.baseUrl, session, true);
    this.session = session;
    return session;
  }

  /** Records, by app key, the absolute path of the env file that holds the app's key, in the session in use. */
  async remember(key: string, envPath: string): Promise<void> {
    const session = this.current();
    this.session = { ...session, envFiles: { ...(session.envFiles ?? {}), [key]: envPath } };
    await this.store.put(this.target.baseUrl, this.session);
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
  const here = `You are not signed in to ${target.baseUrl}.`;
  const sessions = Object.entries(await store.all().catch(() => ({}) as Record<string, StoredSession>));
  const [base, other] = sessions.find(([key]) => key !== target.baseUrl) ?? [];
  if (base === undefined || other === undefined) return new CliRefusal(`${here} Run ${login} first.`);
  const live = other.edition === 'production' ? ' --live' : '';
  return new CliRefusal(`${here} You are signed in to ${other.orgName} on ${base}. Pass --base-url ${base}${live} to use it, or run ${login} to sign in here.`);
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
