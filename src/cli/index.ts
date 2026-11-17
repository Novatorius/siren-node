#!/usr/bin/env node
import { nodeIo } from './io';
import { runCli } from './run';

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
