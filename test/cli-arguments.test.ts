import { describe, expect, it } from 'vitest';
import { reply } from './http-fakes';
import { harness, session } from './cli-fakes';
import { SANDBOX_BASE_URL } from '../src/http';
import { APP_KEY, APP_REQUEST_ID, appRecord } from './apps-siren-answers';

/*
 * Acceptance tests for the arguments the `siren` command refuses before it
 * sends anything. Contract: docs/architecture/apps-cli.md, "The commands".
 *
 * `siren apps answer apr_xyz` sent nothing and exited 1, though exit 2 is
 * for a command line the tool cannot read, and its message named
 * `apps.requests.answer()`, which the person never typed. Every command now
 * checks its request id, app key and answer itself, answers 2, and says what
 * is wrong in the tool's words, with the usage line.
 */

const big = JSON.stringify({ outcome: 'paid', note: 'x'.repeat(17_000) });

const CASES: Array<{ argv: string[]; says: string }> = [
  { argv: ['apps', 'answer', 'apr_xyz', '--body', '{"outcome":"paid"}'], says: 'A request id is apr_ and 32 lowercase hex characters, and "apr_xyz" is not one.' },
  { argv: ['apps', 'answer', APP_REQUEST_ID, '--body', '{"reference":"x"}'], says: 'The answer needs a text outcome, such as {"outcome":"paid"}.' },
  { argv: ['apps', 'answer', APP_REQUEST_ID, '--body', '{"outcome":""}'], says: 'The answer needs a text outcome' },
  { argv: ['apps', 'answer', APP_REQUEST_ID, '--body', big], says: 'The answer is longer than 16384 bytes as JSON, which Siren refuses.' },
  { argv: ['apps', 'resend', 'apr_xyz'], says: 'A request id is apr_ and 32 lowercase hex characters, and "apr_xyz" is not one.' },
  { argv: ['apps', 'requests', 'apr_xyz'], says: 'A request id is apr_ and 32 lowercase hex characters, and "apr_xyz" is not one.' },
  { argv: ['apps', 'show', 'Acme_Payouts'], says: 'An app key is lowercase letters and digits joined by single dashes, at most 64 characters and never requests, events, scopes or kinds, and "Acme_Payouts" is not one.' },
  { argv: ['apps', 'on', 'requests'], says: '"requests" is not one.' },
  { argv: ['apps', 'off', 'acme--payouts'], says: '"acme--payouts" is not one.' },
  { argv: ['apps', 'delete', 'a'.repeat(65), '--yes'], says: 'is not one.' },
  { argv: ['apps', 'requests', '--app', 'Acme'], says: '"Acme" is not one.' },
];

describe('apps-cli: arguments the tool cannot read', () => {
  for (const { argv, says } of CASES) {
    it(`answers 2 in its own words, and sends nothing: siren ${argv.join(' ').slice(0, 60)}`, async () => {
      const h = harness([reply(200, appRecord())]);
      h.signedIn({ [SANDBOX_BASE_URL]: session({ envFiles: { [APP_KEY]: '/nowhere/.env.sandbox' } }) });
      expect(await h.run(argv), h.err()).toBe(2);
      expect(h.sent()).toEqual([]);
      expect(h.err()).toContain(says);
      expect(h.err()).toContain('Usage: siren apps ');
      expect(h.err()).not.toMatch(/\w\(\)/);
    });
  }
});
