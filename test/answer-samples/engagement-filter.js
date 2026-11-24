import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('engagementFilter', 'staff-check', ({ data }) => {
  // Suppress a visit from someone who works for the partner. Allow everything else.
  if (isStaff(data.collaborator.id, data.opportunity.customerId)) {
    return { outcome: 'suppress', reason: 'The visitor works for the partner.' }
  }
  return { outcome: 'allow' }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
