#!/usr/bin/env node
import { nodeIo } from './io';
import { quietOnClosedPipe } from './pipe';
import { runCli } from './run';

quietOnClosedPipe(process.stdout, (code) => process.exit(code));
quietOnClosedPipe(process.stderr, (code) => process.exit(code));

// The `siren` command, built to dist/cli.js and named in package.json `bin`.
runCli(process.argv.slice(2), nodeIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`siren: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
