import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('transactionFilter', 'plan-lines', ({ data }) => ({
  outcome: 'filtered',
  include: data.lines.filter((line) => line.type === 'lineItem').map((line) => line.id),
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
