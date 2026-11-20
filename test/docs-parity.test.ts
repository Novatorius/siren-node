import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../src/index';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * Slice 4 acceptance tests for packet P11: the README's parity table with
 * the Siren PHP SDK. The slice is done when the table shows no PHP-only row
 * except where a difference is written down.
 *
 * PHP_SURFACE below is every public method of every resource the PHP
 * `Siren` client carries, read from siren-php's src/Resources and
 * src/Siren.php, with the Node name each one has. It is PHP 0.3.0 (siren-php
 * at 59383e6) and the seven calls the PHP SDK's next release adds, read from
 * siren-php's feat/apps. `null` marks a method the Node SDK leaves out on
 * purpose, and its row must say why.
 *
 * Every Node name in the table must exist: a `siren.` name is read from a
 * real `Siren` client built over a FakeHttpClient and the reserved base URL,
 * with the global fetch stubbed to fail, and any other name is read from the
 * package's exports. Nothing leaves the machine.
 */

beforeEach(failOnGlobalFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Each PHP method, as the table's PHP cell writes it, and the Node name, or `null` for none. */
const PHP_SURFACE: Array<[string, string | null]> = [
  ['$siren->events->sale()', 'siren.events.sale()'],
  ['$siren->events->refund()', 'siren.events.refund()'],
  ['$siren->events->siteVisited()', 'siren.events.siteVisited()'],
  ['$siren->events->ingest()', 'siren.events.ingest()'],
  ['$siren->webhooks->constructEvent()', 'siren.webhooks.constructEvent()'],
  ['$siren->webhooks->constructEventFromHeaders()', null],
  ['$siren->webhooks->verifySignature()', 'siren.webhooks.verifySignature()'],
  ['$siren->webhooks->subscriptions->create()', 'siren.webhooks.subscriptions.create()'],
  ['$siren->webhooks->subscriptions->events()', 'siren.webhooks.subscriptions.events()'],
  ['$siren->webhooks->subscriptions->list()', 'siren.webhooks.subscriptions.list()'],
  ['$siren->webhooks->subscriptions->delete()', 'siren.webhooks.subscriptions.delete()'],
  ['$siren->webhooks->subscriptions->retrieve()', 'siren.webhooks.subscriptions.retrieve()'],
  ['$siren->webhooks->subscriptions->update()', 'siren.webhooks.subscriptions.update()'],
  ['$siren->webhooks->subscriptions->test()', 'siren.webhooks.subscriptions.test()'],
  ['$siren->webhooks->subscriptions->deliveries()', 'siren.webhooks.subscriptions.deliveries()'],
  ['$siren->apiKeys->create()', 'siren.apiKeys.create()'],
  ['$siren->apiKeys->list()', 'siren.apiKeys.list()'],
  ['$siren->apiKeys->scopes()', 'siren.apiKeys.scopes()'],
  ['$siren->apiKeys->revoke()', 'siren.apiKeys.revoke()'],
  ['$siren->conversions->list()', 'siren.conversions.list()'],
  ['$siren->conversions->retrieve()', 'siren.conversions.retrieve()'],
  ['$siren->conversions->create()', 'siren.conversions.create()'],
  ['$siren->conversions->update()', 'siren.conversions.update()'],
  ['$siren->conversions->delete()', 'siren.conversions.delete()'],
  ['$siren->conversions->bulk()', 'siren.conversions.bulk()'],
  ['$siren->conversions->types()', 'siren.conversions.types()'],
  ['$siren->transactions->list()', 'siren.transactions.list()'],
  ['$siren->transactions->retrieve()', 'siren.transactions.retrieve()'],
  ['$siren->transactions->details()', 'siren.transactions.details()'],
  ['$siren->transactions->create()', 'siren.transactions.create()'],
  ['$siren->transactions->bulk()', 'siren.transactions.bulk()'],
  ['$siren->transactions->creditCollaborator()', 'siren.transactions.creditCollaborator()'],
  ['$siren->transactions->sources()', 'siren.transactions.sources()'],
  ['$siren->obligations->list()', 'siren.obligations.list()'],
  ['$siren->payouts->list()', 'siren.payouts.list()'],
  ['$siren->payouts->retrieve()', 'siren.payouts.retrieve()'],
  ['$siren->fulfillments->list()', 'siren.fulfillments.list()'],
  ['$siren->fulfillments->retrieve()', 'siren.fulfillments.retrieve()'],
  ['$siren->collaborators->list()', 'siren.collaborators.list()'],
  ['$siren->collaborators->retrieve()', 'siren.collaborators.retrieve()'],
  ['$siren->collaborators->create()', 'siren.collaborators.create()'],
  ['$siren->collaborators->createPending()', 'siren.collaborators.createPending()'],
  ['$siren->collaborators->updateDetails()', 'siren.collaborators.updateDetails()'],
  ['$siren->collaborators->update()', 'siren.collaborators.update()'],
  ['$siren->collaborators->delete()', 'siren.collaborators.delete()'],
  ['$siren->collaborators->bulk()', 'siren.collaborators.bulk()'],
  ['$siren->collaborators->statusTypes()', 'siren.collaborators.statusTypes()'],
  ['$siren->collaborators->generateReferralCode()', 'siren.collaborators.generateReferralCode()'],
  ['$siren->collaborators->aliases->list()', 'siren.collaborators.aliases.list()'],
  ['$siren->collaborators->aliases->trackingCode()', 'siren.collaborators.aliases.trackingCode()'],
  ['$siren->collaborators->aliases->setTrackingCode()', 'siren.collaborators.aliases.setTrackingCode()'],
  ['$siren->collaborators->aliases->findByCode()', 'siren.collaborators.aliases.findByCode()'],
  ['$siren->collaborators->aliases->forCollaborator()', 'siren.collaborators.aliases.forCollaborator()'],
  ['$siren->collaborators->aliases->query()', 'siren.collaborators.aliases.query()'],
  ['$siren->collaborators->aliases->create()', 'siren.collaborators.aliases.create()'],
  ['$siren->collaborators->aliases->free()', 'siren.collaborators.aliases.free()'],
  ['$siren->collaborators->enrollments->programsFor()', 'siren.collaborators.enrollments.programsFor()'],
  ['$siren->collaborators->enrollments->collaboratorsIn()', 'siren.collaborators.enrollments.collaboratorsIn()'],
  ['$siren->collaborators->enrollments->enroll()', 'siren.collaborators.enrollments.enroll()'],
  ['$siren->collaborators->enrollments->unenroll()', 'siren.collaborators.enrollments.unenroll()'],
  ['$siren->collaborators->enrollments->replace()', 'siren.collaborators.enrollments.replace()'],
  ['$siren->collaborators->enrollments->list()', 'siren.collaborators.enrollments.list()'],
  ['$siren->collaborators->enrollments->add()', 'siren.collaborators.enrollments.add()'],
  ['$siren->collaborators->enrollments->remove()', 'siren.collaborators.enrollments.remove()'],
  ['$siren->collaboratorGroups->list()', 'siren.collaboratorGroups.list()'],
  ['$siren->collaboratorGroups->retrieve()', 'siren.collaboratorGroups.retrieve()'],
  ['$siren->collaboratorGroups->create()', 'siren.collaboratorGroups.create()'],
  ['$siren->collaboratorGroups->update()', 'siren.collaboratorGroups.update()'],
  ['$siren->collaboratorGroups->delete()', 'siren.collaboratorGroups.delete()'],
  ['$siren->collaboratorGroups->structures()', 'siren.collaboratorGroups.structures()'],
  ['$siren->collaboratorGroups->members->list()', 'siren.collaboratorGroups.members.list()'],
  ['$siren->collaboratorGroups->members->add()', 'siren.collaboratorGroups.members.add()'],
  ['$siren->collaboratorGroups->members->set()', 'siren.collaboratorGroups.members.set()'],
  ['$siren->collaboratorGroups->members->remove()', 'siren.collaboratorGroups.members.remove()'],
  ['$siren->programs->list()', 'siren.programs.list()'],
  ['$siren->programs->retrieve()', 'siren.programs.retrieve()'],
  ['$siren->programs->create()', 'siren.programs.create()'],
  ['$siren->programs->update()', 'siren.programs.update()'],
  ['$siren->programs->delete()', 'siren.programs.delete()'],
  ['$siren->programs->bulk()', 'siren.programs.bulk()'],
  ['$siren->programs->statusTypes()', 'siren.programs.statusTypes()'],
  ['$siren->programs->incentiveTypes()', 'siren.programs.incentiveTypes()'],
  ['$siren->programs->currencyTypes()', 'siren.programs.currencyTypes()'],
  ['$siren->programGroups->list()', 'siren.programGroups.list()'],
  ['$siren->programGroups->retrieve()', 'siren.programGroups.retrieve()'],
  ['$siren->programGroups->create()', 'siren.programGroups.create()'],
  ['$siren->programGroups->update()', 'siren.programGroups.update()'],
  ['$siren->programGroups->delete()', 'siren.programGroups.delete()'],
  ['$siren->programGroups->bulk()', 'siren.programGroups.bulk()'],
  ['$siren->opportunities->list()', 'siren.opportunities.list()'],
  ['$siren->opportunities->retrieve()', 'siren.opportunities.retrieve()'],
  ['$siren->opportunities->update()', 'siren.opportunities.update()'],
  ['$siren->engagements->list()', 'siren.engagements.list()'],
  ['$siren->engagements->retrieve()', 'siren.engagements.retrieve()'],
  ['$siren->engagements->types()', 'siren.engagements.types()'],
  ['$siren->engagements->calculations()', 'siren.engagements.calculations()'],
  ['$siren->distributors->list()', 'siren.distributors.list()'],
  ['$siren->distributors->retrieve()', 'siren.distributors.retrieve()'],
  ['$siren->distributors->create()', 'siren.distributors.create()'],
  ['$siren->distributors->update()', 'siren.distributors.update()'],
  ['$siren->distributors->delete()', 'siren.distributors.delete()'],
  ['$siren->distributors->bulk()', 'siren.distributors.bulk()'],
  ['$siren->distributors->creditMetric()', 'siren.distributors.creditMetric()'],
  ['$siren->customCurrencies->list()', 'siren.customCurrencies.list()'],
  ['$siren->customCurrencies->retrieve()', 'siren.customCurrencies.retrieve()'],
  ['$siren->customCurrencies->create()', 'siren.customCurrencies.create()'],
  ['$siren->customCurrencies->update()', 'siren.customCurrencies.update()'],
  ['$siren->customCurrencies->delete()', 'siren.customCurrencies.delete()'],
  ['$siren->credits->adjust()', 'siren.credits.adjust()'],
  ['$siren->credits->balances()', 'siren.credits.balances()'],
  ['$siren->credits->checkoutBalances()', 'siren.credits.checkoutBalances()'],
  ['$siren->credits->checkoutBalance()', 'siren.credits.checkoutBalance()'],
  ['$siren->credits->entries()', 'siren.credits.entries()'],
  ['$siren->credits->holds()', 'siren.credits.holds()'],
  ['$siren->credits->placeHold()', 'siren.credits.placeHold()'],
  ['$siren->credits->releaseHold()', 'siren.credits.releaseHold()'],
  ['Credits::holdReference()', 'CreditsResource.holdReference()'],
  ['$siren->mappings->list()', 'siren.mappings.list()'],
  ['$siren->mappings->forExternal()', 'siren.mappings.forExternal()'],
  ['$siren->mappings->forLocal()', 'siren.mappings.forLocal()'],
  ['$siren->mappings->create()', 'siren.mappings.create()'],
  ['$siren->mappings->deleteForCollaborator()', 'siren.mappings.deleteForCollaborator()'],
  ['$siren->mappings->deleteForExternal()', 'siren.mappings.deleteForExternal()'],
  ['$siren->settings->collaborator()', 'siren.settings.collaborator()'],
  ['$siren->settings->value()', 'siren.settings.value()'],
];

/**
 * Rows whose Node method behaves differently from PHP in a way the slice 4
 * or apps-sdk-gaps architecture note writes down, so the table must say so
 * too.
 */
const WRITTEN_DIFFERENCES = [
  '$siren->webhooks->subscriptions->deliveries()',
  '$siren->fulfillments->list()',
  '$siren->conversions->update()',
  '$siren->transactions->details()',
  '$siren->transactions->create()',
  '$siren->transactions->creditCollaborator()',
  '$siren->opportunities->list()',
  '$siren->engagements->list()',
  '$siren->distributors->creditMetric()',
  '$siren->customCurrencies->retrieve()',
  '$siren->credits->balances()',
  '$siren->credits->checkoutBalances()',
  '$siren->credits->placeHold()',
  '$siren->credits->releaseHold()',
  '$siren->settings->value()',
];

interface Row {
  php: string;
  node: string;
  difference: string;
}

function readme(): string {
  return readFileSync(new URL('../README.md', import.meta.url), 'utf8');
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

/** The rows of the first table in the section whose header is `| PHP | Node | Difference |`. */
function parityRows(): Row[] {
  const lines = section(readme(), '## Parity with the PHP SDK').split('\n');
  const header = lines.findIndex((line) => /^\|\s*PHP\s*\|\s*Node\s*\|\s*Difference\s*\|\s*$/.test(line));
  expect(header, 'a table headed | PHP | Node | Difference |').toBeGreaterThan(-1);
  const rows: Row[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    rows.push({ php: cells[0] ?? '', node: cells[1] ?? '', difference: cells[2] ?? '' });
  }
  return rows;
}

/** The name inside one pair of backticks, or the cell as it is. */
function code(cell: string): string {
  const match = /^`([^`]+)`$/.exec(cell);
  return match ? match[1]! : cell;
}

/** Reads a dotted name such as `siren.credits.placeHold` from the client or the exports. */
function resolve(name: string, siren: sdk.Siren): unknown {
  const parts = name.replace(/\(\)$/, '').split('.');
  let value: unknown = parts[0] === 'siren' ? siren : Reflect.get(sdk, parts[0]!);
  for (const part of parts.slice(1)) {
    if (value === null || value === undefined) return undefined;
    value = Reflect.get(value as object, part);
  }
  return value;
}

describe('P11: README parity table', () => {
  it('has a row for every public method of the PHP SDK, once', () => {
    const rows = parityRows();

    for (const [php] of PHP_SURFACE) {
      expect(
        rows.filter((row) => code(row.php) === php),
        php,
      ).toHaveLength(1);
    }
  });

  it.each(PHP_SURFACE.filter(([, node]) => node !== null))('maps %s to %s', (php, node) => {
    const row = parityRows().find((candidate) => code(candidate.php) === php);

    expect(row, php).toBeDefined();
    expect(code(row!.node)).toBe(node);
  });

  it('shows no PHP-only row without a written difference', () => {
    const rows = parityRows();
    const phpOnly = rows.filter((row) => /^(none|)$/i.test(code(row.node)));

    for (const [php] of PHP_SURFACE.filter(([, candidate]) => candidate === null)) {
      expect(phpOnly.map((row) => code(row.php)), `${php} is PHP-only`).toContain(php);
    }
    for (const row of phpOnly) {
      expect(code(row.node), row.php).toBe('none');
      expect(row.difference.length, `${row.php} says why Node leaves it out`).toBeGreaterThan(20);
    }
  });

  it.each(WRITTEN_DIFFERENCES)('writes down how %s differs', (php) => {
    const row = parityRows().find((candidate) => code(candidate.php) === php);

    expect(row, php).toBeDefined();
    expect(row!.difference.length, `${php} has a difference`).toBeGreaterThan(20);
  });

  it('maps the record scope list in a sentence under the table', () => {
    const parity = section(readme(), '## Parity with the PHP SDK');
    const underTable = parity.slice(0, parity.indexOf(`\n${NODE_ONLY_HEADING}\n`));

    for (const name of ['`ApiKeyRecordScope::ALL`', '`API_KEY_RECORD_SCOPES`', '`ApiKeyRecordScope::FULFILLMENTS_READ`', '`ApiKeyRecordScope.FulfillmentsRead`']) {
      expect(underTable, name).toContain(name);
    }
    expect(underTable).toContain('the same thirty strings in the same order');
    expect(sdk.API_KEY_RECORD_SCOPES).toHaveLength(30);
  });

  it('compares against the PHP SDK by release, never by branch or commit', () => {
    const opening = section(readme(), '## Parity with the PHP SDK').split('\n| PHP |')[0]!;

    expect(opening).toContain("the Siren PHP SDK's next release");
    expect(opening).not.toMatch(/feat\/|pkt\/|\b[0-9a-f]{7,40}\b/);
  });

  it('names only Node methods that exist', () => {
    const http = new FakeHttpClient([reply(200, {})]);
    const siren = new sdk.Siren({ apiKey: TEST_API_KEY, httpClient: http, baseUrl: BASE });

    for (const row of parityRows()) {
      const node = code(row.node);
      if (node === 'none') continue;
      expect(typeof resolve(node, siren), `${node} in the row for ${row.php}`).toBe('function');
    }
    expect(http.requests).toHaveLength(0);
  });
});

/*
 * The second table, "Node methods the PHP SDK does not have yet". Node may
 * lead the PHP SDK, and each method it adds first is written down here, so
 * a later slice can give PHP the same call. The seven calls siren-php's
 * feat/apps added moved to the first table. When this list was checked,
 * siren-php's origin/main was still 59383e6, and neither it nor feat/apps
 * held any of the three left here. The ten `siren.apps` calls are the
 * apps-cli slice's (docs/architecture/apps-cli.md), and the PHP SDK gains
 * them after it.
 *
 * The guard below walks a real `Siren` client: every method on the
 * prototype of every resource it carries, nested resources included. Each
 * one must sit in exactly one of the two tables, so a later public method
 * that is in neither fails here until its row is written.
 */

/** Node methods with no PHP counterpart, as the second table's Node cell writes them. */
const NODE_ONLY = [
  'siren.events.forward()',
  'siren.events.browserToken()',
  'siren.events.browserTokenHandler()',
  'siren.conversions.recoverCreate()',
  'siren.transactions.recoverCreditCollaborator()',
  'siren.apps.declare()',
  'siren.apps.list()',
  'siren.apps.retrieve()',
  'siren.apps.setStatus()',
  'siren.apps.create()',
  'siren.apps.update()',
  'siren.apps.createKey()',
  'siren.apps.rotateKey()',
  'siren.apps.revokeKey()',
  'siren.apps.rotateSecret()',
  'siren.apps.test()',
  'siren.apps.deliveries()',
  'siren.apps.events()',
  'siren.apps.scopes()',
  'siren.apps.kinds()',
  'siren.apps.delete()',
  'siren.apps.verifyRequest()',
  'siren.apps.shownAmount()',
  'siren.apps.requestHandler()',
  'siren.apps.splitPool()',
  'siren.apps.requests.retrieve()',
  'siren.apps.requests.list()',
  'siren.apps.requests.resend()',
  'siren.apps.requests.answer()',
  'siren.apps.items.create()',
  'siren.apps.items.retrieve()',
  'siren.apps.items.update()',
  'siren.apps.items.delete()',
];

/**
 * Methods TypeScript marks `private`, which sit on the prototype at run time
 * but are not public surface. `privateStaysPrivate` below fails the type
 * check if either becomes public, so this list cannot hide a public method.
 */
const PRIVATE_METHODS = ['siren.events.send()', 'siren.events.tokensFor()', 'siren.mappings.deleteLinks()'];

// Never called. `npm run typecheck` reads it, and each `@ts-expect-error`
// fails the check once its method stops being private.
export function privateStaysPrivate(siren: sdk.Siren): void {
  // @ts-expect-error EventsResource.send is private.
  void siren.events.send;
  // @ts-expect-error EventsResource.tokensFor is private.
  void siren.events.tokensFor;
  // @ts-expect-error MappingsResource.deleteLinks is private.
  void siren.mappings.deleteLinks;
}

const NODE_ONLY_HEADING = '### Node methods the PHP SDK does not have yet';

interface NodeOnlyRow {
  node: string;
  route: string;
  does: string;
}

/** The rows of the table headed `| Node | Siren route | What it does |` in the second section. */
function nodeOnlyRows(): NodeOnlyRow[] {
  const lines = section(readme(), NODE_ONLY_HEADING).split('\n');
  const header = lines.findIndex((line) => /^\|\s*Node\s*\|\s*Siren route\s*\|\s*What it does\s*\|\s*$/.test(line));
  expect(header, 'a table headed | Node | Siren route | What it does |').toBeGreaterThan(-1);
  const rows: NodeOnlyRow[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    rows.push({ node: cells[0] ?? '', route: cells[1] ?? '', does: cells[2] ?? '' });
  }
  return rows;
}

/** Every method on the prototype chain of each resource a client carries, as `siren.path.method()`. */
function clientMethods(siren: sdk.Siren): string[] {
  const names = new Set<string>();
  const seen = new Set<object>();

  function walk(value: object, path: string): void {
    if (seen.has(value)) return;
    seen.add(value);
    for (let proto = Object.getPrototypeOf(value) as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue;
        if (typeof Object.getOwnPropertyDescriptor(proto, key)?.value === 'function') names.add(`${path}.${key}()`);
      }
    }
    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(value, key);
      // Resources hold the transport too. Only the resources are surface.
      if (typeof child === 'object' && child !== null && /Resource$/.test(child.constructor.name)) {
        walk(child, `${path}.${key}`);
      }
    }
  }

  walk(siren, 'siren');
  return [...names].sort();
}

describe('Parity: Node methods the PHP SDK does not have yet', () => {
  it('lists each Node-only method once, with its route and what it does', () => {
    const rows = nodeOnlyRows();

    expect(rows.map((row) => code(row.node)).sort()).toEqual([...NODE_ONLY].sort());
    for (const row of rows) {
      expect(row.route, `${row.node} names its route`).toMatch(/`(GET|POST|PUT|PATCH|DELETE) \//);
      expect(row.does.length, `${row.node} says what it does`).toBeGreaterThan(10);
    }
  });

  it('names no method the PHP table already maps', () => {
    const mapped = new Set(PHP_SURFACE.map(([, node]) => node));

    for (const node of NODE_ONLY) {
      expect(mapped.has(node), node).toBe(false);
    }
  });

  it('names only Node methods that exist', () => {
    const http = new FakeHttpClient([reply(200, {})]);
    const siren = new sdk.Siren({ apiKey: TEST_API_KEY, httpClient: http, baseUrl: BASE });

    for (const row of nodeOnlyRows()) {
      expect(typeof resolve(code(row.node), siren), row.node).toBe('function');
    }
    expect(http.requests).toHaveLength(0);
  });

  it('puts every public method of the Siren client in exactly one of the two tables', () => {
    const http = new FakeHttpClient([reply(200, {})]);
    const siren = new sdk.Siren({ apiKey: TEST_API_KEY, httpClient: http, baseUrl: BASE });
    const inPhpTable = new Set(parityRows().map((row) => code(row.node)));
    const inNodeTable = new Set(nodeOnlyRows().map((row) => code(row.node)));
    const methods = clientMethods(siren);

    expect(methods, 'the walk reaches the nested resources').toContain('siren.collaborators.aliases.create()');
    for (const name of PRIVATE_METHODS) expect(methods, name).toContain(name);
    for (const name of methods.filter((candidate) => !PRIVATE_METHODS.includes(candidate))) {
      expect([inPhpTable.has(name), inNodeTable.has(name)].filter(Boolean), name).toHaveLength(1);
    }
    expect(http.requests).toHaveLength(0);
  });
});
