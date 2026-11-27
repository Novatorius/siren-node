import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { SirenError } from '../../errors';
import { APP_FILE_NAME } from '../app-file';
import { contextOf, jwtClaim, notSignedIn, planRefusal, tokenFrom, tokenRefusal } from '../context';
import type { CommandContext, CommandInput } from '../context';
import type { CliIo } from '../io';
import { findOrg, orgList } from '../org';
import { clean, styleFor } from '../style';
import { loginView, passwordView } from '../login-view';
import type { LoginEnd } from '../login-view';
import type { Style } from '../style';
import { DeviceSignIn, PasswordSignIn, askLine, readPassword } from '../session-auth';
import type { Edition, EmailConfirmationWindow, LoginResult, Membership, PersonalToken, SessionTokens } from '../session-auth';
import { CliRefusal, CliUsageError, assertEditionAllowed, assertSessionMatches, hostName, httpDetail } from '../targets';

/*
 * `siren signup`, `login`, `logout`, `orgs` and `use`: signing a person in
 * from a terminal and choosing the organization the other commands act on.
 * Contract: docs/architecture/apps-cli.md, "Signing in and the stored files"
 * and "Confirmation and plan answers".
 */

/**
 * `siren signup`: reads credentials.json first, so a file the tool would
 * refuse stops it before anything is sent, then reads the edition, checks
 * it against `--live`, asks for
 * what the flags left out, and sends `POST /auth/register-org` once. Keeps
 * the session Siren gives, or none when Siren wants the address confirmed
 * first. Never prints a token.
 */
export async function signup(input: CommandInput): Promise<number> {
  // Echo goes off before anything is sent, so a password typed early is never shown or taken as an answer.
  const release = input.values['password-stdin'] !== true && input.io.interactive ? input.io.holdKeys?.() : undefined;
  try {
    return await signupHeld(input);
  } finally {
    release?.();
  }
}

async function signupHeld(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const passwordFromStdin = values['password-stdin'] === true;
  needsFlags(io, [
    [values['org-name'], '--org-name <name>'],
    [values.email, '--email <address>'],
    [passwordFromStdin || undefined, '--password-stdin'],
  ]);
  // A credentials file the tool would refuse stops the command here, before the password leaves the machine.
  await run.store.get(run.target.baseUrl);

  const edition = await run.targetEdition();
  assertEditionAllowed(run.target, edition, 'signup', 'Signing up on a live Siren');

  const orgName = text(values['org-name']) ?? (await askLine(io, 'Organization name: ', '--org-name'));
  const email = text(values.email) ?? (await askLine(io, 'Email: ', '--email'));
  const accepted =
    values['accept-terms'] === true ||
    (io.interactive && /^y(es)?$/i.test((await io.prompt("Do you accept Siren's Terms of Service and Privacy Policy? (y/N) ")).trim()));
  if (!accepted) {
    throw new CliRefusal("You need to accept Siren's terms to make an organization.", {
      why: 'Siren makes one only for a person who accepts its Terms of Service and Privacy Policy.',
      fix: run.command('signup --accept-terms'),
      fixWords: 'to accept them',
    });
  }
  if (orgName === '' || email === '') {
    throw new CliRefusal('Sign-up needs an organization name and an email.', {
      why: 'One of them was empty, so nothing was sent.',
      fix: run.command('signup --org-name Acme --email you@acme.com'),
    });
  }
  const password = await readPassword(io, passwordFromStdin);

  let registered;
  try {
    registered = await run.auth.registerOrg({ orgName, email, password, acceptTerms: true });
  } catch (error) {
    if ((error as SirenError).statusCode === 404) {
      throw new CliRefusal(`${hostName(run.target.baseUrl)} doesn't take sign-ups.`, {
        why: 'Its owner turned sign-up off.',
        fixLead: 'Ask its owner for an invite, then run',
        fix: run.command('login'),
      });
    }
    throw error;
  }

  const org = registered.org;
  // Pass 3 re-check, must-fix 2: the first success a newcomer sees, in the shape every success has.
  const out = styleFor(io, 'stdout', values);
  const made = `Made ${out.bold(clean(org.orgName))} (${clean(org.orgSlug)})`;
  const siren = `${hostName(run.target.baseUrl)}, ${edition === 'production' ? out.amber('live') : 'sandbox'}`;
  if (registered.tokens === null) {
    run.print(
      out
        .report({
          headline: made,
          rows: [['Siren', siren], ['Email', clean(email)]],
          next: [{ text: `Open the email Siren sent to your inbox, and confirm the address` }, { text: out.command(run.command('login')) }],
        })
        .replace(/\n$/, ''),
    );
    return 0;
  }

  const session = await run.keep(registered.tokens, org, edition, email);
  run.print(
    out
      .report({
        headline: made,
        rows: [['Signed in as', clean(session.email)], ['Siren', siren]],
        next: [{ text: out.command(run.command('apps init')), aside: 'write siren.app.json in this folder' }],
      })
      .replace(/\n$/, ''),
  );
  const pending = confirmationLine(registered.emailConfirmation ?? registered.tokens.emailConfirmation, io.now());
  if (pending !== null) run.print(pending);
  return 0;
}

/**
 * True when `siren login` with these flags logs in by a code approved in
 * the browser: neither `--password` nor `--password-stdin`.
 */
export function usesBrowserSignIn(values: Readonly<Record<string, unknown>>): boolean {
  return values.password !== true && values['password-stdin'] !== true;
}

/** True when CI names a build machine: set, and not empty, `false` or `0`. */
function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0';
}

/**
 * `siren login`: logs in the person, not one organization. Reads
 * credentials.json first, as `signup` does, then reads the edition and
 * checks it against `--live`. With no password flag it logs in by a code
 * the person approves in the browser ({@link DeviceSignIn}). With
 * `--password` or `--password-stdin` it asks for or reads the email and
 * password. Either way it keeps every organization the person belongs to,
 * and each later command picks one (CommandContext `pickOrg`). With no
 * terminal, or in CI, the browser login is refused before anything is
 * sent, naming SIREN_TOKEN. Keeps the session and never the verification
 * token or the device code.
 */
export async function login(input: CommandInput): Promise<number> {
  // The password login turns echo off before it sends or draws anything, so a password typed early is
  // never shown, and the prompts drop it rather than take it as an answer.
  const asks = !usesBrowserSignIn(input.values) && input.values['password-stdin'] !== true && input.io.interactive;
  const release = asks ? input.io.holdKeys?.() : undefined;
  try {
    return await loginHeld(input);
  } finally {
    release?.();
  }
}

async function loginHeld(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const passwordFromStdin = values['password-stdin'] === true;
  const browser = usesBrowserSignIn(values);
  if (browser && values.email !== undefined) {
    throw new CliUsageError('--email goes with --password or --password-stdin. With neither, you log in in the browser.');
  }
  if (browser && (!io.interactive || inCi(io.env))) {
    throw new CliUsageError(
      'There is no terminal here to approve a login from. Set SIREN_TOKEN to a personal access token from the Siren dashboard, or pass --password-stdin and --email.',
    );
  }
  if (!browser) {
    needsFlags(io, [
      [values.email, '--email <address>'],
      [passwordFromStdin || undefined, '--password-stdin'],
    ]);
  }
  // A credentials file the tool would refuse stops the command here, before the password leaves the machine.
  await run.store.get(run.target.baseUrl);

  const edition = await run.targetEdition();
  assertEditionAllowed(run.target, edition, 'login', 'Logging in to a live organization');

  const style = styleFor(io, 'stdout', {});
  const view = browser ? loginView(io, values) : undefined;
  // --password asks beside the logo where it may play. --password-stdin asks nothing.
  const prompts = !browser && !passwordFromStdin ? passwordView(io, values, new URL(run.target.baseUrl).host) : undefined;
  const end = view ?? prompts;
  let result: LoginResult;
  try {
    result = view !== undefined
      ? await new DeviceSignIn(run.command('login'), view).signIn(run.auth, io)
      : await new PasswordSignIn(prompts).signIn(run.auth, io, { email: text(values.email), passwordFromStdin });
  } catch (error) {
    // The device login drifts its halves away itself. The password login's go here, before the ✗ line.
    await prompts?.failed();
    throw signInRefusal(error, run.command('login'), run.target.baseUrl, view !== undefined);
  }
  try {
    return await keepLogin(input, result, edition, style, end);
  } catch (error) {
    // The approval landed, but keeping the session failed: the halves drift away before the ✗ line.
    await end?.failed();
    throw error;
  }
}

/** Keeps the session a login gave, says who is logged in, and grips the logo when the login was in the browser. */
async function keepLogin(input: CommandInput, result: LoginResult, edition: Edition, style: Style, view: LoginEnd | undefined): Promise<number> {
  const run = contextOf(input);
  const { io } = input;

  const memberships = result.memberships;
  let tokens: SessionTokens;
  let org: Membership | undefined;
  const wanted = typeof input.values.org === 'string' ? input.values.org : undefined;
  if (wanted !== undefined && findOrg(memberships, wanted) === undefined) {
    throw new CliRefusal(`You're not in an organization named ${wanted}.`, { why: `--org names it. Yours: ${orgList(memberships)}.`, fix: run.command('login'), fixWords: 'without --org' });
  }
  if (result.kind === 'session') {
    tokens = result.tokens;
    const orgId = jwtClaim(tokens.accessToken, 'orgId');
    org = memberships.find((membership) => membership.orgId === orgId) ?? memberships[0];
  } else {
    // A person in several organizations: --org, else the first, starts the session, and each command switches to the one it needs.
    org = wanted === undefined ? memberships[0] : findOrg(memberships, wanted);
    if (org !== undefined) {
      try {
        tokens = await run.auth.selectOrg(result.verificationToken, org.orgId);
      } catch (error) {
        throw signInRefusal(error, run.command('login'), run.target.baseUrl);
      }
    }
  }
  if (org === undefined) {
    throw new CliRefusal("Your account isn't in an organization.", {
      why: 'Siren logged you in but named none.',
      fixLead: 'Ask an admin to invite you, or run',
      fix: run.command('signup'),
    });
  }

  const session = await run.keep(tokens!, org, edition, tokens!.user.email, memberships);
  const count = `${memberships.length} ${memberships.length === 1 ? 'organization' : 'organizations'}`;
  const line = `Logged in as ${style.bold(session.email)} · ${count}`;
  if (view !== undefined) await view.approved(line);
  else io.stdout(`${style.success(line)}\n`);
  const pending = confirmationLine(tokens!.emailConfirmation, io.now());
  if (pending !== null) run.print(pending);
  if (io.env.SIREN_TOKEN !== undefined && io.env.SIREN_TOKEN !== '') {
    run.warn('SIREN_TOKEN is set, so the other commands use it rather than this session. Unset SIREN_TOKEN to use the session.');
  }
  // CLI pass 3, should-fix 14: what comes next, as the bare screen says it. A folder with siren.app.json is one step further on.
  const hasFile = await access(join(io.cwd, APP_FILE_NAME)).then(() => true, () => false);
  const next = hasFile
    ? { text: style.command(run.command('apps apply')), aside: 'declare the app on Siren and save its key' }
    : { text: style.command(run.command('apps init')), aside: 'write siren.app.json in this folder' };
  io.stdout(style.report({ headline: '', mark: false, next: [next] }).replace(/^\n/, ''));
  return 0;
}

/**
 * `siren logout`: reads the edition the target reports, then revokes the
 * access and refresh tokens with `POST /auth/logout` and forgets this
 * Siren's session, even when Siren refuses. Needs no `--live`, since it
 * sends only the session's own tokens. When the target is now another
 * edition than the session was made for, or its edition cannot be read, it
 * sends the tokens nowhere and forgets the session on this machine.
 */
export async function logout(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const session = await run.store.get(run.target.baseUrl);
  const host = new URL(run.target.baseUrl).host;
  if (session === null) {
    // CLI pass 3: being logged out already is the state the person wanted, so an amber ! in place of a red ✗. The exit stays 1, as gh's does.
    input.io.stderr(`${styleFor(input.io, 'stderr', input.values).warning(`You weren't logged in to ${host}, so there was nothing to log out of.`)}\n`);
    return 1;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const done = () => run.print(out.success(`Logged out of ${out.bold(host)}.`));
  run.adopt(session);
  let edition;
  try {
    edition = await run.targetEdition();
  } catch (error) {
    run.warn(`Siren did not confirm the sign-out: ${messageOf(error)} This machine forgets the session anyway.`);
    await run.store.remove(run.target.baseUrl);
    done();
    return 0;
  }
  try {
    assertSessionMatches(run.target, session, edition);
  } catch (mismatch) {
    await run.store.remove(run.target.baseUrl);
    run.print(out.success(`Forgot the session for ${out.bold(host)} on this machine. ${messageOf(mismatch)}`));
    return 0;
  }
  try {
    await run.auth.logout(session.accessToken, session.refreshToken);
  } catch (error) {
    run.warn(`Siren did not confirm the sign-out: ${messageOf(error)} This machine forgets the session anyway.`);
  }
  await run.store.remove(run.target.baseUrl);
  done();
  return 0;
}

/**
 * `siren whoami [--json]`: which credential the commands use, who it acts
 * as, in which organization and role, and whether that Siren is a sandbox
 * or live. With SIREN_TOKEN set, that is the token, which wins over
 * credentials.json: it reads the edition and `GET /personal-tokens/current`
 * and names the token by its name and last four characters. Otherwise it
 * reads credentials.json only, sends nothing, and exits 1 when no session is
 * kept for that Siren. Never prints a token.
 */
export async function whoami(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const token = tokenFrom(input.io.env);
  if (token !== undefined) return whoamiToken(run, token, input.values.json === true);
  const session = await run.store.get(run.target.baseUrl);
  if (session === null) throw await notSignedIn(run.store, run.target, run.command('login'));
  const edition = session.edition === 'production' ? 'live' : 'sandbox';
  if (input.values.json === true) {
    run.print(
      JSON.stringify(
        {
          source: 'session',
          email: session.email,
          org: { id: session.orgId, name: session.orgName, slug: session.orgSlug ?? null },
          role: session.role,
          baseUrl: run.target.baseUrl,
          edition,
          sessionFile: run.store.path,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const out = styleFor(input.io, 'stdout', input.values);
  const others = (session.memberships ?? []).filter((membership) => membership.orgId !== session.orgId).map((membership) => clean(membership.orgSlug || String(membership.orgId)));
  const rows: Array<readonly [string, string]> = [
    ['Org', `${clean(session.orgName)} (${session.orgSlug ? clean(session.orgSlug) : session.orgId}) · ${clean(session.role)}`],
    ...(others.length > 0 ? [['Also in', others.join(', ')] as const] : []),
    ['Siren', sirenRow(out, run.target.baseUrl, edition)],
    ['Session', run.store.path],
  ];
  run.print(out.report({ headline: `Logged in as ${out.bold(clean(session.email))}`, rows }).replace(/\n$/, ''));
  return 0;
}

/** `whoami` with SIREN_TOKEN set: what Siren says about the token, which no command line flag hides. */
async function whoamiToken(run: CommandContext, token: string, json: boolean): Promise<number> {
  const edition = (await run.targetEdition()) === 'production' ? 'live' : 'sandbox';
  let about: PersonalToken;
  try {
    about = await run.auth.personalToken(token);
  } catch (error) {
    throw tokenRefusal(error, run.command('login')) ?? error;
  }
  const expires = about.expiresAt === null ? null : about.expiresAt.slice(0, 10);
  if (json) {
    run.print(
      JSON.stringify(
        {
          source: 'SIREN_TOKEN',
          email: about.user.email,
          org: { id: about.org.orgId, name: about.org.orgName, slug: about.org.orgSlug || null },
          role: about.user.role,
          baseUrl: run.target.baseUrl,
          edition,
          token: { id: about.id, name: about.name, lastFour: about.lastFour, expiresAt: about.expiresAt },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const out = styleFor(run.io, 'stdout', {});
  const slug = about.org.orgSlug ? ` (${clean(about.org.orgSlug)})` : '';
  const rows: Array<readonly [string, string]> = [
    ['Token', `ending ${clean(about.lastFour)}, ${expires === null ? 'never expires' : `expires ${clean(expires)}`}`],
    ['User', `${clean(about.user.email)}${about.user.role ? ` · ${clean(about.user.role)}` : ''}`],
    ['Org', `${clean(about.org.orgName)}${slug}`],
    ['Siren', sirenRow(out, run.target.baseUrl, edition)],
  ];
  run.print(
    out.report({ headline: `Using SIREN_TOKEN "${out.bold(clean(about.name))}"`, rows, tips: ['SIREN_TOKEN wins over the session file while it is set.'] }).replace(/\n$/, ''),
  );
  return 0;
}


/** `siren orgs`: the organizations the person belongs to, as an aligned table. Each command picks one with --org, SIREN_ORG or the app file. */
export async function orgs(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  await run.signedIn({ org: false });
  const memberships = await run.withAccessToken((token) => run.auth.memberships(token));
  if (input.values.json === true) {
    run.print(JSON.stringify(memberships.map(({ orgId, orgName, orgSlug, role }) => ({ orgId, orgName, orgSlug, role })), null, 2));
    return 0;
  }
  const style = styleFor(input.io, 'stdout', input.values);
  const inUse = await run.orgInUse(memberships.map(({ orgId, orgName, orgSlug, role }) => ({ orgId, orgName, orgSlug, role })));
  const rows = memberships.map((membership) => {
    const used = membership.orgId === inUse?.orgId;
    const mark = used ? (style.rich ? style.green('●') : '*') : ' ';
    const slug = clean(membership.orgSlug);
    return [mark, used ? style.bold(slug) : slug, clean(membership.orgName), clean(membership.role)] as const;
  });
  const width = style.rich ? (input.io.screen?.size?.columns ?? 80) : Number.POSITIVE_INFINITY;
  for (const line of style.table(['', 'ORG', 'NAME', 'ROLE'], rows, width)) run.print(line);
  if (inUse === undefined && memberships.length > 1) {
    run.print('');
    run.print(style.next('Each command picks one with --org <slug>, SIREN_ORG, or "org" in siren.app.json.'));
  }
  return 0;
}

/**
 * The line a session that still waits for its address to be confirmed gets,
 * with the days Siren gives before it closes the account, or null when it
 * does not wait.
 */
export function confirmationLine(window: EmailConfirmationWindow | undefined, nowMs: number): string | null {
  if (window === undefined) return null;
  const days = window.daysUntilClosed ?? Math.max(0, Math.ceil((window.deadline - nowMs / 1000) / 86400));
  return `Confirm your address from the email Siren sent. Siren closes the account in ${days} ${days === 1 ? 'day' : 'days'} if nobody confirms it.`;
}

/**
 * The one line Siren's sign-in refusals get: an address to confirm, or a
 * plan to choose or renew, with `login` the `siren login` line for this
 * Siren. Any other error is answered as it is, so a wrong password shows
 * Siren's own message.
 */
function signInRefusal(error: unknown, login: string, baseUrl: string, browser = false): unknown {
  const code = error instanceof SirenError ? error.code : undefined;
  if (code === 'email_unconfirmed') {
    return new CliRefusal("Your email address isn't confirmed yet.", {
      why: 'Siren logs you in once you confirm it.',
      fixLead: 'Open the email Siren sent to your inbox, confirm the address, then run',
      fix: login,
      fixWords: 'again',
    });
  }
  // CLI pass 3, must-fix 4: a Siren without browser sign-in answers POST /auth/cli/code with 404.
  if (browser && error instanceof SirenError && error.statusCode === 404) {
    return new CliRefusal(`${hostName(baseUrl)} doesn't offer browser login yet.`, {
      why: 'It has no browser sign-in yet. Log in with your email and password.',
      fix: login.replace(/^siren login/, 'siren login --password'),
      detail: httpDetail(error, baseUrl),
    });
  }
  const plan = planRefusal(code, login);
  if (plan !== undefined) return plan;
  if (error instanceof SirenError && error.statusCode === 401) {
    // Siren's own words say two things in one line (catalog mockup 4), so the tool splits them.
    return new CliRefusal("Siren didn't accept that email and password.", {
      why: 'Either is wrong, or this account has no password yet.',
      fixLead: 'Check your inbox for the set-up email, or run',
      fix: login,
      fixWords: 'again',
      detail: httpDetail(error, baseUrl),
    });
  }
  return error;
}

/**
 * Refuses, before anything is sent, a command run with no terminal that
 * would need to ask for one of these flags. Each pair is the value given
 * and the flag to name.
 */
function needsFlags(io: CliIo, flags: ReadonlyArray<readonly [unknown, string]>): void {
  if (io.interactive) return;
  const missing = flags.filter(([value]) => value === undefined).map(([, flag]) => flag);
  if (missing.length > 0) throw new CliUsageError(`Pass ${missing.join(' and ')}, since there is no terminal to ask in.`);
}

/** A string option's value, or undefined. */
function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An error's message without the SDK's `Siren: ` prefix. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Siren: /, '');
}

/** The Siren as a person reads it: its host and edition, with live in amber, since live is the one that makes a change risky. */
function sirenRow(out: Style, baseUrl: string, edition: string): string {
  return `${new URL(baseUrl).host} · ${edition === 'live' ? out.amber('live') : 'sandbox'}`;
}
