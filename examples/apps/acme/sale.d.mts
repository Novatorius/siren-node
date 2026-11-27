// Types for this repository's own type check, read from the SDK's source.
import type { Siren } from '../../../src/index';

export interface SaleResult {
  opportunityId?: number;
  status?: string;
  conversions: number;
  reason?: string;
  message?: string;
}

export function sendSale(
  siren: Siren,
  sale: { collaborator: number | `tracking:${string}`; total: number; currency?: string; externalId: string },
): Promise<SaleResult>;

export function saleLine(total: string, path: string, result: SaleResult): string;
