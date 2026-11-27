import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('engagementCalculation', 'visit-weight', ({ data }) => ({
  outcome: 'engagements',
  // Credit the collaborator who triggered it, more when Siren knows the customer.
  results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.opportunity.customerId ? 10 : 1 }],
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
