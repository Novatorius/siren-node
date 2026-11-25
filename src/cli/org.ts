import { readFile } from 'node:fs/promises';
import { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
import { Siren, createHttpTransport } from '../client';
import type { HttpTransport } from '../http';
import type { CommandContext, CommandInput } from './context';
import type { StoredMembership, StoredSession } from './credentials';
import type { CliIo } from './io';
import { clean } from './style';
import { CliRefusal } from './targets';

/*
 * Which organization a command acts in, under Alex's organization model
 * (M113, 2026-11-24). Login logs in the person and keeps every membership.
 * Each command takes --org, then SIREN_ORG, then "org" in siren.app.json,
 * then the person's only organization. With none of those it asks in a
 * terminal and refuses elsewhere with the list.
 *
 * Acting in another organization than the stored session's takes a token
 * from POST /auth/switch-org that lasts only for this run, so the stored
 * session never changes and two folders can act in two organizations at
 * once. `CommandContext.signedIn` resolves the organization for every
 * command. `orgScope` hands a command the result with clients that carry
 * its token, and takes a name of its own, as `sandbox create --from` does.
 */

/** Where the organization's name came from: --org, SIREN_ORG, "org" in the app file, the person's only one, or the terminal question. */
export type OrgSource = 'flag' | 'env' | 'file' | 'only' | 'asked';

/** A name for the organization, and where it came from. `from` is how a refusal names that place: `--org`, `SIREN_ORG` or the app file's name. */
export interface OrgWanted {
  name: string;
  source: 'flag' | 'env' | 'file';
  from: string;
}

/** The organization a command acts in, and where its name came from. */
export interface OrgChoice {
  org: StoredMembership;
  source: OrgSource;
}

/** The organization a command acts on, and the clients that carry its token. */
export interface OrgScope {
  orgId: number;
  orgSlug: string;
  orgName: string;
  source: OrgSource;
  /** For routes the SDK has no resource for, such as the sandbox and recipe routes. */
  http: HttpTransport;
  /** For the app routes. */
  siren(): Siren;
  /** ` --org <slug>` when the person named it with the flag, for a command line in a hint, else empty. */
  flag: string;
}

/** The organization the person named, by `--org` or `SIREN_ORG`, or undefined. The app file's "org" is {@link orgWanted}'s to read. */
export function orgNamed(input: CommandInput): { name: string; source: 'flag' | 'env' } | undefined {
  const flag = input.values.org;
  if (typeof flag === 'string' && flag.trim() !== '') return { name: flag.trim(), source: 'flag' };
  const env = input.io.env.SIREN_ORG;
  if (env !== undefined && env.trim() !== '') return { name: env.trim(), source: 'env' };
  return undefined;
}

/** What names the organization: `flag`, then SIREN_ORG, then "org" in the app file at `appFile`. Undefined when none does. Sends nothing. */
export async function orgWanted(flag: string | undefined, env: NodeJS.ProcessEnv, appFile: { path: string; shown: string }): Promise<OrgWanted | undefined> {
  if (flag !== undefined && flag.trim() !== '') return { name: flag.trim(), source: 'flag', from: '--org' };
  const fromEnv = env.SIREN_ORG;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { name: fromEnv.trim(), source: 'env', from: 'SIREN_ORG' };
  const fromFile = await orgInFile(appFile.path);
  return fromFile === undefined ? undefined : { name: fromFile, source: 'file', from: appFile.shown };
}

/**
 * What `memberships` settle for `wanted`, sending nothing: the organization
 * and where its name came from, `missing` when the name is not among them,
 * or `several` when nothing names one and there is more than one.
 */
export function orgFrom(memberships: readonly StoredMembership[], wanted: OrgWanted | undefined): OrgChoice | 'missing' | 'several' {
  if (wanted !== undefined) {
    const found = findOrg(memberships, wanted.name);
    return found === undefined ? 'missing' : { org: found, source: wanted.source };
  }
  if (memberships.length === 1) return { org: memberships[0]!, source: 'only' };
  return 'several';
}

/**
 * The organization a command acts in, from the person's `memberships`:
 * the one `wanted` names, else the only one, else the one they pick when
 * asked in a terminal. Refuses a name they are not in, and several with no
 * terminal, naming each. `list` is the command a refusal names to list them.
 */
export async function settleOrg(io: CliIo, memberships: readonly StoredMembership[], wanted: OrgWanted | undefined, list: string): Promise<OrgChoice> {
  const settled = orgFrom(memberships, wanted);
  if (settled === 'missing') {
    throw new CliRefusal(`You're not in an organization named ${wanted!.name}.`, {
      why: `${wanted!.source === 'file' ? `"org" in ${wanted!.from}` : wanted!.from} names it. Yours: ${orgList(memberships)}.`,
      fix: list,
      fixWords: 'to list them',
    });
  }
  if (settled !== 'several') return settled;
  if (!io.interactive) {
    throw new CliRefusal(`You belong to ${memberships.length} organizations, and nothing names one.`, {
      why: `With no terminal to ask in, the tool needs a name. Yours: ${orgList(memberships)}.`,
      fixText: 'Pick one with --org <slug>, SIREN_ORG, or "org" in siren.app.json.',
    });
  }
  return { org: await askOrg(io, memberships), source: 'asked' };
}

/**
 * The organization `words` (such as `sandbox reset`) acts on, with clients
 * that carry its token. With no `name` it is the one `run.signedIn()`
 * already resolved, at no cost. `name`, when given, takes the place of the
 * whole order, as `sandbox create --from` does on the live Siren, and costs
 * `POST /auth/switch-org` when it is not the organization in use, plus
 * `GET /auth/memberships` when login kept no list or the list lacks it.
 * `list` is the command a refusal names, `orgs` unless given.
 */
export async function orgScope(
  run: CommandContext,
  input: CommandInput,
  session: StoredSession,
  words: string,
  options: { name?: string; list?: string } = {},
): Promise<OrgScope> {
  const list = run.command(options.list ?? 'orgs');
  if (options.name === undefined) {
    const chosen = run.orgChoice ?? (await run.chooseOrg(list));
    const org = chosen.org;
    return { ...ownScope(run, org), source: chosen.source, flag: chosen.source === 'flag' ? ` --org ${org.orgSlug || org.orgId}` : '' };
  }
  const wanted: OrgWanted = { name: options.name, source: 'flag', from: `siren ${words}` };
  let memberships = membershipsOf(session);
  if (session.memberships === undefined || findOrg(memberships, wanted.name) === undefined) memberships = await run.memberships();
  const { org } = await settleOrg(input.io, memberships, wanted, list);
  const flag = ` --org ${org.orgSlug || org.orgId}`;
  if (org.orgId === run.current().orgId) return { ...ownScope(run, org), source: 'flag', flag };
  return { ...(await borrowOrg(run, org)), source: 'flag', flag };
}

/** The organization in use, with the run's own clients. */
function ownScope(run: CommandContext, org: StoredMembership): Omit<OrgScope, 'source' | 'flag'> {
  return {
    orgId: org.orgId,
    orgSlug: org.orgSlug || String(org.orgId),
    orgName: org.orgName,
    http: createHttpTransport({
      accessToken: new CallbackAccessTokenSource(
        () => run.accessToken(),
        () => run.refresh(),
      ),
      httpClient: run.io.httpClient,
      baseUrl: run.target.baseUrl,
    }),
    siren: () => run.siren(),
  };
}

/**
 * Clients for another of the person's organizations, on a token Siren
 * issues for it now. The token and its refresh stay in memory for this run,
 * so the stored session keeps its own organization.
 */
export async function borrowOrg(run: CommandContext, org: StoredMembership): Promise<Omit<OrgScope, 'source' | 'flag'>> {
  let tokens = await run.withAccessToken((token) => run.auth.switchOrg(token, org.orgId));
  const accessToken = new CallbackAccessTokenSource(
    async () => tokens.accessToken,
    async () => {
      tokens = await run.auth.refresh(tokens.refreshToken);
      return tokens.accessToken;
    },
  );
  return {
    orgId: org.orgId,
    orgSlug: org.orgSlug || String(org.orgId),
    orgName: org.orgName,
    http: createHttpTransport({ accessToken, httpClient: run.io.httpClient, baseUrl: run.target.baseUrl }),
    siren: () => new Siren({ accessToken, httpClient: run.io.httpClient, baseUrl: run.target.baseUrl }),
  };
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
  const names = memberships.map((membership) => `${clean(membership.orgSlug) || membership.orgId} (${clean(membership.orgName)})`);
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
  for (const membership of memberships) io.stderr(`  ${clean(membership.orgSlug)}  ${clean(membership.orgName)}\n`);
  const typed = (await io.prompt('Organization (slug): ')).trim();
  const chosen = findOrg(memberships, typed);
  if (chosen === undefined) {
    throw new CliRefusal(`You're not in an organization named ${clean(typed)}.`, { why: `Yours: ${orgList(memberships)}.`, fixText: 'Run the command again and type one of those.' });
  }
  return chosen;
}
