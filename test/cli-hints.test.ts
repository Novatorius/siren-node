import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reply } from './http-fakes';
import { BASE } from './record-fakes';
import { AuthAnswers, EMAIL, NOW_S, PASSWORD, harness, membershipAcme, session, user } from './cli-fakes';
import type { HarnessOptions } from './cli-fakes';
import { APP_KEY, AppAnswers, ConfirmationAnswers, appRecord } from './apps-siren-answers';

/*
 * Acceptance tests for the hints the `siren` command prints. Contract:
 * docs/architecture/apps-cli.md, "Sandbox and live".
 *
 * On a live Siren, `apply --live` printed `Run siren apps rotate <key> to
 * make a new key and save it there.`, and that exact command is refused on a
 * live Siren. Every hint that names a command now carries the flags that
 * reach the same Siren: `--live` for a live one, and the `--base-url` or
 * `--sandbox` the person typed. Each case here runs one path that prints a
 * hint, and checks every `siren <command>` it printed.
 */

const KEY = APP_KEY;
const app = appRecord();
const exampleFile = readFileSync(new URL('../examples/apps/acme/siren.app.json', import.meta.url), 'utf8');
const appEnv = { SIREN_APP_URL: 'https://acme.example/siren' };

/**
 * Each sentence of `text` that names a `siren` command, from `siren ` to the
 * end of the sentence. A path or an address holds `siren` followed by `.` or
 * `/`, and the error prefix `siren:` a colon, so neither counts.
 */
function hints(text: string): string[] {
  const found: string[] = [];
  for (let at = text.indexOf('siren '); at !== -1; at = text.indexOf('siren ', at + 1)) {
    if (at > 0 && /[\w/.-]/.test(text[at - 1]!)) continue;
    const rest = text.slice(at);
    const end = rest.search(/\.(\s|$)|\n/);
    found.push(end === -1 ? rest : rest.slice(0, end));
  }
  return found;
}

/** The flags a live Siren at BASE needs, in the order the tool writes them. */
const LIVE = ` --base-url ${BASE} --live`;
const signedInLive = { [BASE]: session({ edition: 'production', baseUrl: BASE }) };

type Case = { name: string; argv: string[]; replies?: Parameters<typeof harness>[0]; options?: HarnessOptions; setup?: (h: ReturnType<typeof harness>) => void; command: string };

/** Paths that print a hint, run against a live Siren at BASE with --live. */
const LIVE_CASES: Case[] = [
  {
    name: 'apply of an app this machine holds no key for',
    argv: ['apps', 'apply'],
    replies: [reply(200, app)],
    options: { env: appEnv },
    setup: (h) => {
      h.signedIn(signedInLive);
      h.write('siren.app.json', exampleFile);
    },
    command: `siren apps rotate ${KEY}${LIVE}`,
  },
  {
    name: 'apply that leaves an archived item',
    argv: ['apps', 'apply'],
    replies: [reply(200, appRecord({ items: app.items.map((item, at) => (at === 0 ? { ...item, status: 'archived' } : item)) }))],
    options: { env: appEnv },
    setup: (h) => {
      h.signedIn(signedInLive);
      h.write('siren.app.json', exampleFile);
      h.write('.env.live', 'SIREN_API_KEY=sk_live_made_up\n');
    },
    command: `name it in siren.app.json again with the same kind and key, and run siren apps apply${LIVE}`,
  },
  { name: 'apply with no app file', argv: ['apps', 'apply'], setup: (h) => h.signedIn(signedInLive), command: `siren apps init${LIVE}` },
  {
    name: "apply where the env file holds another Siren's key",
    argv: ['apps', 'apply'],
    options: { env: appEnv },
    setup: (h) => {
      h.signedIn(signedInLive);
      h.write('siren.app.json', exampleFile);
      h.write('.env.live', 'SIREN_BASE_URL=https://other.example/siren/v1\n');
    },
    command: `siren apps apply${LIVE}`,
  },
  { name: 'list with no apps', argv: ['apps', 'list'], replies: [reply(200, [])], setup: (h) => h.signedIn(signedInLive), command: `siren apps apply${LIVE}` },
  { name: 'rotate with no known env file', argv: ['apps', 'rotate', KEY], setup: (h) => h.signedIn(signedInLive), command: `siren apps rotate ${KEY} --app-file <path to siren.app.json>${LIVE}` },
  {
    name: "rotate where the env file holds another Siren's key",
    argv: ['apps', 'rotate', KEY],
    setup: (h) => {
      mkdirSync(join(h.cwd, 'acme'));
      h.write('acme/.env.live', 'SIREN_BASE_URL=https://other.example/siren/v1\n');
      h.signedIn({ [BASE]: session({ edition: 'production', baseUrl: BASE, envFiles: { [KEY]: join(h.cwd, 'acme', '.env.live') } }) });
    },
    command: `siren apps rotate ${KEY}${LIVE}`,
  },
  { name: 'delete without --yes', argv: ['apps', 'delete', KEY], setup: (h) => h.signedIn(signedInLive), command: `siren apps delete ${KEY} --yes${LIVE}` },
  { name: 'delete of an app records use', argv: ['apps', 'delete', KEY, '--yes'], replies: [AppAnswers.inUse()], setup: (h) => h.signedIn(signedInLive), command: `siren apps off ${KEY}${LIVE}` },
  {
    name: 'delete of an app with open asks',
    argv: ['apps', 'delete', KEY, '--yes'],
    replies: [AppAnswers.inUseWithOpenAsks(2)],
    setup: (h) => h.signedIn(signedInLive),
    command: `siren apps requests --app ${KEY}${LIVE}`,
  },
  { name: 'a command with no session', argv: ['apps', 'list'], command: `siren login${LIVE}` },
  {
    name: 'a refresh Siren refused',
    argv: ['apps', 'list'],
    replies: [AuthAnswers.refreshRefused()],
    setup: (h) => h.signedIn({ [BASE]: session({ edition: 'production', baseUrl: BASE, accessExpiresAt: NOW_S - 10 }) }),
    command: `siren login${LIVE}`,
  },
  {
    name: 'a refresh refused for the plan',
    argv: ['apps', 'list'],
    replies: [ConfirmationAnswers.loginNoPlan('trial_ended')],
    setup: (h) => h.signedIn({ [BASE]: session({ edition: 'production', baseUrl: BASE, accessExpiresAt: NOW_S - 10 }) }),
    command: `siren login${LIVE}`,
  },
  { name: 'a login refused for the plan', argv: ['login', '--email', EMAIL, '--password-stdin'], replies: [ConfirmationAnswers.loginNoPlan('no_entitlement')], options: { stdin: PASSWORD }, command: `siren login${LIVE}` },
  { name: 'a login with the address unconfirmed', argv: ['login', '--email', EMAIL, '--password-stdin'], replies: [ConfirmationAnswers.loginUnconfirmed(EMAIL)], options: { stdin: PASSWORD }, command: `siren login${LIVE}` },
  { name: 'a login to several organizations without --org', argv: ['login', '--email', EMAIL, '--password-stdin'], replies: [AuthAnswers.severalOrgs()], options: { stdin: PASSWORD }, command: `siren login --org <slug>${LIVE}` },
  { name: 'a login with --org for another organization', argv: ['login', '--email', EMAIL, '--password-stdin', '--org', 'nope'], replies: [AuthAnswers.oneOrg()], options: { stdin: PASSWORD }, command: `siren login${LIVE}` },
  { name: 'a sign-up without the terms', argv: ['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin'], options: { stdin: PASSWORD }, command: `siren signup --accept-terms${LIVE}` },
  { name: 'a sign-up turned off', argv: ['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms'], replies: [ConfirmationAnswers.signupOff()], options: { stdin: PASSWORD }, command: `siren login${LIVE}` },
  {
    name: 'a sign-up that waits for the address to be confirmed',
    argv: ['signup', '--org-name', 'Acme', '--email', EMAIL, '--password-stdin', '--accept-terms'],
    replies: [ConfirmationAnswers.registeredUnconfirmed(membershipAcme, user)],
    options: { stdin: PASSWORD },
    command: `siren login${LIVE}`,
  },
  { name: 'one request the organization does not have', argv: ['apps', 'requests', 'apr_0123456789abcdef0123456789abcdef'], replies: [AppAnswers.requestNotFound()], setup: (h) => h.signedIn(signedInLive), command: `siren apps requests${LIVE}` },
  { name: 'list with an app whose requests need attention', argv: ['apps', 'list'], replies: [reply(200, [appRecord({ needsAttention: 2 })])], setup: (h) => h.signedIn(signedInLive), command: `siren apps requests --app ${KEY} --attention${LIVE}` },
  { name: 'show of an app whose requests need attention', argv: ['apps', 'show', KEY], replies: [reply(200, appRecord({ needsAttention: 1 }))], setup: (h) => h.signedIn(signedInLive), command: `siren apps requests --app ${KEY} --attention${LIVE}` },
  {
    name: 'delete of an app that is off and records use',
    argv: ['apps', 'delete', KEY, '--yes'],
    replies: [AppAnswers.inUse(), reply(200, appRecord({ status: 'inactive' }))],
    setup: (h) => h.signedIn(signedInLive),
    command: `siren apps delete ${KEY} --yes${LIVE}`,
  },
  {
    name: 'resend of a request whose app is off',
    argv: ['apps', 'resend', 'apr_0123456789abcdef0123456789abcdef'],
    replies: [AppAnswers.notResendable('needs_attention'), reply(200, { id: 'apr_0123456789abcdef0123456789abcdef', appId: 4, data: {}, answer: null, answeredByUser: null }), reply(200, [appRecord({ status: 'inactive' })])],
    setup: (h) => h.signedIn(signedInLive),
    command: `siren apps on ${KEY}${LIVE}`,
  },
  { name: 'apps init', argv: ['apps', 'init', '--key', KEY], command: `siren apps apply${LIVE}` },
];

describe('apps-cli: every hint names a command the person can run as printed', () => {
  for (const hintCase of LIVE_CASES) {
    it(`on a live Siren: ${hintCase.name}`, async () => {
      const h = harness(hintCase.replies ?? [reply(500, {})], { edition: 'production', ...hintCase.options });
      hintCase.setup?.(h);
      await h.run([...hintCase.argv, '--base-url', BASE, '--live']);
      const printed = h.printed();
      expect(printed).toContain(hintCase.command);
      const found = hints(printed);
      expect(found.length, printed).toBeGreaterThan(0);
      for (const hint of found) expect(hint, printed).toContain(LIVE);
    });
  }

  it('on the sandbox named by --sandbox or by nothing, a hint repeats --sandbox or adds nothing, and never --live', async () => {
    const typed = harness([reply(200, [])], { env: { SIREN_BASE_URL: BASE } });
    typed.signedIn();
    expect(await typed.run(['apps', 'list', '--sandbox']), typed.err()).toBe(0);
    for (const hint of hints(typed.printed())) {
      expect(hint).toContain(' --sandbox');
      expect(hint).not.toContain('--live');
    }

    const plain = harness([reply(200, app)], { env: appEnv });
    plain.signedIn();
    plain.write('siren.app.json', exampleFile);
    expect(await plain.run(['apps', 'apply']), plain.err()).toBe(0);
    expect(plain.out()).toContain(`Run siren apps rotate ${KEY} to make a new key and save it there.`);
  });
});
