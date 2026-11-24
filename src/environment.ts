/**
 * Reads one environment variable on a server, or answers undefined where
 * there is no `process` (a browser or a worker without Node's globals) and
 * for an empty value, so an unset and an empty variable read alike.
 *
 * @internal
 */
export function readEnvironment(name: string): string | undefined {
  const env = typeof process === 'object' && process !== null ? process.env : undefined;
  const value = env?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
