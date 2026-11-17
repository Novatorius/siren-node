import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AppAnswers } from './apps-siren-answers';
import { harness } from './cli-fakes';
import { CloudAnswers } from './http-fakes';

/*
 * Every message of Siren's app exchange that this repository quotes, held
 * to Siren's merged code: Novatorius/siren feat/apps at 27169452a. Each row
 * names the file and line the message is on, and the fake that quotes it.
 *
 * The first test runs everywhere and holds each fake to the quoted text.
 * The second reads each file from the Siren checkout named by
 * SIREN_CHECKOUT with `git show`, so it checks the line and the text
 * against Siren itself. It is skipped when SIREN_CHECKOUT is unset, since
 * this repository holds no copy of Siren.
 */

const SIREN_COMMIT = '27169452a';

/** A quoted message: the fake's body, and where Siren says it. `{name}` stands for the app's name and `{requests}` for the count. */
interface Quote {
  fake: () => { status: number; body: string };
  file: string;
  line: number;
  /** The message as the PHP line holds it, with each interpolation as PHP writes it. */
  php: string;
  /** Fills the PHP text the way the fake does. */
  fill?: (php: string) => string;
}

const SERVICE = 'lib/Apps/Service/Services/AppRequestService.php';

const QUOTES: Record<string, Quote> = {
  alreadyAnswered: {
    fake: AppAnswers.alreadyAnswered,
    file: SERVICE,
    line: 642,
    php: 'This request already has a different answer, and the first answer stands.',
  },
  notNeedingAttention: {
    fake: AppAnswers.notNeedingAttention,
    file: SERVICE,
    line: 685,
    php: 'A person may answer only a request that needs attention. The app may still answer this one.',
  },
  notFoundForAdmin: {
    fake: () => AppAnswers.notFound('admin'),
    file: SERVICE,
    line: 698,
    php: 'This organization has no request with this key.',
  },
  notFoundForApp: {
    fake: () => AppAnswers.notFound('app'),
    file: SERVICE,
    line: 698,
    php: 'No request with this key was sent to this app.',
  },
  requestNotFound: {
    fake: AppAnswers.requestNotFound,
    file: 'lib/Apps/Service/Exceptions/AppRequestRefusedException.php',
    line: 34,
    php: 'App request not found.',
  },
  notResendable: {
    fake: () => AppAnswers.notResendable(),
    file: 'lib/Apps/Service/Rest/ResendAppRequest.php',
    line: 83,
    php: 'This request cannot be sent again: it is applied, or its app is off.',
  },
  inUse: {
    fake: () => AppAnswers.inUse(),
    file: 'lib/Apps/Service/Exceptions/AppInUseException.php',
    line: 49,
    php: 'Records still select items of \\"{$appName}\\", so it can\'t be deleted. Turn it off instead. Siren then stops calling it and keeps what it already did.',
    fill: (php) => php.replace('\\"{$appName}\\"', '"Acme"'),
  },
  inUseWithOpenAsks: {
    fake: () => AppAnswers.inUseWithOpenAsks(2),
    file: 'lib/Apps/Service/Exceptions/AppInUseException.php',
    line: 46,
    php: '\\"{$appName}\\" still has {$requests} waiting on its answer, so it can\'t be deleted. It can be deleted once each answer is applied.',
    fill: (php) => php.replace('\\"{$appName}\\"', '"Acme"').replace('{$requests}', '2 requests'),
  },
  unknownKey: {
    fake: () => ({ status: 401, body: JSON.stringify(CloudAnswers.eventTokenRefused) }),
    file: 'saas/Auth/ApiKeyAuthMiddleware.php',
    line: 228,
    php: 'Invalid API key. Copy the key from Siren again, or make a new one under API keys.',
  },
};

function messageOf(reply: { body: string }): string {
  return (JSON.parse(reply.body) as { error: { message: string } }).error.message;
}

describe('apps-sdk-followups-1: the messages of Siren\'s exchange this repository quotes', () => {
  for (const [name, quote] of Object.entries(QUOTES)) {
    it(`${name} quotes ${quote.file} line ${quote.line} word for word`, () => {
      const text = (quote.fill ?? ((php: string) => php))(quote.php.replace(/\\'/g, "'"));
      expect(messageOf(quote.fake())).toBe(text);
    });
  }

  it.skipIf(process.env.SIREN_CHECKOUT === undefined)(`finds each quoted message on its line in Siren at ${SIREN_COMMIT}`, () => {
    for (const [name, quote] of Object.entries(QUOTES)) {
      const source = execFileSync('git', ['-C', process.env.SIREN_CHECKOUT ?? '', 'show', `${SIREN_COMMIT}:${quote.file}`], { encoding: 'utf8' });
      const line = source.split('\n')[quote.line - 1] ?? '';
      expect(line, name).toContain(quote.php);
    }
  });

  it('prints the line Siren gives an admin who answers a request the organization does not have', async () => {
    const h = harness([AppAnswers.notFound('admin')]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', 'apr_0123456789abcdef0123456789abcdef', '--body', '{"outcome":"paid"}'])).toBe(1);
    expect(h.err()).toBe('siren: This organization has no request with this key.\n');
  });
});
