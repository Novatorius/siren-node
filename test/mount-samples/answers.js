import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
export const answers = siren.apps.requestHandler()

answers.on('postConversionAction', 'tell-the-crm', async ({ id, data }) => {
  // Siren may send it twice, so add it once, keyed by id.
  await addToCrm(id, data.conversion, data.reward)
})
answers.on('distributionResolver', 'split-by-score', ({ data }) => ({
  outcome: 'allocated',
  units: data.pool.units,
  shares: siren.apps.splitPool(data.pool, data.metrics.map((metric) => [metric.metricId, metric.score])),
}))
