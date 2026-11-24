import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('payoutMethod', 'acme-ledger', async ({ data }) => {
  // Pay each payout once, keyed by its id, and answer with your reference.
  const paid = await payOnce(data.payout.id, data.collaborator, data.amount)
  return paid.ok ? { outcome: 'paid', reference: paid.id } : { outcome: 'failed', reason: paid.error }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
