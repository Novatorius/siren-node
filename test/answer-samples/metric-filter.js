import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('metricFilter', 'refund-check', ({ data }) => {
  // Suppress a sale the CRM knows was refunded. Allow everything else.
  if (data.sale && isRefunded(data.sale.transactionId)) {
    return { outcome: 'suppress', reason: 'The order was refunded within 30 days.' }
  }
  return { outcome: 'allow' }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
