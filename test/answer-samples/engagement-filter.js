import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('engagementFilter', 'staff-check', ({ data }) => {
  // Suppress a visit from someone who works for the partner. Allow everything else.
  if (isStaff(data.collaborator.id, data.opportunity.customerId)) {
    return { outcome: 'suppress', reason: 'The visitor works for the partner.' }
  }
  return { outcome: 'allow' }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
