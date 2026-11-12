/*
 * Slice 1 acceptance tests that run at compile time.
 *
 * `npm run typecheck` compiles this file (tsconfig includes `test`). Vitest
 * never runs it, because the name does not end in `.test.ts`. Each
 * `@ts-expect-error` line must stay an error: if the SDK's types start to
 * accept it, the directive itself becomes the error and the typecheck fails.
 * The lines without a directive must keep compiling.
 *
 * The functions are never called. They exist so the calls typecheck.
 */
import type { Siren } from '../../src/index';
import type {
  ApiKeyScopeGroups,
  RefundParams,
  SaleParams,
  SiteVisitedParams,
  WebhookCatalogEntry,
} from '../../src/index';

export function refundContract(siren: Siren): void {
  // The done condition: a refund without refundId fails to typecheck.
  // @ts-expect-error refundId is required on every refund
  void siren.events.refund({ source: 'woocommerce', externalId: 1001 });

  // @ts-expect-error refundId is required on every refund
  const missing: RefundParams = { source: 'woocommerce', externalId: 1001 };
  void missing;

  void siren.events.refund({ source: 'woocommerce', externalId: 1001, refundId: 2201 });
  void siren.events.refund({
    source: 'woocommerce',
    externalId: 'order-88',
    refundId: 'r-1',
    amount: 5,
    currency: 'EUR',
    lines: [{ lineId: 'line-501', quantity: 1, amount: 5 }, { sku: 'HAT-RED' }],
  });
  void siren.events.refund({ source: 'medusa', externalId: 'o', refundId: 'cancel:o', whole: true, kind: 'voided' });

  // @ts-expect-error kind is one of refund, cancelled or voided
  void siren.events.refund({ source: 'medusa', externalId: 'o', refundId: 'x', kind: 'returned' });
}

export function saleContract(siren: Siren): void {
  void siren.events.sale({ source: 's', externalId: 'e', total: 1, trackingId: 2 });
  void siren.events.sale({
    source: 's',
    externalId: 'e',
    total: 1,
    trackingId: 2,
    items: [{ amount: 1, lineId: 'line-1' }, { amount: 1, lineId: 7 }],
  });

  // A test sale needs no other field, and trackingId is optional on it.
  void siren.events.sale({ test: true });
  void siren.events.sale({ test: true, source: 's', externalId: 'e', total: 1 });

  // @ts-expect-error a real sale needs trackingId
  void siren.events.sale({ source: 's', externalId: 'e', total: 1 });

  // @ts-expect-error test: false is a real sale and needs trackingId
  void siren.events.sale({ source: 's', externalId: 'e', total: 1, test: false });

  // @ts-expect-error a real sale needs source, externalId and total
  const partial: SaleParams = { trackingId: 2 };
  void partial;
}

export function siteVisitContract(siren: Siren): void {
  void siren.events.siteVisited({ collaboratorId: 42 });
  void siren.events.siteVisited({ collaboratorId: 'tracking:summer-sale' });

  // @ts-expect-error a text collaboratorId must be a tracking:{code} reference
  const bare: SiteVisitedParams = { collaboratorId: 'summer-sale' };
  void bare;
}

export async function catalogContract(siren: Siren): Promise<void> {
  const events: WebhookCatalogEntry[] = await siren.webhooks.subscriptions.events();
  const first: string | undefined = events[0]?.event;
  void first;

  const scopes: ApiKeyScopeGroups = await siren.apiKeys.scopes();
  const ledger: string[] | undefined = scopes.ledger?.map((entry) => entry.scope);
  void ledger;
}
