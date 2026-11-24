import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('engagementCalculation', 'visit-weight', ({ data }) => ({
  outcome: 'engagements',
  // Credit the collaborator who triggered it, more when Siren knows the customer.
  results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.opportunity.customerId ? 10 : 1 }],
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
