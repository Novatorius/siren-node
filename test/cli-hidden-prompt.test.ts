import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCli, configFolder, startFakeCloud } from './cli-loopback';
import type { FakeCloud } from './cli-loopback';

/*
 * Acceptance test for the hidden password prompt of the built `siren`
 * command. Contract: docs/architecture/apps-cli.md, "Signing in and the
 * stored files".
 *
 * The checkpoint against a real Cloud saw the password come back on the
 * screen in 3 of 6 runs when it was typed the instant `Password: ` appeared.
 * This drives `siren login` in a pseudo-terminal through Python's `pty`
 * module, against a fake Cloud on 127.0.0.1, with a made-up password typed
 * with no pause, many times in a row. One character back on the terminal
 * fails it. The command is built from src/cli first. The test needs Python 3
 * and a POSIX terminal, and skips without them.
 */

const driver = join(__dirname, 'pty', 'type-at-prompt.py');
const python = process.platform === 'win32' ? undefined : ['python3', 'python'].find((name) => spawnSync(name, ['--version']).status === 0);
const RUNS = 30;
const CTRL_C_RUNS = 6;
const EMAIL = 'pty-person@example.invalid';
const PASSWORD = 'Zq7-made-up-Xv9-never-real';

interface Typed {
  afterPrompt: string;
  passwordShown: boolean;
  exit: number | null;
  echoAfter: boolean;
}

function typeAtPrompt(cli: string, cloud: FakeCloud, mode: 'enter' | 'ctrl-c'): Promise<Typed> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SIREN_CONFIG_DIR: configFolder() };
    delete env.SIREN_BASE_URL;
    execFile(python!, [driver, process.execPath, cli, cloud.baseUrl, EMAIL, PASSWORD, mode], { env, timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) return reject(new Error(`${error.message}\n${stderr}`));
      resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Typed);
    });
  });
}

describe.skipIf(python === undefined)('apps-cli: the hidden password prompt in a terminal', () => {
  let cloud: FakeCloud;
  let cli: string;
  beforeAll(async () => {
    cli = buildCli();
    cloud = await startFakeCloud('sandbox');
  });
  afterAll(async () => {
    await cloud.close();
  });

  it(`shows not one character of a password typed the instant the prompt appears, in ${RUNS} runs`, async () => {
    const runs: Typed[] = [];
    for (let run = 0; run < RUNS; run += 1) runs.push(await typeAtPrompt(cli, cloud, 'enter'));
    const echoed = runs.filter((typed) => typed.afterPrompt !== '' || typed.passwordShown);
    expect(echoed.length, `${echoed.length} of ${RUNS} runs echoed: ${JSON.stringify(echoed[0])}`).toBe(0);
    for (const typed of runs) {
      expect(typed.exit).toBe(0);
      expect(typed.echoAfter).toBe(true);
    }
  }, 180_000);

  it(`shows nothing typed before Ctrl-C, stops with exit code 1, and gives the terminal its echo back, in ${CTRL_C_RUNS} runs`, async () => {
    const runs: Typed[] = [];
    for (let run = 0; run < CTRL_C_RUNS; run += 1) runs.push(await typeAtPrompt(cli, cloud, 'ctrl-c'));
    const echoed = runs.filter((typed) => typed.afterPrompt !== '' || typed.passwordShown);
    expect(echoed.length, `${echoed.length} of ${CTRL_C_RUNS} runs echoed: ${JSON.stringify(echoed[0])}`).toBe(0);
    for (const typed of runs) {
      expect(typed.exit).toBe(1);
      expect(typed.echoAfter).toBe(true);
    }
  }, 60_000);
});
