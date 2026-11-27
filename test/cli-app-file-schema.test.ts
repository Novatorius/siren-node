import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { appFileSchema } from '../src/cli/app-file-schema';
import { KINDS, appFileTemplate, parseAppFile } from '../src/cli/app-file';

/*
 * siren.app.schema.json, which the package ships and `apps init` points
 * `$schema` at. Contract: docs/architecture/apps-cli.md, "The app file".
 * The committed file is the output of appFileSchema(), which reads the same
 * lists and limits parseAppFile checks with. `npx vitest run
 * test/cli-app-file-schema.test.ts -u` writes it again after a change.
 */

const ENV = { SIREN_APP_URL: 'https://acme.example/siren' };
const schemaFile = new URL('../siren.app.schema.json', import.meta.url);
const validate = new Ajv({ allErrors: true, strict: false }).compile(appFileSchema());

function file(app: Record<string, unknown>, top: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, ...top, apps: { 'acme-payouts': { name: 'Acme', url: '${SIREN_APP_URL}', ...app } } });
}
const item = (fields: Record<string, unknown>) => ({ features: { thing: { name: 'Thing', ...fields } } });

/** Files both must accept. */
const GOOD: Record<string, string> = {
  'the init template': appFileTemplate('acme-payouts', 'Acme'),
  'the example app': readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8'),
  'a key-only app of custom events': JSON.stringify({ version: 1, apps: { 'acme-events': { name: 'Events', features: { signup: { kind: 'customEvent', name: 'Signup', domains: ['example.com'], fields: { list: { type: 'string', required: true } } } } } } }),
  'an app with no features': JSON.stringify({ version: 1, apps: { acme: { name: 'Acme' } } }),
  'a recipe name and description': file({}, { name: 'Acme', description: '' }),
  'a metric calculation scoring money': file(item({ kind: 'metricCalculation', scoresMoney: true })),
  'an incentive type': file(item({ kind: 'incentiveType', conversionTypes: ['sale', 'renewal'] })),
  'an answer window': file(item({ kind: 'postConversionAction', answerWindowMinutes: 43200 })),
  ...Object.fromEntries(
    KINDS.map((kind) => [
      `the kind ${kind}`,
      file(item({ kind, ...(kind === 'payoutMethod' ? { currencies: ['USD'] } : kind === 'incentiveType' ? { conversionTypes: ['sale'] } : {}) })),
    ]),
  ),
};

/** Files both must refuse, for their shape. */
const BAD: Record<string, string> = {
  'no version': JSON.stringify({ apps: { acme: { name: 'Acme' } } }),
  'version 2': file({}, { version: 2 }),
  'an unknown top key': file({}, { programs: [] }),
  'two apps': JSON.stringify({ version: 1, apps: { one: { name: 'One' }, two: { name: 'Two' } } }),
  'no apps': JSON.stringify({ version: 1, apps: {} }),
  'a reserved app key': JSON.stringify({ version: 1, apps: { requests: { name: 'R' } } }),
  'an app key in capitals': JSON.stringify({ version: 1, apps: { Acme: { name: 'A' } } }),
  'an app with no name': JSON.stringify({ version: 1, apps: { acme: { url: 'https://acme.example' } } }),
  'an unknown app field': file({ colour: 'green' }),
  'features with no url': JSON.stringify({ version: 1, apps: { acme: { name: 'A', features: { n: { kind: 'postConversionAction', name: 'N' } } } } }),
  'an unknown kind': file(item({ kind: 'paymentThing' })),
  'the old payout word': file(item({ kind: 'fulfillmentMethod', currencies: ['USD'] })),
  'a feature with no name': file({ features: { thing: { kind: 'postConversionAction' } } }),
  'an unknown feature field': file(item({ kind: 'postConversionAction', colour: 'green' })),
  'a feature key with a space': file({ features: { 'a b': { kind: 'postConversionAction', name: 'N' } } }),
  'a payout method with no currencies': file(item({ kind: 'payoutMethod' })),
  'currencies on another kind': file(item({ kind: 'postConversionAction', currencies: ['USD'] })),
  'an incentive type with no conversions': file(item({ kind: 'incentiveType' })),
  'a conversion twice': file(item({ kind: 'incentiveType', conversionTypes: ['sale', 'sale'] })),
  'an unknown conversion': file(item({ kind: 'incentiveType', conversionTypes: ['refund'] })),
  'scoresMoney on another kind': file(item({ kind: 'postConversionAction', scoresMoney: true })),
  'scoresMoney as text': file(item({ kind: 'metricCalculation', scoresMoney: 'yes' })),
  'domains on another kind': file(item({ kind: 'postConversionAction', domains: ['example.com'] })),
  'a field with no type': file(item({ kind: 'customEvent', fields: { list: { required: true } } })),
  'too many domains': file(item({ kind: 'customEvent', domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.com`) })),
  'an answer window of 0': file(item({ kind: 'postConversionAction', answerWindowMinutes: 0 })),
  'an answer window too long': file(item({ kind: 'postConversionAction', answerWindowMinutes: 43201 })),
  'scopes as text': file({ scopes: 'event:sale' }),
};

/** Files only the tool refuses, since their values need more than the file's shape. */
const TOOL_ONLY: Record<string, string> = {
  'a url over plain http to another host': file({ url: 'http://acme.example' }),
  'a contact that is no email address': file({ contacts: ['ops'] }),
  'a bare * domain': file(item({ kind: 'customEvent', domains: ['*'] })),
  'a placeholder outside the url': file({ name: '${SIREN_APP_NAME}' }),
};

describe('cli pass 1, finding 5: siren.app.schema.json', () => {
  it('is the schema built from the lists the tool checks with', async () => {
    await expect(`${JSON.stringify(appFileSchema(), null, 2)}\n`).toMatchFileSnapshot(schemaFile.pathname);
  });

  it('ships in the package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('siren.app.schema.json');
  });

  for (const [name, text] of Object.entries(GOOD)) {
    it(`agrees with the tool on a good file: ${name}`, () => {
      expect(parseAppFile(text, ENV).problems).toEqual([]);
      expect(validate(JSON.parse(text)), JSON.stringify(validate.errors)).toBe(true);
    });
  }

  for (const [name, text] of Object.entries(BAD)) {
    it(`agrees with the tool on a bad file: ${name}`, () => {
      expect(parseAppFile(text, ENV).problems.length).toBeGreaterThan(0);
      expect(validate(JSON.parse(text))).toBe(false);
    });
  }

  for (const [name, text] of Object.entries(TOOL_ONLY)) {
    it(`leaves to the tool: ${name}`, () => {
      expect(parseAppFile(text, ENV).problems.length).toBeGreaterThan(0);
      expect(validate(JSON.parse(text))).toBe(true);
    });
  }
});
