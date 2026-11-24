import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('metricCalculation', 'visit-score', ({ data }) => ({
  outcome: 'scores',
  // Score the collaborator who triggered it, more for a sale.
  results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.metricType === 'awardedSale' ? 10 : 1 }],
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
