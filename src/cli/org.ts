import { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
import { Siren, createHttpTransport } from '../client';
import type { HttpTransport } from '../http';
import type { CommandContext, CommandInput } from './context';
import type { StoredSession } from './credentials';
import type { Membership } from './session-auth';
import { hostOf, transportOf } from './sandboxes';
import { CliRefusal } from './targets';

/*
 * Which organization a sandbox command acts on, under Alex's organization
 * model (M113): `--org`, then `SIREN_ORG`, then the person's only
 * organization. Sign-in is per person, so nothing here changes the stored
 * session. Acting on another organization takes a token for it, which lasts
 * only for this run.
 *
 * This stands in for the resolver the CLI builder is writing on
 * pkt/apps-cli-dx. When that lands, `orgScope` calls it for the
 * organization and keeps the rest. `"org"` in siren.app.json is the
 * resolver's to read.
 */

/** Where the organization's name came from. */
export type OrgSource = 'flag' | 'env' | 'only';

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

/** The organization the person named, by `--org` or `SIREN_ORG`, or undefined. */
export function orgNamed(input: CommandInput): { name: string; source: 'flag' | 'env' } | undefined {
  const flag = input.values.org;
  if (typeof flag === 'string' && flag.trim() !== '') return { name: flag.trim(), source: 'flag' };
  const env = input.io.env.SIREN_ORG;
  if (env !== undefined && env.trim() !== '') return { name: env.trim(), source: 'env' };
  return undefined;
}

/** True when `name` is the organization's slug or id. */
function names(name: string, org: { orgId: number; orgSlug?: string }): boolean {
  return name === org.orgSlug || name === String(org.orgId);
}

/**
 * The organization `words` (such as `sandbox reset`) acts on. `name`, when
 * given, takes the place of `--org` and `SIREN_ORG`, as `sandbox create
 * --from` does on the live Siren. `list` is the command a refusal names to
 * show the person's organizations, `sandbox list` unless given. The session's own organization costs no
 * request. Any other costs `GET /auth/memberships` and `POST
 * /auth/switch-org`. A name the person is not in, or several organizations
 * and no name, is refused before anything else is sent.
 */
export async function orgScope(
  run: CommandContext,
  input: CommandInput,
  session: StoredSession,
  words: string,
  options: { name?: string; list?: string } = {},
): Promise<OrgScope> {
  const named = options.name === undefined ? orgNamed(input) : { name: options.name, source: 'flag' as const };
  const list = run.command(options.list ?? 'sandbox list');
  const host = hostOf(run.target.baseUrl);
  // The session's own organization, named as Siren lists it when the list was read, since an older session keeps no slug.
  const own = (source: OrgSource, listed?: Membership): OrgScope => {
    const orgSlug = listed?.orgSlug ?? session.orgSlug ?? String(session.orgId);
    return {
      orgId: session.orgId,
      orgSlug,
      orgName: listed?.orgName ?? session.orgName,
      source,
      http: transportOf(run),
      siren: () => run.siren(),
      flag: source === 'flag' ? ` --org ${orgSlug}` : '',
    };
  };
  if (named !== undefined && names(named.name, session)) return own(named.source);

  const memberships = await run.withAccessToken((token) => run.auth.memberships(token));
  let org: Membership | undefined;
  if (named !== undefined) {
    org = memberships.find((one) => names(named.name, one));
    if (org === undefined) {
      throw new CliRefusal(`You are not in an organization called ${named.name} on ${host}.`, {
        why: `${named.source === 'env' ? 'SIREN_ORG names it' : 'Nothing was sent to it'}.`,
        fix: list,
        fixWords: 'to see the ones you are in',
      });
    }
  } else if (memberships.length === 1) {
    org = memberships[0]!;
  } else {
    throw new CliRefusal(`You are in ${memberships.length} organizations on ${host}, so siren ${words} needs one named.`, {
      why: 'Pass --org <slug>, or set SIREN_ORG. Nothing was sent.',
      fix: list,
      fixWords: 'to see their slugs',
    });
  }
  const source: OrgSource = named?.source ?? 'only';
  if (org.orgId === session.orgId) return own(source, org);
  return { ...(await borrowOrg(run, org)), source, flag: source === 'flag' ? ` --org ${org.orgSlug}` : '' };
}

/**
 * Clients for another of the person's organizations, on a token Siren
 * issues for it now. The token and its refresh stay in memory for this run,
 * so the stored session keeps its own organization.
 */
export async function borrowOrg(run: CommandContext, org: Membership): Promise<Omit<OrgScope, 'source' | 'flag'>> {
  let tokens = await run.withAccessToken((token) => run.auth.switchOrg(token, org.orgId));
  const accessToken = new CallbackAccessTokenSource(
    async () => tokens.accessToken,
    async () => {
      tokens = await run.auth.refresh(tokens.refreshToken);
      return tokens.accessToken;
    },
  );
  const http = createHttpTransport({ accessToken, httpClient: run.io.httpClient, baseUrl: run.target.baseUrl });
  return {
    orgId: org.orgId,
    orgSlug: org.orgSlug,
    orgName: org.orgName,
    http,
    siren: () => new Siren({ accessToken, httpClient: run.io.httpClient, baseUrl: run.target.baseUrl }),
  };
}
