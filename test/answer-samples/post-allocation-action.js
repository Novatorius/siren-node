import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('postAllocationAction', 'note-the-share', async ({ id, data, test }) => {
  // A test request, such as one siren trigger ask sent: write nothing.
  if (test) return
  // Siren may send it twice, so note it once, keyed by id.
  await noteShare(id, data.allocation)
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
