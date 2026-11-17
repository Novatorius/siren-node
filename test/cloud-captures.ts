import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reply } from './http-fakes';
import type { HttpResponse } from '../src/http';

/*
 * What a real Siren Cloud answered, one JSON file per route and case, in
 * test/fixtures/cloud-captures. The slice 8 checkpoint took them from a
 * local sandbox Cloud built from Novatorius/siren feat/apps at 1557b0030 on
 * 2026-11-17, and turned into a production edition for the `-production`
 * files. Every secret in them is a placeholder such as `<ACCESSTOKEN>`,
 * `<REFRESHTOKEN>`, `<RAWKEY>`, `<SIGNINGSECRET>` or `<API_KEY>`, which a
 * test fills with made-up values through `fill`.
 *
 * One file was relabelled: the capture saved as
 * auth-signup-options-production.json held the sandbox answer of step 19b.
 * Its body and time are those of step 20b, the first signup-options read
 * after the switch to the production edition (e2e/steps/20b in the run
 * folder).
 */

/** One capture: the route, what was sent, and Siren's answer. */
export interface CloudCapture {
  capturedAt: string;
  cloud: string;
  route: string;
  query: unknown;
  request: { authorization: string | null; contentType: string | null; body: unknown };
  response: { status: number; contentType: string | null; body: unknown };
}

const FOLDER = join(__dirname, 'fixtures', 'cloud-captures');

/** Every capture's name, the file name without `.json`. */
export function captureNames(): string[] {
  return readdirSync(FOLDER)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/** The capture with this name, with each placeholder in `fill` replaced by its value. */
export function capture(name: string, fill: Readonly<Record<string, string>> = {}): CloudCapture {
  let text = readFileSync(join(FOLDER, `${name}.json`), 'utf8');
  for (const [placeholder, value] of Object.entries(fill)) text = text.split(placeholder).join(value);
  return JSON.parse(text) as CloudCapture;
}

/** Siren's answer in the capture, as Siren sent it. */
export function capturedBody<T = unknown>(name: string, fill: Readonly<Record<string, string>> = {}): T {
  return capture(name, fill).response.body as T;
}

/** The capture as an `HttpResponse` for a `FakeHttpClient`. */
export function capturedReply(name: string, fill: Readonly<Record<string, string>> = {}, headers: Record<string, string> = {}): HttpResponse {
  const { response } = capture(name, fill);
  return reply(response.status, response.body, headers);
}
