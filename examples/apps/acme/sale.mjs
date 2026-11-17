// Sends a sale the way a store would, with the app's own key, so the walk can
// make a conversion with nothing but this folder. The app file declares the
// two scopes it needs: `event:site-visited` and `event:sale`
// (saas/Auth/ApiKeyScopeMiddleware.php reads `event:{slug}` on /event/{slug}).
//
// It records a visit for the collaborator, which answers the opportunity id
// in X-Siren-OID, then a real sale of `total` in `currency` on that
// opportunity, with `source` `acme-example` and the given `externalId`, and
// no `test` flag, as a store sends one.

/**
 * @param {import('@novatorius/siren').Siren} siren
 * @param {{ collaborator: number | `tracking:${string}`, total: number, currency?: string, externalId: string }} sale
 * @returns {Promise<{ opportunityId?: number, status?: string }>}
 */
export async function sendSale(siren, sale) {
  const visit = await siren.events.siteVisited({ collaboratorId: sale.collaborator });
  if (visit.opportunityId === undefined) {
    throw new Error(`Siren opened no opportunity for ${sale.collaborator} (${visit.status ?? 'no status'}). Check the collaborator id or tracking code.`);
  }
  const result = await siren.events.sale({
    trackingId: visit.opportunityId,
    total: sale.total,
    ...(sale.currency === undefined ? {} : { currency: sale.currency }),
    externalId: sale.externalId,
    source: 'acme-example',
  });
  return { opportunityId: result.opportunityId ?? visit.opportunityId, status: result.status };
}
