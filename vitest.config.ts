import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The examples import the package by name, as an app would. Tests run
    // them against the source.
    alias: [
      { find: /^@novatorius\/siren\/storefront$/, replacement: fileURLToPath(new URL('./src/storefront/index.ts', import.meta.url)) },
      { find: /^@novatorius\/siren$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    setupFiles: ['test/setup/no-network.ts'],
  },
});
