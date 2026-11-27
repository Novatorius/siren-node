/*
 * Where a record opens in Siren Cloud's app. One map, RECORD_PAGES, gives
 * the page of each record type, and every link the tool prints is built from
 * it: `siren open`, the last line of a record view, the `url` in a record's
 * --json, and each line of `siren activity` and `siren explain`. Each path
 * is a route in the app's router, frontend/src/platform/saas/App.tsx in the
 * Siren repository, and test/cli-links.test.ts checks every one against a
 * copy of that router's routes. A record opens on its read-only view, never
 * on its editor.
 */

/** A record's page in the app, by record type. `{id}` is the record's id. */
export const RECORD_PAGES: Readonly<Record<string, string>> = {
  collaborator: '/collaborators/{id}/view',
  program: '/programs/{id}/view',
  program_group: '/program-groups/{id}/view',
  collaborator_group: '/collaborator-groups/{id}/view',
  distributor: '/distributors/{id}/view',
  conversion: '/conversions/{id}',
  transaction: '/transactions/{id}',
  obligation: '/obligations/{id}',
  engagement: '/engagements/{id}',
  fulfillment: '/fulfillments/{id}',
  customer: '/customers/{id}',
  condition_set: '/condition-sets/{id}/view',
  enroller: '/enrollers/{id}',
  event: '/events/{id}',
};

/**
 * Records with no page of their own, which open on the list that holds
 * them. A payout shows inside its fulfillment, so {@link recordPath} opens
 * that fulfillment when it knows it. An application opens on the
 * applications list, and the organization on the app's home.
 */
export const LIST_PAGES: Readonly<Record<string, string>> = {
  payout: '/fulfillments',
  application: '/applications',
  org: '/',
};

/** Other words a person types for a type, such as `sale` for a transaction. */
const ALIASES: Readonly<Record<string, string>> = { sale: 'transaction', reward: 'obligation' };

/**
 * Every type `siren open` takes. An event is left out: Siren has no route
 * that reads one, so open couldn't check that it exists.
 */
export const OPEN_TYPES: readonly string[] = [...Object.keys(RECORD_PAGES).filter((type) => type !== 'event'), 'payout', 'application'];

/**
 * The record type a word names, or undefined: `collaborator`, the resource
 * word `collaborators`, `collaborator-group` or `collaborator_groups`, and
 * `sale` for a transaction.
 */
export function recordTypeOf(word: string): string | undefined {
  const given = word.trim().toLowerCase().replace(/-/g, '_');
  const one = given.endsWith('ies') ? `${given.slice(0, -3)}y` : given.endsWith('s') && !given.endsWith('ss') ? given.slice(0, -1) : given;
  for (const candidate of [given, one]) {
    const type = ALIASES[candidate] ?? candidate;
    if (type in RECORD_PAGES || type in LIST_PAGES) return type;
  }
  return undefined;
}

/** The record type a generated resource's records are, such as `collaborator_group` for `collaborator-groups`, or undefined. */
export function resourceTypeOf(resource: string): string | undefined {
  const type = recordTypeOf(resource);
  return type === undefined || type === 'org' ? undefined : type;
}

/**
 * The path of a record's page, or of the list that holds it. A payout with
 * a known fulfillment opens on that fulfillment.
 */
export function recordPath(type: string, id: string | number, options: { fulfillmentId?: unknown } = {}): string {
  if (type === 'payout') {
    const fulfillment = options.fulfillmentId;
    if ((typeof fulfillment === 'number' || typeof fulfillment === 'string') && /^\d+$/.test(String(fulfillment)) && Number(fulfillment) > 0) {
      return recordPath('fulfillment', String(fulfillment));
    }
    return LIST_PAGES.payout!;
  }
  const page = RECORD_PAGES[type];
  // Only a plain id goes into an address. Anything else opens the list the record is on.
  if (page !== undefined) return /^\d+$/.test(String(id)) ? page.replace('{id}', String(id)) : page.slice(0, page.indexOf('/{id}'));
  return LIST_PAGES[type] ?? '/';
}

/**
 * Siren's app address for an API address: `SIREN_DASHBOARD_URL` when set, else
 * the API's own origin, with `api.` in front of the host read as `app.`,
 * since Siren Cloud serves its API on api.sirenaffiliates.com and its app
 * on app.sirenaffiliates.com. The sandbox and the previews serve both on one
 * host.
 */
export function appOrigin(baseUrl: string, env: Readonly<Record<string, string | undefined>>): string {
  // Not SIREN_APP_URL, which names the app's handler in siren.app.json (review round 1).
  const set = env.SIREN_DASHBOARD_URL?.trim();
  if (set !== undefined && set !== '') return set.replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`;
  return url.origin;
}

/** Where the organization's page for a path opens: the app's address, the path, and `?org=<slug>`, which switches the app to that organization. */
export function appLink(baseUrl: string, env: Readonly<Record<string, string | undefined>>, org: string, path: string): string {
  return `${appOrigin(baseUrl, env)}${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(org)}`;
}

/** One record's page in the app, in the organization `org` names. */
export function recordLink(baseUrl: string, env: Readonly<Record<string, string | undefined>>, org: string, type: string, id: string | number, options: { fulfillmentId?: unknown } = {}): string {
  return appLink(baseUrl, env, org, recordPath(type, id, options));
}
