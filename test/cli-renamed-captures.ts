import { capture, capturedBody } from './cloud-captures';
import { reply } from './http-fakes';
import type { HttpResponse } from '../src/http';

/*
 * The CLI's tests read Siren's captured answers through these until the
 * Siren lane captures them again after the feature rename. The captures in
 * test/fixtures/cloud-captures predate it, so an app's body says `items`
 * and a request's says `item`. Siren now sends `features` and `feature`
 * (contract/feature-rename.md), and these rename those two keys, at any
 * depth, and change nothing else.
 */

const RENAMED: Readonly<Record<string, string>> = { items: 'features', item: 'feature' };

function renamed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renamed);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [RENAMED[key] ?? key, renamed(inner)]));
}

/** Siren's captured answer with the feature rename applied. */
export function renamedBody<T = unknown>(name: string, fill: Readonly<Record<string, string>> = {}): T {
  return renamed(capturedBody(name, fill)) as T;
}

/** The capture, with the feature rename applied, as an `HttpResponse` for a `FakeHttpClient`. */
export function renamedReply(name: string, fill: Readonly<Record<string, string>> = {}): HttpResponse {
  return reply(capture(name, fill).response.status, renamedBody(name, fill));
}
