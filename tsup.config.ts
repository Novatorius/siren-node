import { defineConfig } from 'tsup';

// One config with two entries, so a single clean covers both. The storefront
// entry runs in browsers. It must import nothing from the Node entry, and
// test/storefront-build.test.ts checks the built file for Node built-ins.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    storefront: 'src/storefront/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node18',
  platform: 'node',
});
