import type { App, AppItem, AppItemDeclaration, DeclareAppParams } from '../record-types';
import { API_KEY_RECORD_SCOPES } from '../api-key-scopes';
import { AppItemKind } from '../taxonomy';
import { kindLabel } from './app-kinds';

/*
 * What `siren apps apply` would change: the app file's declaration held
 * against the app as Siren holds it now, read with `GET /apps/{key}`.
 * Contract: docs/architecture/apps-sdk-container.md, "Apply shows what it
 * will change". Siren compares the same way when it applies a declaration
 * (AppService on Siren's int/preview-apps at a22547327): names trimmed,
 * a description as it is with `''` for none, events and scopes as sets, the
 * scopes first reduced as Siren stores them ({@link storedScopes}),
 * currencies upper-cased in the declared order, and a feature matched by
 * its kind and key, which never change. A person may have changed the app
 * in the dashboard since the last apply, so a difference may be theirs.
 */

/** One feature the file leaves out that Siren still holds active. Apply reads how many records select it. */
export interface DroppedFeature {
  item: AppItem;
}

/** The changes, in the order they print. Empty `lines` and `dropped` mean the app matches the file. */
export interface AppChanges {
  /** True when Siren holds no app with this key, so apply makes one. */
  isNew: boolean;
  lines: string[];
  dropped: DroppedFeature[];
}

/** A feature in a line: its key, then its kind's readable name beside the kind, as `acme-ledger, Payout method (payoutMethod)`. */
function featureName(kind: string, key: string): string {
  return `${key}, ${kindLabel(kind)}`;
}

/**
 * A scope list as Siren stores it: each scope once, in the order given, and
 * when `*` is in it, `*` first with only the record scopes beside it, since
 * the wildcard already grants every event. ApiKeyService::normalizeScopes()
 * (lib/ApiKeys/Service/Services/ApiKeyService.php line 51 on Siren's
 * feat/apps at c8dbb1ab3), which AppService applies to an app key's scopes
 * (lib/Apps/Service/Services/AppService.php line 1764). Without it a file
 * that names `*` beside an event scope would show a change on every apply.
 */
export function storedScopes(scopes: readonly string[]): string[] {
  const unique = [...new Set(scopes)];
  if (!unique.includes('*')) return unique;
  return ['*', ...unique.filter((scope) => (API_KEY_RECORD_SCOPES as readonly string[]).includes(scope))];
}

/** What is in `want` and not in `have`, and what is in `have` and not in `want`. */
function setChange(have: readonly string[], want: readonly string[]): { added: string[]; removed: string[] } {
  return { added: want.filter((entry) => !have.includes(entry)), removed: have.filter((entry) => !want.includes(entry)) };
}

/** `adds a, b, removes c`, or undefined when nothing changed. */
function setLine(label: string, have: readonly string[], want: readonly string[]): string | undefined {
  const { added, removed } = setChange(have, want);
  if (added.length === 0 && removed.length === 0) return undefined;
  const parts = [...(added.length > 0 ? [`adds ${added.join(', ')}`] : []), ...(removed.length > 0 ? [`removes ${removed.join(', ')}`] : [])];
  return `${label}: ${parts.join(', ')}`;
}

/** The fields of a feature that differ from what Siren holds, in words. */
function featureDifferences(have: AppItem, want: AppItemDeclaration): string[] {
  const differences: string[] = [];
  if (want.name.trim() !== have.name) differences.push('name');
  if ((want.description ?? '') !== have.description) differences.push('description');
  const wantCurrencies = (want.currencies ?? []).map((code) => code.toUpperCase());
  const haveCurrencies = have.settings.currencies ?? [];
  if (wantCurrencies.join(',') !== haveCurrencies.join(',')) differences.push('currencies');
  if (want.answerWindowMinutes !== have.settings.answerWindowMinutes) differences.push('answer window');
  if (want.kind === AppItemKind.CustomEvent) {
    if (fieldsText(want.fields) !== fieldsText(have.settings.fields)) differences.push('fields');
    const domains = setChange(storedDomains(have.settings.domains ?? []), storedDomains(want.domains ?? []));
    if (domains.added.length > 0 || domains.removed.length > 0) {
      const parts = [...(domains.added.length > 0 ? [`adds ${domains.added.join(', ')}`] : []), ...(domains.removed.length > 0 ? [`removes ${domains.removed.join(', ')}`] : [])];
      differences.push(`allowed domains (${parts.join(', ')})`);
    }
  }
  return differences;
}

/** Allowed domains as Siren stores them: trimmed, lowercased, each once. */
function storedDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()))];
}

/** A custom event's fields in one comparable text, keys sorted, `required` false when left out. */
function fieldsText(fields: Record<string, { type: string; required?: boolean }> | undefined): string {
  const entries = Object.entries(fields ?? {})
    .map(([name, field]) => `${name}:${field.type}:${field.required === true ? 1 : 0}`)
    .sort();
  return entries.join(',');
}

/** `, allowing a, b` for a new custom event that names domains, else nothing. */
function allowing(feature: AppItemDeclaration): string {
  if (feature.kind !== AppItemKind.CustomEvent) return '';
  const domains = storedDomains(feature.domains ?? []);
  return domains.length > 0 ? `, allowing ${domains.join(', ')}` : ', from the app\'s server only';
}

/**
 * The changes applying `want` to `have` would make, or, when `have` is
 * undefined, what applying it makes. Never names the app's url, which may
 * have come from the environment, nor any secret.
 */
export function appChanges(have: App | undefined, want: DeclareAppParams): AppChanges {
  const features = want.items ?? [];
  if (have === undefined) {
    const parts = ['a key', ...(want.url != null ? ['an address'] : []), ...(features.length > 0 ? [`${features.length} ${features.length === 1 ? 'feature' : 'features'}`] : [])];
    const lines = [`makes the app with ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}`];
    for (const feature of features) lines.push(`adds feature ${featureName(feature.kind, feature.key)}, named ${feature.name.trim()}${allowing(feature)}`);
    return { isNew: true, lines, dropped: [] };
  }

  const lines: string[] = [];
  if (want.name.trim() !== have.name) lines.push(`name: ${have.name} becomes ${want.name.trim()}`);
  if ((want.description ?? '') !== have.description) lines.push('description changes');

  const hasAddress = have.address !== null && have.address !== undefined;
  if (want.url == null) {
    if (hasAddress) lines.push('removes the address and its delivery log, since the file names no url');
  } else if (!hasAddress) {
    lines.push('adds an address, with a new signing secret');
  } else if (want.url !== have.url) {
    lines.push('moves the address to a new url, keeping its signing secret');
  }
  if (want.url != null) {
    const events = setLine('events', hasAddress ? have.events : [], want.events ?? []);
    if (events !== undefined) lines.push(events);
  }
  if (have.apiKey !== null && have.apiKey !== undefined) {
    const scopes = setLine('key scopes', storedScopes(have.apiKey.scopes ?? have.scopes), storedScopes(want.scopes ?? []));
    if (scopes !== undefined) lines.push(scopes);
  }

  const dropped: DroppedFeature[] = [];
  const named = new Set(features.map((feature) => `${feature.kind} ${feature.key}`));
  for (const feature of features) {
    const held = have.items.find((item) => item.kind === feature.kind && item.key === feature.key);
    const name = featureName(feature.kind, feature.key);
    if (held === undefined) {
      lines.push(`adds feature ${name}, named ${feature.name.trim()}${allowing(feature)}`);
      continue;
    }
    const differences = featureDifferences(held, feature);
    if (held.status === 'archived') {
      lines.push(`brings back the archived feature ${name}${differences.length > 0 ? `, with a new ${differences.join(', ')}` : ''}`);
    } else if (differences.length > 0) {
      lines.push(`changes feature ${name}: ${differences.join(', ')}`);
    }
  }
  for (const item of have.items) {
    if (item.status === 'archived' || named.has(`${item.kind} ${item.key}`)) continue;
    dropped.push({ item });
  }
  return { isNew: false, lines, dropped };
}

/**
 * The line for a feature the file leaves out, once apply has read how many
 * records select it: Siren archives it while any does and deletes it
 * otherwise. `uses` is undefined when that read failed.
 */
export function droppedLine(item: AppItem, uses: number | undefined): string {
  const name = featureName(item.kind, item.key);
  if (uses === undefined) return `removes feature ${name}: Siren archives it if a record selects it, and deletes it otherwise`;
  if (uses === 0) return `removes feature ${name}: nothing selects it, so Siren deletes it`;
  return `removes feature ${name}: ${uses === 1 ? '1 record selects' : `${uses} records select`} it, so Siren archives it and never calls it`;
}
