import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('metricCalculation', 'visit-score', ({ data }) => ({
  outcome: 'scores',
  // Score the collaborator who triggered it, more for a sale.
  results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.metricType === 'awardedSale' ? 10 : 1 }],
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
