import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('incentiveType', 'pay-on-closed-deals', ({ data }) => {
  // A tenth of the sale, shared by every engagement. A lead earns nothing here.
  const sale = data.transaction
  if (!sale || sale.units !== data.program.units) return { outcome: 'none' }
  return { outcome: 'award', units: sale.units, pool: Math.floor(sale.total / 10), engagementIds: data.engagements.map((e) => e.engagementId) }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
