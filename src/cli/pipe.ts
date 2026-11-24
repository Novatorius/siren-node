/** What {@link quietOnClosedPipe} needs of a stream: its `error` event. */
interface ErrorSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Ends the command with exit code 0 when the reader of `stream` has gone,
 * as when `siren apps list | head` closes the pipe after ten lines. Node
 * reports that as an EPIPE `error` event on standard output, which would
 * otherwise crash the process with a stack trace. Any other stream error is
 * thrown, as before. gh and git also end quietly here.
 */
export function quietOnClosedPipe(stream: ErrorSource, exit: (code: number) => void): void {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') {
      exit(0);
      return;
    }
    throw error;
  });
}
