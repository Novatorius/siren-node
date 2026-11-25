import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * siren.recipe.schema.json is a byte copy of Siren's
 * lib/Recipes/Core/recipe.schema.json, made by scripts/copy-recipe-schema.mjs.
 * The package ships it so an editor completes a recipe. A hand edit would let
 * it drift from the schema Siren validates against, so it must match the
 * recorded hash.
 */
const root = join(__dirname, '..');

describe('the shipped recipe schema', () => {
  it("matches the SHA-256 the copy script recorded from Siren's file", () => {
    const source = JSON.parse(readFileSync(join(root, 'siren.recipe.schema.source.json'), 'utf8')) as { from: string; sirenCommit: string; sha256: string };
    expect(source.from).toBe('lib/Recipes/Core/recipe.schema.json');
    expect(source.sirenCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(createHash('sha256').update(readFileSync(join(root, 'siren.recipe.schema.json'))).digest('hex')).toBe(source.sha256);
  });

  it('ships in the package beside the app file schema', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('siren.recipe.schema.json');
  });
});
