import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('incentiveResolver', 'split-the-reward', ({ data }) => ({
  outcome: 'rewards',
  units: data.pool.units,
  rewards: siren.apps.splitPool(data.pool, data.conversions.map((conversion) => [conversion.conversionId, conversion.score])),
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
