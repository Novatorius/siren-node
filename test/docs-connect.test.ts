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

/**
 * One piece of security advice the README must give. `says` matches a
 * sentence that gives it, in any natural wording, negations included.
 * `refuses` matches a sentence that undoes it, such as one that makes the
 * lock optional. The README gives the advice when some sentence says it and
 * no sentence refuses it.
 */
interface Advice {
  says: (sentence: string) => boolean;
  refuses: (sentence: string) => boolean;
}

const ADVICE = {
  lock: {
    says: (s) => /\block(?:s|ed)?\b/i.test(s) && /\brefresh/i.test(s),
    refuses: (s) =>
      /\b(?:no|without|skips?|skipping|optional|needs? not|needn't|unnecessary)\b[^.]{0,40}\block/i.test(s) ||
      /\block\b[^.]{0,40}\b(?:is optional|is unnecessary|is not needed|isn't needed)\b/i.test(s),
  },
  window: {
    says: (s) => /\b30 seconds\b/i.test(s) && /\b(?:revoke[sd]?|family)\b/i.test(s),
    refuses: (s) => /\b(?:after|past|beyond|more than) 30 seconds\b[^.]{0,60}\b(?:is safe|is harmless|is fine|is allowed)\b/i.test(s),
  },
  randomAttemptId: {
    says: (s) => /`attemptId`/.test(s) && /\brandom\b/i.test(s),
    refuses: (s) =>
      /\b(?:need not|needn't|does not need to|doesn't need to) be random\b/i.test(s) ||
      /`attemptId`[^.]{0,40}\b(?:may|can|could) be (?:a |the )?(?:counter|sequence|timestamp|fixed)/i.test(s),
  },
  state: {
    says: (s) => /`state`/.test(s) && /\b(?:compare|match|check)/i.test(s) && /\bonce\b/i.test(s),
    refuses: (s) =>
      /`state`[^.]{0,60}\b(?:is optional|may be skipped|need not be checked|needn't be checked)\b/i.test(s) ||
      /\b(?:checking|comparing) `state` is optional\b|\b(?:skip|no need to check)\b[^.]{0,40}`state`/i.test(s),
  },
  verifyWebhooks: {
    says: (s) => (/`constructEvent`|constructEvent\(/.test(s)) && /\bsigning secret\b|`signingSecret`/i.test(s) && /\bverif/i.test(s),
    refuses: (s) =>
      /\b(?:skip|optional|need not|needn't|no need to)\b[^.]{0,40}\bverif/i.test(s) || /\bverif\w*[^.]{0,40}\b(?:is optional|optional)\b/i.test(s),
  },
  noSecretsInLogs: {
    says: (s) =>
      /\bcustomer email key\b|`customerEmailKey`/i.test(s) &&
      /\bsigning secret\b|`signingSecret`/i.test(s) &&
      /\b(?:never|don't|do not)\s+(?:log|print)\b|\bout of (?:every |all )?(?:logs?|error reports?)\b/i.test(s),
    refuses: (s) =>
      /\b(?:customer email key|signing secret|token pair|tokens?)\b|`(?:customerEmailKey|signingSecret)`/i.test(s) &&
      /\b(?:safe to|fine to|may|can) (?:be )?(?:log|logged|print|printed)\b/i.test(s),
  },
} satisfies Record<string, Advice>;

/** Whether the sentences give the advice: one says it and none refuses it. */
function advises(all: string[], advice: Advice): boolean {
  return all.some(advice.says) && !all.some(advice.refuses);
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

// The advice checks themselves, run now: each takes advice worded with a
// natural negation and turns down advice that undoes it.
describe('README advice checks', () => {
  it.each([
    ['lock', ['The store takes its own lock around each refresh, so two refreshes never race.'], true],
    ['lock', ['The store takes its own lock around each refresh.', 'The store may skip the lock on refresh when it runs one worker.'], false],
    ['lock', ['A refresh needs no lock.'], false],
    ['window', ['Never resend a refresh after 30 seconds, or Cloud revokes the family.'], true],
    ['window', ['Never resend a refresh after 30 seconds, or Cloud revokes the family.', 'A resend after 30 seconds is safe when the first try timed out.'], false],
    ['randomAttemptId', ['Make `attemptId` a fresh random value for each refresh, not a counter.'], true],
    ['randomAttemptId', ['`attemptId` need not be random.'], false],
    ['randomAttemptId', ['Give `attemptId` a random value.', '`attemptId` may be a counter.'], false],
    ['state', ['Refuse a `state` that does not match the one you kept, and use it once.'], true],
    ['state', ['Refuse a `state` that does not match the one you kept, and use it once.', 'Checking `state` is optional on a trusted network.'], false],
    ['verifyWebhooks', ['Verify every delivery with `constructEvent` and the signing secret, and never trust an unsigned one.'], true],
    ['verifyWebhooks', ['Verify every delivery with `constructEvent` and the signing secret.', 'Verification is optional for deliveries from Cloud.'], false],
    ['noSecretsInLogs', ['Never log the customer email key, the signing secret or the token pair.'], true],
    ['noSecretsInLogs', ['Never log the customer email key or the signing secret.', 'The token pair is safe to log at debug level.'], false],
  ] as const)('%s on %j gives %s', (rule, all, expected) => {
    expect(advises([...all], ADVICE[rule])).toBe(expected);
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

  it.skip("says the SDK sends a refresh once and never retries it, that the store's one resend reuses attemptId, and that the store keeps the tokens", () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(
      all.some((s) => /\brefresh\b/i.test(s) && /\b(?:sent|sends) (?:exactly )?once\b/i.test(s) && /\bnever retrie[sd]\b|\bnot retried\b/i.test(s)),
      'a sentence says a refresh is sent once and never retried',
    ).toBe(true);
    expect(
      all.some((s) => /`attemptId`/.test(s) && /\bsame\b/i.test(s)),
      "a sentence says the store's resend sends the same attemptId",
    ).toBe(true);
    expect(
      all.some((s) => /\b(?:SDK|it) (?:keeps|stores|holds) (?:no|nothing)\b/i.test(s) && /\b(?:store|site)\b/i.test(s)),
      'a sentence says the SDK keeps no state and the store keeps it',
    ).toBe(true);
  });

  it.skip('says the store locks its refresh, resends only within 30 seconds, and picks a random attemptId', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(advises(all, ADVICE.lock), 'the README says the store locks its own refresh, and nothing makes the lock optional').toBe(true);
    expect(advises(all, ADVICE.window), 'the README says a resend after 30 seconds revokes the token family').toBe(true);
    expect(advises(all, ADVICE.randomAttemptId), 'the README says attemptId is random').toBe(true);
  });

  it.skip("says the store checks the callback's state against the one it kept, once", () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(advises(all, ADVICE.state), 'the README says the callback state is checked against the kept one and used once').toBe(true);
  });

  it.skip('says what a site does on each failure the SDK leaves to it', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));
    const says = (test: (s: string) => boolean, what: string) => expect(all.some(test), what).toBe(true);

    says((s) => /`invalid_grant`/.test(s) && /`invalid_client`/.test(s) && /\bconnect(?:s|ing)? again\b|\breconnect/i.test(s), 'a sentence says invalid_grant or invalid_client on refresh means connecting again');
    says((s) => /`disconnect`/.test(s) && /\b(?:sent|sends) once\b/i.test(s) && /\b401\b/.test(s), 'a sentence says disconnect is sent once and a 401 after it means the site is disconnected');
    says((s) => /`replace`/.test(s) && /`ConnectionError`/.test(s), 'a sentence says to call replace again after a ConnectionError');
    says((s) => /`exchangeCode`/.test(s) && /`ConnectionError`/.test(s) && /\b(?:over|again from the start|new verifier)\b/i.test(s), 'a sentence says a failed exchange starts the connection over');
  });

  it.skip('says to verify every webhook delivery with constructEvent and the signing secret', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(advises(all, ADVICE.verifyWebhooks), 'the README says to verify each delivery with constructEvent and the signing secret').toBe(true);
  });

  it.skip('says never to log the customer email key or the signing secret', () => {
    const all = sentences(section(read('README.md'), '## Connected sites'));

    expect(advises(all, ADVICE.noSecretsInLogs), 'the README says never to log the customer email key or the signing secret').toBe(true);
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
