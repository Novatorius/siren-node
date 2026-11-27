import { startLoginStage, startPasswordStage } from './hook';
import type { LoginStage, PasswordStage } from './hook';
import type { CliIo } from './io';
import type { DeviceCode, DeviceSignInView, PasswordSignInView } from './session-auth';
import { styleFor } from './style';
import type { Spinner } from './style';
import { CLI_VERSION } from './version';

/*
 * What `siren login` shows while the person approves the code in the
 * browser (Alex, 2026-11-24: "the login screen while we login can
 * absolutely show the siren logo"). Where the logo animation may play, the
 * logo floats in two halves on the left, with the wordmark, the code, the
 * link and a spinner on the right. The gripped logo is drawn at once when
 * the approval lands, and the logo clears at once when it fails, so the
 * shell's prompt never waits on a frame. Everywhere else it prints plain lines, with
 * a spinner when standard error is a terminal.
 */

/** The device login's view, plus the moment the session is kept. */
export interface LoginView extends DeviceSignInView {
  /** Shows `line`, such as "Logged in as …", as the login's last line, with a ✓ where styling is on. */
  approved(line: string): Promise<void>;
}

/** How a login ends on screen: the ✓ line, or the logo leaving before the ✗ line. */
export interface LoginEnd {
  /** Shows `line`, such as "Logged in as …", as the login's last line, with a ✓ where styling is on. */
  approved(line: string): Promise<void>;
  /** The login ended with no session. The tool prints why next. Safe to call more than once. */
  failed(): Promise<void>;
}

/**
 * The password login's view (Alex, 2026-11-27: "Animate while also showing
 * the login at the same time"). Where the logo animation may play, the
 * first prompt draws the logo on the left, floating apart, with the email
 * and password prompts on the right, live from the first frame. The gripped
 * logo is drawn at once when Siren accepts the password, and the logo is
 * cleared at once when it refuses.
 * Everywhere else it asks at the terminal's plain prompts.
 */
export function passwordView(io: CliIo, values: Readonly<Record<string, unknown>>, siren: string): PasswordSignInView & LoginEnd {
  const flags = { quiet: values.quiet === true, json: false };
  const out = styleFor(io, 'stdout', {});
  const email = typeof values.email === 'string' && values.email !== '' ? values.email : undefined;
  let stage: PasswordStage | null = null;
  let starting: Promise<PasswordStage | null> | undefined;
  // The screen starts at the first question, so it shows the prompt with its first frame.
  const screen = () => (starting ??= startPasswordStage(io, flags, { version: CLI_VERSION, siren, email }).then((started) => (stage = started)));
  return {
    prompt: async (question) => ((await screen()) ?? io).prompt(question),
    promptSecret: async (question) => ((await screen()) ?? io).promptSecret(question),
    during: (work) => (stage ? stage.during(work) : work),
    async failed() {
      if (stage) await stage.failed();
    },
    async approved(line) {
      if (stage) return stage.approved(line);
      io.stdout(`${out.success(line)}\n`);
    },
  };
}

/** The view for this terminal and these flags. */
export function loginView(io: CliIo, values: Readonly<Record<string, unknown>>): LoginView {
  const flags = { quiet: values.quiet === true, json: false };
  const err = styleFor(io, 'stderr', {});
  const out = styleFor(io, 'stdout', {});
  let stage: LoginStage | null = null;
  let spinner: Spinner | null = null;
  return {
    show(code: DeviceCode, opened: boolean, siren: string) {
      stage = startLoginStage(io, flags, { version: CLI_VERSION, code: code.userCode, link: code.page, opened, siren });
      if (stage !== null) return;
      io.stderr(`${opened ? 'Your browser is open. Approve the code there.' : 'Open the link in your browser, and approve the code there.'}\n`);
      io.stderr(`Code: ${err.bold(code.userCode)}\nLink: ${code.page}\nSiren: ${siren}\n`);
      spinner = err.spinner('Waiting for approval', (text) => io.stderr(text));
    },
    stopped: () => stage?.stopped() ?? false,
    async wait(ms: number) {
      if (stage !== null) return stage.wait(ms);
      return io.sleep(ms);
    },
    async failed() {
      if (stage !== null) return stage.failed();
      spinner?.cancel();
    },
    async approved(line: string) {
      if (stage !== null) return stage.approved(line);
      if (spinner !== null && err.rich) {
        spinner.cancel();
      }
      io.stdout(`${out.success(line)}\n`);
    },
  };
}
