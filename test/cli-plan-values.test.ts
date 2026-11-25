import { describe, expect, it } from 'vitest';
import { appChanges } from '../src/cli/app-changes';
import type { App } from '../src/record-types';
import { appRecord } from './apps-siren-answers';

/*
 * CLI pass 2, finding 3, the rest: the plan names what changes but not
 * from what to what. Each line now gives the old and new value: text in
 * quotes, cut at 40 characters, a number or a yes or no as it is, and a
 * set as what it adds and removes. A moved address names its hosts, never
 * its url.
 */

const URL = 'https://acme.example/siren';
const base = { name: 'Acme', description: "Siren's example app.", url: URL };
const have = (over: Record<string, unknown> = {}) => appRecord(over) as unknown as App;
const notify = (over: Record<string, unknown> = {}) => ({ kind: 'postConversionAction' as const, key: 'notify-crm', name: 'Tell the CRM', ...over });
const ledger = (over: Record<string, unknown> = {}) => ({ kind: 'payoutMethod' as const, key: 'acme-ledger', name: 'Acme ledger', currencies: ['USD'], answerWindowMinutes: 1, ...over });

describe('the plan gives old and new values', () => {
  it('description: both texts in quotes, cut at 40 characters, and none for an empty one', () => {
    expect(appChanges(have(), { ...base, description: 'Pays partners.', features: [notify(), ledger()] }).lines).toEqual([
      `description: "Siren's example app." becomes "Pays partners."`,
    ]);
    expect(appChanges(have(), { ...base, description: 'x'.repeat(60), features: [notify(), ledger()] }).lines).toEqual([
      `description: "Siren's example app." becomes "${'x'.repeat(39)}…"`,
    ]);
    expect(appChanges(have(), { ...base, description: '', features: [notify(), ledger()] }).lines).toEqual([`description: "Siren's example app." becomes none`]);
  });

  it('a moved address: its hosts, or another path on the same host, never the url', () => {
    expect(appChanges(have(), { ...base, url: 'https://new.example/hook', features: [notify(), ledger()] }).lines).toEqual([
      'moves the address from acme.example to new.example, keeping its signing secret',
    ]);
    expect(appChanges(have(), { ...base, url: 'https://acme.example/other', features: [notify(), ledger()] }).lines).toEqual([
      'moves the address to another path on acme.example, keeping its signing secret',
    ]);
  });

  it('a feature: each field from what to what', () => {
    const lines = appChanges(have(), { ...base, features: [notify({ name: 'Tell the CRM, now', description: 'New.' }), ledger({ currencies: ['usd', 'eur'], answerWindowMinutes: 5 })] }).lines;
    expect(lines).toEqual([
      'changes feature notify-crm, Post-conversion action (postConversionAction): name "Tell the CRM" becomes "Tell the CRM, now", description none becomes "New."',
      'changes feature acme-ledger, Payout method (payoutMethod): currencies (adds EUR), answer window 1 becomes 5 minutes',
    ]);
  });

  it('an answer window set or cleared says none for the side without one', () => {
    expect(appChanges(have(), { ...base, features: [notify({ answerWindowMinutes: 30 }), ledger({ answerWindowMinutes: undefined })] }).lines).toEqual([
      'changes feature notify-crm, Post-conversion action (postConversionAction): answer window none becomes 30 minutes',
      'changes feature acme-ledger, Payout method (payoutMethod): answer window 1 minute becomes none',
    ]);
  });
});
