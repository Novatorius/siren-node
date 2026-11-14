import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/*
 * The config test/no-network-check.test.ts runs in a child Vitest process:
 * the repository's own no-network setup file, and only the fixture below.
 * The main run never picks the fixture up, because its name does not end
 * in `.test.ts`.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: ['test/fixtures/no-network/reaches-the-network.fixture.ts'],
    setupFiles: ['test/setup/no-network.ts'],
  },
});
