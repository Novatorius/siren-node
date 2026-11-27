import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('postConversionAction', 'tell-the-crm', async ({ id, data, test }) => {
  // A test request, such as one siren trigger ask sent: write nothing.
  if (test) return
  // Siren may send it twice, so add it once, keyed by id.
  await addToCrm(id, data.conversion, data.reward)
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
