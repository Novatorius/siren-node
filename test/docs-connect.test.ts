import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Slice 5 acceptance tests for packet P7: the reference docs describe the
 * connected-site surface. The README, the CHANGELOG's Unreleased section and
 * openapi.yaml are what a caller reads, so each new entry, class, method and
 * route must appear there.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` or `it.skip.each(` belongs to
 * the packet named in its describe block. That packet's implementer deletes
 * the `.skip` from every one of its own tests, so `it.skip(` becomes `it(` and
 * `it.skip.each(` becomes `it.each(`. The packet that removes the last
 * `.skip` in this file deletes this paragraph too. Nothing else here changes.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

/** The text from a heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.split(' ')[0]!;
  const rest = markdown.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Sentences, split on a full stop followed by white space. */
function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').split(/(?<=\.)\s/);
}

/** One path block in openapi.yaml, from its key to the next path. */
function path(openapi: string, key: string): string {
  const start = openapi.indexOf(`\n  ${key}:\n`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = openapi.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\/|\n\S/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** One operation inside a path block, from its method to the next method. */
function operation(block: string, method: string): string {
  const start = block.indexOf(`\n    ${method}:\n`);
  expect(start, method).toBeGreaterThan(-1);
  const rest = block.slice(start + 1);
  const next = rest.slice(1).search(/\n {4}[a-z]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The scopes listed for connectorToken in one operation, or null when it has none. */
function connectorScopes(op: string): string[] | null {
  const match = op.match(/- connectorToken: \[([^\]]*)\]/);
  if (match === null) return null;
  return match[1]!
    .split(',')
    .map((scope) => scope.trim().replace(/^['"]|['"]$/g, ''))
    .filter((scope) => scope !== '');
}

const CONNECT_ROUTES: Array<[string, string, string]> = [
  ['/connect/plan', 'get', 'connect:read'],
  ['/connect/update-grant', 'post', 'connect:read'],
  ['/connect/site-state', 'put', 'connect:read'],
  ['/connect/disconnect', 'post', 'connect:read'],
  ['/connect/integrations', 'put', 'connect:records:write'],
  ['/connect/products', 'put', 'connect:records:write'],
  ['/connect/migration-window', 'get', 'connect:migrate'],
  ['/connect/customer-email-key', 'get', 'connect:records:read'],
  ['/connect/webhook', 'put', 'connect:webhooks'],
  ['/connect/webhook', 'get', 'connect:webhooks'],
  ['/connect/webhook', 'delete', 'connect:webhooks'],
  ['/connect/webhook/test', 'post', 'connect:webhooks'],
  ['/connect/webhook/deliveries', 'get', 'connect:webhooks'],
];

describe('P7: openapi.yaml', () => {
  it.skip.each(CONNECT_ROUTES)('documents %s %s for a connected site holding %s', (key, method, scope) => {
    const op = operation(path(read('openapi.yaml'), key), method);

    expect(op).toMatch(/operationId: \w+/);
    expect(connectorScopes(op)).toEqual([scope]);
    expect(op).not.toMatch(/- apiKey:/);
    expect(op).toMatch(/'2\d\d':/);
    expect(op).toMatch(/'401':/);
    expect(op).toMatch(/'403':/);
  });

  it.skip.each([
    ['/oauth/register', ['client_name', 'redirect_uris', 'scope', 'software_id'], "'201':"],
    ['/oauth/token', ['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier', 'refresh_token', 'attempt_id'], "'200':"],
  ])('documents POST %s as public, with its body fields and the OAuth error envelope', (key, fields, success) => {
    const op = operation(path(read('openapi.yaml'), key), 'post');

    expect(op).toMatch(/\n {6}security: \[\]\n/);
    for (const field of fields) expect(op, field).toMatch(new RegExp(`\\b${field}:`));
    expect(op).toContain(success);
    expect(op).toMatch(/'400':/);
    expect(op).toContain('error_description');
  });

  it.skip('documents the forwarded event envelope as a schema, and the event route takes it with connect:ingest and the final attempt header', () => {
    const openapi = read('openapi.yaml');
    const schemaStart = openapi.indexOf('\n    ForwardedEventEnvelope:\n');
    expect(schemaStart).toBeGreaterThan(-1);
    const schema = openapi.slice(schemaStart, schemaStart + 3000);
    expect(schema).toMatch(/required: \[version, eventId, origin, occurredAt, data\]/);

    const op = operation(path(openapi, '/event/{eventSlug}'), 'post');
    expect(op).toContain("$ref: '#/components/schemas/ForwardedEventEnvelope'");
    expect(connectorScopes(op)).toEqual(['connect:ingest']);
    expect(op).toContain('X-Siren-Final-Attempt');
  });
});

describe('P7: README', () => {
  it.skip('has a Connected sites section that names the entry, the OAuth helpers, the client and events.forward', () => {
    const connected = section(read('README.md'), '## Connected sites');

    for (const name of [
      '@novatorius/siren/connect',
      'OAuthClient',
      'createCodeVerifier',
      'createState',
      'codeChallengeS256',
      'authorizeUrl',
      'exchangeCode',
      'refresh',
      'SirenConnect',
      'ConnectorSoftware',
      'events.forward',
    ]) {
      expect(connected, name).toContain(name);
    }
  });

  it.skip('says a refresh is sent once and never retried, that a retry reuses attemptId, and that the store keeps the tokens', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(
      all.some((s) => /\brefresh\b/i.test(s) && /\b(?:sent|sends) (?:exactly )?once\b/i.test(s) && /\bnever retrie[sd]\b|\bnot retried\b/i.test(s)),
      'a sentence says a refresh is sent once and never retried',
    ).toBe(true);
    expect(
      all.some((s) => /`attemptId`/.test(s) && /\bsame\b/i.test(s)),
      'a sentence says a retry sends the same attemptId',
    ).toBe(true);
    expect(
      all.some((s) => /\b(?:SDK|it) (?:keeps|stores|holds) (?:no|nothing)\b/i.test(s) && /\b(?:store|site)\b/i.test(s)),
      'a sentence says the SDK keeps no state and the store keeps it',
    ).toBe(true);
  });

  it.skip('says the store locks its refresh, resends only within 30 seconds, and picks a random attemptId', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(
      all.some((s) => /\block(?:s|ed)?\b/i.test(s) && /\brefresh/i.test(s)),
      'a sentence says the store locks its own refresh',
    ).toBe(true);
    expect(
      all.some((s) => /\b30 seconds\b/i.test(s) && /\b(?:revoke[sd]?|family)\b/i.test(s)),
      'a sentence says a resend after 30 seconds revokes the token family',
    ).toBe(true);
    expect(
      all.some((s) => /`attemptId`/.test(s) && /\brandom\b/i.test(s)),
      'a sentence says attemptId is random',
    ).toBe(true);
  });

  it.skip("says the store checks the callback's state against the one it kept, once", () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(
      all.some((s) => /`state`/.test(s) && /\b(?:compare|match|check)/i.test(s) && /\bonce\b/i.test(s)),
      'a sentence says the callback state is checked against the kept one and used once',
    ).toBe(true);
  });

  it.skip('says events.forward is sent once and the outbox resends with the same eventId', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(
      all.some((s) => /events\.forward/.test(s) && /\b(?:sent|sends) once\b/i.test(s)),
      'a sentence says events.forward is sent once',
    ).toBe(true);
    expect(
      all.some((s) => /`eventId`/.test(s) && /\bsame\b/i.test(s) && /\b(?:outbox|queue)\b/i.test(s)),
      "a sentence says the site's outbox resends with the same eventId",
    ).toBe(true);
  });
});

describe('P7: CHANGELOG', () => {
  it.skip('names every new entry, class, method and type under Unreleased', () => {
    const changelog = read('CHANGELOG.md');
    const start = changelog.indexOf('## [Unreleased]');
    const end = changelog.indexOf('\n## [', start + 1);
    const unreleased = changelog.slice(start, end < 0 ? undefined : end);

    for (const name of [
      '`@novatorius/siren/connect`',
      '`SirenConnect`',
      '`ConnectResource`',
      '`ConnectWebhookResource`',
      '`OAuthClient`',
      '`OAuthError`',
      '`createCodeVerifier`',
      '`createState`',
      '`codeChallengeS256`',
      '`ConnectScope`',
      '`ConnectorSoftware`',
      '`events.forward`',
      '`ForwardedEventSlug`',
      '`ForwardedEventEnvelope`',
    ]) {
      expect(unreleased, name).toContain(name);
    }
  });
});
