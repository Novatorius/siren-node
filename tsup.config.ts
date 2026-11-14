import { defineConfig } from 'tsup';

// One config with three entries, so a single clean covers them all. The
// storefront entry runs in browsers. It must import nothing from the Node
// entries, and test/storefront-build.test.ts checks the built file for Node
// built-ins. Splitting puts the code the main and connect entries share in
// one chunk, so both use one copy of each class and `instanceof SirenError`
// holds across them. test/connect-build.test.ts checks that.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    storefront: 'src/storefront/index.ts',
    connect: 'src/connect/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'node18',
  platform: 'node',
});
