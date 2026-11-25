#!/usr/bin/env node
/*
 * Build src/testing/event-samples.ts, the sample `data` of each webhook event
 * that `sampleEventData()` and `webhookEvent()` in `@novatorius/siren/testing`
 * give, from Siren's own event reference.
 *
 * Usage: node scripts/siren-event-samples.mjs <path-to-siren-checkout> [--check | --write <source label>]
 *
 * Siren documents each event's payload in docs/api/webhooks-events.md: a
 * `### <event>` heading, then a `| Field | Type | Description |` table. Each
 * row becomes one field of the sample, with a value its type gives:
 *
 * - `integer`, `integer or null`: 101, 102 and on for a field named `...Id`,
 *   in the table's order, and 1 for any other.
 * - `integer[]`: a list holding the next id.
 * - `number`: 25.
 * - `boolean`: true.
 * - `string`, `string or null`: the first quoted value the description shows
 *   in backticks (`"stripe"`), else the first other backticked word that is
 *   not a field of the table, `null`, `true` or `false`, else "example".
 * - `array`: an empty list.
 *
 * An event whose payload line reads "the same fields as `<event>`" gets a
 * copy of that event's sample.
 *
 * With `--check`, it writes nothing and exits 1 when the committed file
 * differs from what the reference gives. test/apps-dx-pass-4.test.ts runs it
 * that way against SIREN_CHECKOUT.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOC = 'docs/api/webhooks-events.md';
const OUT = 'src/testing/event-samples.ts';

export function eventSamples(markdown) {
  const samples = {};
  const same = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^### ([a-z_]+\.[a-z_]+)\s*$/.exec(lines[i]);
    if (heading === null) continue;
    const event = heading[1];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('### ') && !lines[j].startsWith('## ') && !/^\|\s*Field\s*\|\s*Type\s*\|/.test(lines[j])) {
      const copy = /^\*\*Payload:\*\* the same fields as `([a-z_]+\.[a-z_]+)`/.exec(lines[j]);
      if (copy !== null) same.push([event, copy[1]]);
      j += 1;
    }
    if (j >= lines.length || !lines[j].startsWith('|')) continue;
    const rows = [];
    for (j += 2; j < lines.length && lines[j].startsWith('|'); j += 1) {
      const cells = lines[j].split('|').slice(1, -1).map((cell) => cell.trim());
      const name = /^`([A-Za-z0-9_]+)`$/.exec(cells[0] ?? '');
      if (name === null) continue;
      rows.push({ name: name[1], type: cells[1] ?? '', description: cells.slice(2).join('|') });
    }
    const fields = new Set(rows.map((row) => row.name));
    const data = {};
    let nextId = 101;
    for (const { name, type, description } of rows) {
      const base = type.replace(/ or null$/, '');
      if (base === 'integer') data[name] = name.endsWith('Id') ? nextId++ : 1;
      else if (base === 'integer[]') data[name] = [nextId++];
      else if (base === 'number') data[name] = 25;
      else if (base === 'boolean') data[name] = true;
      else if (base === 'array') data[name] = [];
      else if (base === 'string') data[name] = stringSample(description, fields);
      else throw new Error(`${DOC}: ${event}.${name} has a type this script does not know: ${type}`);
    }
    samples[event] = data;
  }
  for (const [event, from] of same) {
    if (samples[from] === undefined) throw new Error(`${DOC}: ${event} copies ${from}, which has no table`);
    samples[event] = structuredClone(samples[from]);
  }
  if (Object.keys(samples).length === 0) throw new Error(`${DOC}: no events found`);
  return samples;
}

function stringSample(description, fields) {
  const ticked = [...description.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const quoted = ticked.find((value) => /^"[^"]*"$/.test(value));
  if (quoted !== undefined) return quoted.slice(1, -1);
  const word = ticked.find((value) => /^[a-z0-9_.-]+$/i.test(value) && !fields.has(value) && !['null', 'true', 'false'].includes(value));
  return word ?? 'example';
}

export function render(samples, source) {
  return (
    '/*\n' +
    ` * Each webhook event's sample \`data\`, built by scripts/siren-event-samples.mjs\n` +
    ` * from Siren's ${DOC} (${source}). Do not edit by hand.\n` +
    ' * test/apps-dx-pass-4.test.ts holds it equal to what Siren\'s file gives.\n' +
    ' */\n\n' +
    '/** Siren\'s sample payload for each webhook event it documents, by event type. */\n' +
    `export const EVENT_SAMPLES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = ${JSON.stringify(samples, null, 2)};\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sirenPath, flag, sourceLabel] = process.argv.slice(2);
  if (!sirenPath) {
    console.error('usage: node scripts/siren-event-samples.mjs <path-to-siren-checkout> [--check]');
    process.exit(2);
  }
  const markdown = readFileSync(resolve(sirenPath, DOC), 'utf8');
  const out = resolve(process.cwd(), OUT);
  if (flag === '--check') {
    const committed = readFileSync(out, 'utf8');
    const body = (text) => text.slice(text.indexOf('export const'));
    if (body(committed) !== body(render(eventSamples(markdown), ''))) {
      console.error(`${OUT} differs from ${DOC} in ${sirenPath}. Run node scripts/siren-event-samples.mjs ${sirenPath}`);
      process.exit(1);
    }
    process.exit(0);
  }
  writeFileSync(out, render(eventSamples(markdown), sourceLabel ?? `Siren checkout ${sirenPath}`));
}
