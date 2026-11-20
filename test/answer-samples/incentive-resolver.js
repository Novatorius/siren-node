import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('incentiveResolver', 'split-the-reward', ({ data }) => ({
  outcome: 'rewards',
  units: data.pool.units,
  rewards: siren.apps.splitPool(data.pool, data.conversions.map((conversion) => [conversion.conversionId, conversion.score])),
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
