import { describe, expect, it } from 'vitest';

/*
 * Run only by test/no-network-check.test.ts, in a child Vitest process with
 * the repository's no-network setup file. The first test reaches for a host
 * off this machine and catches the guard's throw, as code under test might.
 * The guard's afterEach check must still fail it. The second test sends
 * nothing and must pass, so a guard that fails every test is caught too.
 *
 * The host is under `.invalid`, which never resolves (RFC 6761), so even a
 * guard broken open sends nothing that could reach Siren Cloud.
 */

describe('fixture', () => {
  it('reaches the network and catches the refusal', async () => {
    let refused = false;
    try {
      await fetch('https://escape.example.invalid/siren/v1/ping');
    } catch {
      refused = true;
    }
    expect(typeof refused).toBe('boolean');
  });

  it('sends nothing', () => {
    expect(1 + 1).toBe(2);
  });
});
