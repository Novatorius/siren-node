import { startLoginStage } from './hook';
import type { LoginStage } from './hook';
import type { CliIo } from './io';
import type { DeviceCode, DeviceSignInView } from './session-auth';
import { styleFor } from './style';
import type { Spinner } from './style';
import { CLI_VERSION } from './version';

/*
 * What `siren login` shows while the person approves the code in the
 * browser (Alex, 2026-11-24: "the login screen while we login can
 * absolutely show the siren logo"). Where the logo animation may play, the
 * logo floats in two halves on the left, with the wordmark, the code, the
 * link and a spinner on the right. The halves grip when the approval lands
 * and drift away when it fails. Everywhere else it prints plain lines, with
 * a spinner when standard error is a terminal.
 */

/** The device login's view, plus the moment the session is kept. */
export interface LoginView extends DeviceSignInView {
  /** Shows `line`, such as "Logged in as …", as the login's last line, with a ✓ where styling is on. */
  approved(line: string): Promise<void>;
}

/** The view for this terminal and these flags. */
export function loginView(io: CliIo, values: Readonly<Record<string, unknown>>): LoginView {
  const flags = { quiet: values.quiet === true, json: false };
  const err = styleFor(io, 'stderr', {});
  const out = styleFor(io, 'stdout', {});
  let stage: LoginStage | null = null;
  let spinner: Spinner | null = null;
  return {
    show(code: DeviceCode, opened: boolean) {
      stage = startLoginStage(io, flags, { version: CLI_VERSION, code: code.userCode, link: code.page, opened });
      if (stage !== null) return;
      io.stderr(`${opened ? 'Your browser is open. Approve the code there.' : 'Open the link in your browser, and approve the code there.'}\n`);
      io.stderr(`Code: ${err.bold(code.userCode)}\nLink: ${code.page}\n`);
      spinner = err.spinner('Waiting for approval', (text) => io.stderr(text));
    },
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
