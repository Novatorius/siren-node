import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_KEY_RECORD_SCOPES, ApiKeyRecordScope, ApiKeyScope } from '../src/index';

/*
 * apps-sdk-gaps acceptance tests: the record scope constants equal the list
 * in Siren's lib/ApiKeys/Core/Enums/ApiKeyRecordScopes.php.
 *
 * Two checks hold the constants to that file. The first reads the
 * api-key-scopes.json fixture, which scripts/siren-fixtures.mjs builds from
 * the file's DEFINITIONS and which `--check` reports when stale, so it runs
 * everywhere, CI included. The second reads the PHP file itself from the
 * Siren checkout named by SIREN_CHECKOUT, and compares each constant's
 * name and value as well as their order. It is skipped when SIREN_CHECKOUT
 * is unset, since this repository holds no copy of Siren.
 */

/** The PHP constant name as the SDK spells it: ENGAGEMENTS_READ becomes EngagementsRead. */
function sdkName(phpName: string): string {
  return phpName
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** The record scopes in the fixture, in the order GET /api-keys/scopes lists them. */
function fixtureScopes(): string[] {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/api-key-scopes.json', import.meta.url), 'utf8'),
  ) as { body: Record<string, Array<{ scope: string }>> };
  const groups = fixture.body;
  return Object.entries(groups)
    .filter(([group]) => group !== 'events')
    .flatMap(([, entries]) => entries.map((entry) => entry.scope));
}

/**
 * Each scope in DEFINITIONS, in order, as [PHP constant name, scope string].
 * Reads `public const NAME = '...';` for the values and `self::NAME =>` in
 * DEFINITIONS for the order, the same reading scripts/siren-fixtures.mjs does.
 */
function phpScopes(source: string): Array<[string, string]> {
  const values = new Map<string, string>();
  for (const match of source.matchAll(/const ([A-Z_]+) = '([^']*)';/g)) {
    values.set(match[1]!, match[2]!);
  }
  const start = source.indexOf('const DEFINITIONS = [');
  const end = source.indexOf('\n    ];', start);
  expect(start, 'DEFINITIONS in ApiKeyRecordScopes.php').toBeGreaterThan(-1);
  const definitions = source.slice(start, end);
  const names = [...definitions.matchAll(/self::([A-Z_]+) => \[/g)].map((match) => match[1]!);
  expect(names.length, 'scopes in DEFINITIONS').toBeGreaterThan(0);
  return names.map((name) => {
    expect(values.has(name), name).toBe(true);
    return [name, values.get(name)!];
  });
}

const sirenCheckout = process.env.SIREN_CHECKOUT;
const phpFile =
  sirenCheckout === undefined || sirenCheckout === ''
    ? undefined
    : resolve(sirenCheckout, 'lib/ApiKeys/Core/Enums/ApiKeyRecordScopes.php');

describe('apps-sdk-gaps: API key record scopes', () => {
  it('lists every record scope in the fixture, in order', () => {
    expect([...API_KEY_RECORD_SCOPES]).toEqual(fixtureScopes());
  });

  it('holds one named constant for each scope in API_KEY_RECORD_SCOPES, in the same order', () => {
    expect(Object.values(ApiKeyRecordScope)).toEqual([...API_KEY_RECORD_SCOPES]);
  });

  it('pins the thirty scope strings', () => {
    expect(ApiKeyRecordScope).toEqual({
      EngagementsRead: 'ledger:engagements:read',
      OpportunitiesRead: 'ledger:opportunities:read',
      ConversionsRead: 'ledger:conversions:read',
      TransactionsRead: 'ledger:transactions:read',
      ObligationsRead: 'ledger:obligations:read',
      FulfillmentsRead: 'ledger:fulfillments:read',
      PayoutsRead: 'ledger:payouts:read',
      WebhooksRead: 'webhook-subscriptions:read',
      WebhooksManage: 'webhook-subscriptions:manage',
      ProductsRead: 'records:products:read',
      ProductsManage: 'records:products:manage',
      CouponsRead: 'records:coupons:read',
      CouponsManage: 'records:coupons:manage',
      CollaboratorsRead: 'records:collaborators:read',
      CollaboratorsManage: 'records:collaborators:manage',
      CollaboratorGroupsRead: 'records:collaborator-groups:read',
      CollaboratorGroupsManage: 'records:collaborator-groups:manage',
      ProgramsRead: 'records:programs:read',
      ProgramsManage: 'records:programs:manage',
      ProgramGroupsRead: 'records:program-groups:read',
      ProgramGroupsManage: 'records:program-groups:manage',
      DistributorsRead: 'records:distributors:read',
      DistributorsManage: 'records:distributors:manage',
      ApplicationFormsRead: 'records:application-forms:read',
      ApplicationFormsManage: 'records:application-forms:manage',
      ApplicationsRead: 'records:applications:read',
      ApplicationsManage: 'records:applications:manage',
      NotificationRulesRead: 'records:notification-rules:read',
      NotificationRulesManage: 'records:notification-rules:manage',
      PropertiesRead: 'records:properties:read',
    });
  });

  it('agrees with the ledger and webhook names ApiKeyScope already carries', () => {
    expect(ApiKeyScope.LedgerConversionsRead).toBe(ApiKeyRecordScope.ConversionsRead);
    expect(ApiKeyScope.LedgerTransactionsRead).toBe(ApiKeyRecordScope.TransactionsRead);
    expect(ApiKeyScope.LedgerObligationsRead).toBe(ApiKeyRecordScope.ObligationsRead);
    expect(ApiKeyScope.LedgerPayoutsRead).toBe(ApiKeyRecordScope.PayoutsRead);
    expect(ApiKeyScope.WebhookSubscriptionsRead).toBe(ApiKeyRecordScope.WebhooksRead);
    expect(ApiKeyScope.WebhookSubscriptionsManage).toBe(ApiKeyRecordScope.WebhooksManage);
  });

  it('is frozen, so a caller cannot change a scope the SDK sends', () => {
    // Object.isFrozen(undefined) is true, so check each is there first.
    expect(ApiKeyRecordScope).toBeTypeOf('object');
    expect(Array.isArray(API_KEY_RECORD_SCOPES)).toBe(true);
    expect(Object.isFrozen(ApiKeyRecordScope)).toBe(true);
    expect(Object.isFrozen(API_KEY_RECORD_SCOPES)).toBe(true);
  });
});

describe.skipIf(phpFile === undefined)('apps-sdk-gaps: record scopes read from ApiKeyRecordScopes.php', () => {
  it('equals the PHP list, name for name and value for value, in DEFINITIONS order', () => {
    expect(existsSync(phpFile!), `${phpFile} exists`).toBe(true);
    const php = phpScopes(readFileSync(phpFile!, 'utf8'));

    expect(Object.entries(ApiKeyRecordScope)).toEqual(php.map(([name, scope]) => [sdkName(name), scope]));
    expect([...API_KEY_RECORD_SCOPES]).toEqual(php.map(([, scope]) => scope));
  });
});
