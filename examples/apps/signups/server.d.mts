// Types for this repository's own type check, read from the SDK's source.
import type { BrowserTokenHandler, EventResult } from '../../../src/index';

export function recordSignup(collaboratorId: number, list: string): Promise<EventResult>;

export const browserTokens: BrowserTokenHandler;
