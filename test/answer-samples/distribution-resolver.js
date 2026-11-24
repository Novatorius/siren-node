import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('distributionResolver', 'split-by-score', ({ data }) => ({
  outcome: 'allocated',
  units: data.pool.units,
  // Whole currency steps, never more than the pool, split evenly when every score is 0.
  shares: siren.apps.splitPool(data.pool, data.metrics.map((metric) => [metric.metricId, metric.score])),
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
