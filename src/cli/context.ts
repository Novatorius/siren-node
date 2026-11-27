import { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
import { Siren } from '../client';
import { ApiError, ConnectionError, SirenError } from '../errors';
import { CredentialStore } from './credentials';
import type { StoredMembership, StoredSession } from './credentials';
import { basename, join } from 'node:path';
import { APP_FILE_NAME } from './app-file';
import { findOrg, membershipsOf, orgFrom, orgOverruled, orgWanted, settleOrg } from './org';
import type { OrgChoice, OrgWanted } from './org';
import type { CliIo } from './io';
import { SessionAuthClient } from './session-auth';
import type { Edition, Membership, PersonalToken, SessionTokens } from './session-auth';
import { SANDBOX_BASE_URL } from '../http';
import { CliRefusal, LIVE_BASE_URL, assertEditionAllowed, assertSessionMatches, commandLine, hostName } from './targets';
import type { Target } from './targets';
import { clean, styleFor } from './style';

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
    throw new CliRefusal("SIREN_TOKEN isn't a Siren personal access token.", {
      why: 'A personal access token starts siren_pat_. Nothing was sent.',
      fixText: 'Make one under API keys in the Siren dashboard, or unset SIREN_TOKEN.',
    });
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
    return new CliRefusal('Siren takes no personal access token for this.', {
      why: 'This route takes a logged-in session only.',
      fixLead: 'Unset SIREN_TOKEN, run',
      fix: login,
      fixWords: 'to log in, then run the command again',
    });
  }
  return undefined;
}

/**
 * The line Siren's plan code gets, on login, organization choice, switch and
 * refresh (lib/Users/Service/Rest/Login.php, EntitlementException.php), with
 * `login` the `siren login` line for this Siren, or undefined for a code
 * that is no plan code.
 */
export function planRefusal(code: string | undefined, login: string): CliRefusal | undefined {
  const choose = { why: 'Apps and the command-line tool need a plan.', fixLead: 'Choose a plan in the Siren dashboard, then run', fix: login, fixWords: 'again' };
  switch (code) {
    case 'no_entitlement':
      return new CliRefusal('The organization has no plan.', choose);
    case 'entitlement_lapsed':
      return new CliRefusal("The organization's plan has lapsed.", { ...choose, fixLead: 'Renew it in the Siren dashboard, then run' });
    case 'trial_ended':
      return new CliRefusal("The organization's trial has ended.", choose);
    case 'entitlements_unavailable':
      return new CliRefusal("Siren couldn't check the organization's plan just now.", {
        why: "Siren's plan check didn't answer, so nothing was sent.",
        fixText: 'Try again in a minute.',
      });
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
    /** The command as typed, its name and arguments without flags, such as `apps resend apr_…`, which a refusal offers again with --live. */
    readonly retry: string = '',
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
      throw new CliRefusal(`Can't reach ${hostName(this.target.baseUrl)}.`, {
        why: 'Nothing answered there, so nothing was sent.',
        fixText: 'Check the address, or try again in a minute.',
      });
    }
  }

  /** Writes one line to standard output. */
  print(line: string): void {
    this.io.stdout(`${line}\n`);
  }

  /**
   * One line about the data, such as a count, a blank line or a tip: on
   * standard output in a terminal, beside the data, and on standard error
   * through a pipe, so standard output holds the data alone (CLI review
   * round 1, C12). `out` is the style standard output was given.
   */
  aside(out: { rich: boolean }, line: string): void {
    if (out.rich) this.print(line);
    else this.warn(line);
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
      throw new CliRefusal(`siren ${this.sessionOnly} needs you to log in.`, {
        why: 'Siren takes no personal access token there, so SIREN_TOKEN is not enough.',
        fix: this.command('login'),
        fixWords: 'to log in',
      });
    }
    if (session === null) throw await notSignedIn(this.store, this.target, this.command('login'));
    // The organization is settled from the memberships login kept before anything is sent, so a refusal sends nothing.
    const wanted = pick ? await this.wanted() : undefined;
    // A session from before login kept memberships knows only its own organization.
    const kept = orgFrom(membershipsOf(session), wanted);
    if (pick && kept === 'several') this.orgChoice = await settleOrg(this.io, membershipsOf(session), undefined, this.command('orgs'), session.orgId);
    else if (pick && typeof kept === 'object') this.orgChoice = kept;
    if (this.orgChoice !== undefined) this.checkOrgSources(wanted, this.orgChoice.org);
    const edition = await this.targetEdition();
    assertSessionMatches(this.target, session, edition);
    if (!(this.readsOnly && edition === 'production')) assertEditionAllowed(this.target, edition, this.retry);
    this.adopt(session);
    // A name the kept list lacks, which the person may have joined since login: ask Siren.
    if (pick && this.orgChoice === undefined) {
      this.orgChoice = await settleOrg(this.io, await this.memberships(), wanted, this.command('orgs'), session.orgId);
      this.checkOrgSources(wanted, this.orgChoice.org);
    }
    if (this.orgChoice !== undefined && this.orgChoice.org.orgId !== session.orgId) await this.borrow(this.orgChoice.org);
    return this.current();
  }

  /**
   * CLI pass 3, should-fix 5. SIREN_ORG wins over the app file's "org".
   * When they name different organizations, a write refuses before it
   * sends, since a change in the wrong organization is hard to take back,
   * and a read goes ahead with a dim note on stderr that says which won.
   */
  private checkOrgSources(wanted: OrgWanted | undefined, chosen: StoredMembership): void {
    const file = orgOverruled(wanted, chosen);
    if (file === undefined || wanted === undefined) return;
    if (!this.readsOnly) {
      throw new CliRefusal(`SIREN_ORG names ${clean(wanted.name)}, and ${file.from} names ${clean(file.name)}.`, {
        why: "A change goes to one organization, so the tool won't guess which you meant.",
        fixText: `Pass --org to pick one, or unset SIREN_ORG to use ${file.from}.`,
      });
    }
    this.warn(styleFor(this.io, 'stderr', {}).dim(`› SIREN_ORG names ${clean(wanted.name)}, so this reads ${clean(wanted.name)}, not ${clean(file.name)} from ${file.from}.`));
  }

  /**
   * The organization this run acts in, once {@link signedIn} settled it, and
   * where its name came from. Undefined before, and for a command that acts
   * in no organization, such as `orgs`.
   */
  orgChoice: OrgChoice | undefined;

  /** What names the organization for this run: --org, SIREN_ORG, then "org" in the app file. */
  private wanted(): Promise<OrgWanted | undefined> {
    return orgWanted(this.orgFlag, this.io.env, { path: this.appFilePath, shown: basename(this.appFilePath) });
  }

  /** The organization of `memberships` that --org, SIREN_ORG, the app file or a single membership picks, or undefined when none does. */
  async orgInUse(memberships: readonly StoredMembership[]): Promise<StoredMembership | undefined> {
    const chosen = orgFrom(memberships, await this.wanted());
    return typeof chosen === 'object' ? chosen.org : undefined;
  }

  /** Settles the organization for a session already in use, as {@link signedIn} does. `list` is the command a refusal names. */
  async chooseOrg(list: string): Promise<OrgChoice> {
    const session = this.current();
    const wanted = await this.wanted();
    const kept = orgFrom(membershipsOf(session), wanted);
    this.orgChoice = typeof kept === 'object' ? kept : await settleOrg(this.io, kept === 'several' ? membershipsOf(session) : await this.memberships(), wanted, list, session.orgId);
    this.checkOrgSources(wanted, this.orgChoice.org);
    return this.orgChoice;
  }

  /** The person's organizations as Siren lists them now, with `GET /auth/memberships`. */
  async memberships(): Promise<StoredMembership[]> {
    const listed = await this.withAccessToken((accessToken) => this.auth.memberships(accessToken));
    return listed.map(({ orgId, orgName, orgSlug, role }) => ({ orgId, orgName, orgSlug, role }));
  }

  /** Refuses a SIREN_TOKEN run when --org, SIREN_ORG or the app file names another organization than the token's. */
  private async checkTokenOrg(session: StoredSession): Promise<void> {
    const wanted = await this.wanted();
    const own = { orgId: session.orgId, orgName: session.orgName, orgSlug: session.orgSlug ?? '', role: session.role };
    if (wanted === undefined || findOrg([own], wanted.name) !== undefined) {
      this.orgChoice = { org: own, source: wanted?.source ?? 'only' };
      this.checkOrgSources(wanted, own);
      return;
    }
    throw new CliRefusal(`SIREN_TOKEN acts in ${session.orgSlug ?? session.orgName}, and ${wanted.from} names ${wanted.name}.`, {
      why: 'A personal access token works only in the organization it was made in.',
      fixText: `Use a token made in ${wanted.name}, or ${wanted.source === 'file' ? `change "org" in ${wanted.from}` : `drop ${wanted.from}`}.`,
    });
  }

  /**
   * Acts in `org` for the rest of this run, on a pair `POST /auth/switch-org`
   * issues now. The pair and its refreshes stay in memory, so the stored
   * session keeps its own organization and another folder can act in
   * another organization at the same time.
   */
  private async borrow(org: StoredMembership): Promise<void> {
    let tokens: SessionTokens;
    try {
      tokens = await this.withAccessToken((accessToken) => this.auth.switchOrg(accessToken, org.orgId));
    } catch (error) {
      throw planRefusal(error instanceof SirenError ? error.code : undefined, this.command('login')) ?? error;
    }
    this.session = {
      ...this.current(),
      orgId: org.orgId,
      orgName: org.orgName,
      ...(org.orgSlug ? { orgSlug: org.orgSlug } : {}),
      role: org.role,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: this.expiryOf(tokens.accessToken),
    };
    this.borrowed = true;
  }

  /** True once {@link borrow} put this run in another organization than the stored session's. */
  private borrowed = false;

  /**
   * The SIREN_TOKEN path of {@link signedIn}: the edition read and the
   * `--live` rule as for a session, then `GET /personal-tokens/current`
   * once, so the commands know the person and organization the token acts
   * as. The token is held for this run only and never written to
   * credentials.json.
   */
  private async withToken(token: string): Promise<StoredSession> {
    const edition = await this.targetEdition();
    if (!(this.readsOnly && edition === 'production')) assertEditionAllowed(this.target, edition, this.retry);
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

  /**
   * A `siren` command line for a hint, with the flags that reach this Siren
   * (`commandLine`). A hint to a write carries `--live` when the person typed
   * it, and also when the session in use is live though this command, a
   * read, needed none, since the write would be refused without it.
   */
  command(words: string): string {
    const live = this.target.live || this.session?.edition === 'production';
    return commandLine({ ...this.target, live }, words);
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
    // A pair borrowed for another organization lives in memory only.
    if (!this.borrowed) await this.store.put(this.target.baseUrl, this.session);
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
  const detail = [`Siren: ${shortAddress(target.baseUrl)}`];
  const sessions = Object.entries(await store.all().catch(() => ({}) as Record<string, StoredSession>));
  const [base, other] = sessions.find(([key]) => key !== target.baseUrl) ?? [];
  const none = `The tool keeps no session for ${hostName(target.baseUrl)}.`;
  if (base === undefined || other === undefined) return new CliRefusal('Not logged in.', { why: none, fix: login, fixWords: 'to log in', detail });
  const live = other.edition === 'production' ? ' --live' : '';
  return new CliRefusal('Not logged in.', {
    why: `${none} You're logged in to ${other.orgSlug ?? other.orgName} on ${hostName(base)}, which --base-url ${shortAddress(base)}${live} uses.`,
    fix: login,
    fixWords: 'to log in here',
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
  const plan = planRefusal(error instanceof SirenError ? error.code : undefined, login);
  if (plan !== undefined) return plan;
  if (error instanceof ConnectionError || error instanceof ApiError) {
    return new CliRefusal("Couldn't renew your session just now.", { why: "Siren didn't answer, so nothing was sent.", fixText: 'Try again in a minute.' });
  }
  return new CliRefusal('Your session has ended.', { why: 'Siren no longer accepts it, so nothing was sent.', fix: login, fixWords: 'to log in again' });
}





