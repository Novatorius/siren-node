import { SirenError } from '../../errors';
import { PLAN_LINES, contextOf, jwtClaim } from '../context';
import type { CommandContext, CommandInput } from '../context';
import type { CliIo } from '../io';
import { PasswordSignIn, askLine, readPassword } from '../session-auth';
import type { EmailConfirmationWindow, LoginResult, Membership, SessionTokens } from '../session-auth';
import { CliRefusal, CliUsageError, assertEditionAllowed } from '../targets';

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

  const edition = await run.auth.edition();
  assertEditionAllowed(run.target, edition);

  const orgName = text(values['org-name']) ?? (await askLine(io, 'Organization name: ', '--org-name'));
  const email = text(values.email) ?? (await askLine(io, 'Email: ', '--email'));
  const accepted =
    values['accept-terms'] === true ||
    (io.interactive && /^y(es)?$/i.test((await io.prompt("Do you accept Siren's Terms of Service and Privacy Policy? (y/N) ")).trim()));
  if (!accepted) {
    throw new CliRefusal(
      "Siren makes an organization only for a person who accepts its Terms of Service and Privacy Policy. Run siren signup again with --accept-terms to accept them.",
    );
  }
  if (orgName === '' || email === '') throw new CliRefusal('Siren needs an organization name and an email address to sign up.');
  const password = await readPassword(io, passwordFromStdin);

  let registered;
  try {
    registered = await run.auth.registerOrg({ orgName, email, password, acceptTerms: true });
  } catch (error) {
    if ((error as SirenError).statusCode === 404) {
      throw new CliRefusal(`Sign-up is turned off on ${run.target.baseUrl}. Ask its owner, or use siren login.`);
    }
    throw error;
  }

  const org = registered.org;
  if (registered.tokens === null) {
    run.print(
      `Made ${org.orgName} (${org.orgSlug}) on ${run.target.baseUrl}. Siren sent a confirmation email to ${email}. ` +
        'Open it from your inbox, confirm the address, then run siren login.',
    );
    return 0;
  }

  const session = await run.keep(registered.tokens, org, edition, email);
  run.print(`Made ${org.orgName} (${org.orgSlug}) on ${run.target.baseUrl}, and signed in as ${session.email}.`);
  const pending = confirmationLine(registered.emailConfirmation ?? registered.tokens.emailConfirmation, io.now());
  if (pending !== null) run.print(pending);
  return 0;
}

/**
 * `siren login`: reads credentials.json first, as `signup` does, then reads
 * the edition, checks it against `--live`, signs in
 * with the password, and picks the organization by `--org` when the person
 * belongs to several. Keeps the session and never the verification token.
 */
export async function login(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const { io, values } = input;
  const passwordFromStdin = values['password-stdin'] === true;
  needsFlags(io, [
    [values.email, '--email <address>'],
    [passwordFromStdin || undefined, '--password-stdin'],
  ]);
  // A credentials file the tool would refuse stops the command here, before the password leaves the machine.
  await run.store.get(run.target.baseUrl);

  const edition = await run.auth.edition();
  assertEditionAllowed(run.target, edition);

  let result: LoginResult;
  try {
    result = await new PasswordSignIn().signIn(run.auth, io, { email: text(values.email), passwordFromStdin });
  } catch (error) {
    throw signInRefusal(error);
  }

  const wanted = text(values.org);
  let tokens: SessionTokens;
  let org: Membership | undefined;
  if (result.kind === 'session') {
    tokens = result.tokens;
    const orgId = jwtClaim(tokens.accessToken, 'orgId');
    org = result.memberships.find((membership) => membership.orgId === orgId) ?? result.memberships[0];
    if (org === undefined) throw new CliRefusal('Siren signed you in but named no organization. Sign in to the dashboard to check your membership.');
    if (wanted !== undefined && findOrg([org], wanted) === undefined) {
      throw new CliRefusal(`You belong only to ${org.orgName} (${org.orgSlug}). Run siren login again without --org.`);
    }
  } else {
    const memberships = result.memberships;
    const choice = wanted ?? (io.interactive ? await askOrg(run, memberships) : undefined);
    org = choice === undefined ? undefined : findOrg(memberships, choice);
    if (org === undefined) {
      throw new CliRefusal(
        `You belong to several organizations. Run siren login again with --org and one of: ${memberships.map((membership) => membership.orgSlug).join(', ')}.`,
      );
    }
    try {
      tokens = await run.auth.selectOrg(result.verificationToken, org.orgId);
    } catch (error) {
      throw signInRefusal(error);
    }
  }

  const session = await run.keep(tokens, org, edition, tokens.user.email);
  run.print(`Signed in to ${org.orgName} (${org.orgSlug}) on ${run.target.baseUrl} as ${session.email}.`);
  const pending = confirmationLine(tokens.emailConfirmation, io.now());
  if (pending !== null) run.print(pending);
  return 0;
}

/**
 * `siren logout`: revokes the access and refresh tokens with
 * `POST /auth/logout` and forgets this Siren's session, even when Siren
 * refuses. Needs no `--live`, since it sends only the session's own tokens.
 */
export async function logout(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const session = await run.store.get(run.target.baseUrl);
  if (session === null) throw new CliRefusal(`You are not signed in to ${run.target.baseUrl}.`);
  run.adopt(session);
  try {
    await run.auth.logout(session.accessToken, session.refreshToken);
  } catch (error) {
    run.warn(`Siren did not confirm the sign-out: ${messageOf(error)} This machine forgets the session anyway.`);
  }
  await run.store.remove(run.target.baseUrl);
  run.print(`Signed out of ${run.target.baseUrl}.`);
  return 0;
}

/** `siren orgs`: one line per organization, `*` on the one in use. */
export async function orgs(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const session = await run.signedIn();
  const memberships = await run.withAccessToken((token) => run.auth.memberships(token));
  for (const membership of memberships) {
    run.print(`${membership.orgId === session.orgId ? '*' : ' '} ${membership.orgSlug}  ${membership.orgName}  (id ${membership.orgId}, ${membership.role})`);
  }
  return 0;
}

/** `siren use <slug or id>`: switches the session to another of the person's organizations. */
export async function use(input: CommandInput): Promise<number> {
  const run = contextOf(input);
  const session = await run.signedIn();
  const wanted = input.args[0] ?? '';
  const memberships = await run.withAccessToken((token) => run.auth.memberships(token));
  const org = findOrg(memberships, wanted);
  if (org === undefined) {
    throw new CliRefusal(`No organization of yours is ${wanted}. Choose one of: ${memberships.map((membership) => membership.orgSlug).join(', ')}.`);
  }
  let tokens: SessionTokens;
  try {
    tokens = await run.withAccessToken((token) => run.auth.switchOrg(token, org.orgId));
  } catch (error) {
    throw signInRefusal(error);
  }
  await run.keep(tokens, org, session.edition, session.email);
  run.print(`Now using ${org.orgName} (${org.orgSlug}) on ${run.target.baseUrl}.`);
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
 * plan to choose or renew. Any other error is answered as it is, so a wrong
 * password shows Siren's own message.
 */
function signInRefusal(error: unknown): unknown {
  const code = error instanceof SirenError ? error.code : undefined;
  if (code === 'email_unconfirmed') {
    return new CliRefusal('Confirm your email address first. Open the email Siren sent from your inbox, confirm the address, then run siren login again.');
  }
  if (code !== undefined && PLAN_LINES[code] !== undefined) return new CliRefusal(PLAN_LINES[code]);
  return error;
}

/** The membership whose slug or id is `wanted`. */
function findOrg(memberships: readonly Membership[], wanted: string): Membership | undefined {
  return memberships.find((membership) => membership.orgSlug === wanted || String(membership.orgId) === wanted);
}

/** Lists the organizations on standard error and answers the slug or id typed. */
async function askOrg(run: CommandContext, memberships: readonly Membership[]): Promise<string> {
  run.warn('You belong to several organizations:');
  for (const membership of memberships) run.warn(`  ${membership.orgSlug}  ${membership.orgName}  (id ${membership.orgId})`);
  return (await run.io.prompt('Organization (slug or id): ')).trim();
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
