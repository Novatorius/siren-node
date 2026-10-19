import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const built = join(root, 'dist', 'storefront.js');
const builtCjs = join(root, 'dist', 'storefront.cjs');

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

function isBuiltin(specifier: string): boolean {
  const bare = specifier.replace(/^node:/, '');
  return specifier.startsWith('node:') || builtinModules.includes(bare);
}

describe('storefront source', () => {
  const dir = join(root, 'src', 'storefront');

  it('imports nothing but its own files', () => {
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const specifier of importsOf(source)) {
        expect(specifier.startsWith('./'), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});

describe.skipIf(!existsSync(built))('storefront build', () => {
  it('has no imports, requires or Node built-ins in the ESM and CJS files', () => {
    for (const file of [built, builtCjs]) {
      const source = readFileSync(file, 'utf8');
      expect(importsOf(source).filter(isBuiltin), file).toEqual([]);
      expect(source, file).not.toMatch(/\bprocess\.|\bBuffer\b|__dirname|["']node:/);
    }
    expect(importsOf(readFileSync(built, 'utf8'))).toEqual([]);
  });

  it('exports the storefront API', async () => {
    const mod = (await import(built)) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(
      [
        'DEFAULT_ATTRIBUTION_WINDOW_DAYS',
        'DEFAULT_REFERRAL_PARAM',
        'MAX_ATTRIBUTION_WINDOW_DAYS',
        'SHOPIFY_TRACKING_ATTRIBUTE',
        'STOREFRONT_DEFAULT_BASE_URL',
        'STRIPE_TRACKING_ATTRIBUTE',
        'SirenStorefront',
        'VISIT_STORAGE_KEY',
        'VISIT_TOKEN_PATTERN',
        'attributionWindowDays',
        'canonicalToken',
        'isVisitToken',
        'storefrontUrls',
        'stripeSafeToken',
        'trackingAttributeFor',
      ].sort(),
    );
  });
});
