import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('metricFilter', 'refund-check', ({ data }) => {
  // Suppress a sale the CRM knows was refunded. Allow everything else.
  if (data.sale && isRefunded(data.sale.transactionId)) {
    return { outcome: 'suppress', reason: 'The order was refunded within 30 days.' }
  }
  return { outcome: 'allow' }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
