import { inspect } from 'node:util';

/**
 * Every text an error shows: its message, its JSON form, its data, its code,
 * and what a logger prints, cause chain included. A secret or an envelope
 * value must appear in none of them.
 */
export function shown(error: unknown): string {
  const details = error as Error & { data?: unknown; code?: unknown };
  return `${details.message} ${JSON.stringify(error)} ${JSON.stringify(details.data ?? null)} ${String(details.code)} ${inspect(error, { depth: 10 })}`;
}
