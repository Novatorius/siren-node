import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { guardInPlace, takeRefusedHosts } from './setup/no-network';

/*
 * The guard test/setup/no-network.ts puts in place of the global fetch for
 * every test file.
 *
 * Every host these tests send to off this machine is under `.invalid`, a
 * name reserved never to resolve (RFC 6761), so a mutation that weakens the
 * guard sends nothing that could reach Siren Cloud. Run such a mutation
 * inside a network namespace with no route out (`unshare -rn`) anyway.
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
    expect(() => fetch('https://api.example.invalid/siren/v1/ping')).toThrow(/No test may reach the network/);

    expect(takeRefusedHosts()).toEqual(['api.example.invalid']);
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

// Read in a later block's beforeAll, after the tests above and their
// afterEach have run, to prove the guard holds between tests too.
let betweenTests = false;

describe('no-network guard between tests', () => {
  beforeAll(() => {
    betweenTests = guardInPlace();
  });

  it('is in place in a beforeAll that runs after earlier tests', () => {
    expect(betweenTests).toBe(true);
  });
});
