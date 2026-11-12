import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { takeRefusedHosts } from './setup/no-network';

/*
 * The guard test/setup/no-network.ts puts in place of the global fetch for
 * every test file.
 */
// Sent at load, before any test runs, to prove the guard is in place there too.
const atLoad = (() => {
  try {
    void fetch('https://example.invalid/at-load');
    return 'sent';
  } catch {
    return 'refused';
  }
})();

describe('no-network guard', () => {
  it('is in place when the test file loads, before any test runs', () => {
    expect(atLoad).toBe('refused');
    expect(takeRefusedHosts()).toEqual(['example.invalid']);
  });

  it('refuses a host off this machine, and records it so the test fails even when the caller catches the throw', async () => {
    expect(() => fetch('https://api.sirenaffiliates.com/siren/v1/ping')).toThrow(/No test may reach the network/);

    expect(takeRefusedHosts()).toEqual(['api.sirenaffiliates.com']);
  });

  it('lets a request to 127.0.0.1 through to the real fetch', async () => {
    const server = createServer((_req, res) => res.end('here'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe('here');
    } finally {
      // Node 18 keeps the fetch's idle connection open, so close it first.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(takeRefusedHosts()).toEqual([]);
  });
});
