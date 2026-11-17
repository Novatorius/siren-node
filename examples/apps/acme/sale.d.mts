// Types for this repository's own type check, read from the SDK's source.
import type { Siren } from '../../../src/index';

export function sendSale(
  siren: Siren,
  sale: { collaborator: number | `tracking:${string}`; total: number; currency?: string; externalId: string },
): Promise<{ opportunityId?: number; status?: string }>;
