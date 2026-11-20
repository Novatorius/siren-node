import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('postConversionAction', 'tell-the-crm', async ({ id, data }) => {
  // Siren may send it twice, so add it once, keyed by id.
  await addToCrm(id, data.conversion, data.reward)
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
