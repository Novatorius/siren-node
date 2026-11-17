// Sends a sale the way a store would, with the app's own key, so the walk can
// make a conversion with nothing but this folder. The app file declares the
// two scopes it needs: `event:site-visited` and `event:sale`
// (saas/Auth/ApiKeyScopeMiddleware.php reads `event:{slug}` on /event/{slug}).
//
// It records a visit for the collaborator, which answers the opportunity id,
// then a real sale of `total` in `currency` on that opportunity, with
// `source` `acme-example` and the given `externalId`, and no `test` flag, as
// a store sends one.
//
// Siren answers a sale with `created` and the conversions it made, or with
// `recorded`, no conversions, a `reason` such as `no_program` and a message
// that says why (SaleIngestionService on feat/apps at 1557b0030).

/**
 * @param {import('@novatorius/siren').Siren} siren
 * @param {{ collaborator: number | `tracking:${string}`, total: number, currency?: string, externalId: string }} sale
 * @returns {Promise<{ opportunityId?: number, status?: string, conversions: number, reason?: string, message?: string }>}
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
  const body = result.body !== null && typeof result.body === 'object' ? result.body : {};
  const answer = {
    opportunityId: result.opportunityId ?? visit.opportunityId,
    status: result.status,
    conversions: Array.isArray(body.conversions) ? body.conversions.length : 0,
  };
  if (typeof body.reason === 'string') answer.reason = body.reason;
  if (typeof body.message === 'string') answer.message = body.message;
  return answer;
}

/**
 * The line send-sale.mjs prints: how many conversions the sale made, or that
 * it made none, with Siren's reason and message.
 *
 * @param {string} total
 * @param {string} path
 * @param {{ opportunityId?: number, status?: string, conversions: number, reason?: string, message?: string }} result
 */
export function saleLine(total, path, result) {
  const sent = `Sent a sale of ${total} USD through ${path}`;
  const opportunity = `opportunity ${result.opportunityId ?? 'none'}`;
  if (result.conversions > 0) {
    return `${sent}: Siren made ${result.conversions} conversion${result.conversions === 1 ? '' : 's'} on ${opportunity}.`;
  }
  const why = result.reason === undefined ? '' : ` (${result.reason})`;
  const message = result.message === undefined ? '' : ` ${result.message}`;
  return `${sent}: Siren ${result.status ?? 'answered'} it on ${opportunity} and made no conversion${why}.${message}`;
}
