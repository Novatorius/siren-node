import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../src/index';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient, failOnGlobalFetch, reply } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * Slice 4 acceptance tests for packet P11: the README's parity table with
 * the Siren PHP SDK 0.3.0 (siren-php at 59383e6). The slice is done when
 * the table shows no PHP-only row except where a difference is written
 * down.
 *
 * PHP_SURFACE below is every public method of every resource the PHP
 * `Siren` client carries, read from siren-php's src/Resources and
 * src/Siren.php, with the Node name each one has. `null` marks a method the
 * Node SDK leaves out on purpose, and its row must say why.
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
 * architecture note writes down, so the table must say so too.
 */
const WRITTEN_DIFFERENCES = [
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
