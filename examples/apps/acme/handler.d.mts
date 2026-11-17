// Types for this repository's own type check, read from the SDK's source.
// An app built from this example imports the same names from '@novatorius/siren'.
import type { AppAnswer, AppRequest, Siren } from '../../../src/index';

export interface AcmeAppOptions {
  siren: Siren;
  signingSecret: string;
  log?: (line: string) => void;
  /** Unix seconds, passed to `verifyRequest()` as `now`. */
  now?: () => number;
}

export interface AcmeReply {
  status: number;
  body: string;
  /** Settles once the answer to an ask is posted, or has failed. */
  answered?: Promise<void>;
}

export function createAcmeApp(options: AcmeAppOptions): {
  handle(rawBody: string | Uint8Array, headers: Record<string, string | string[] | undefined>): Promise<AcmeReply>;
};

export function answerFor(request: Pick<AppRequest, 'item' | 'data'>): AppAnswer | null;
