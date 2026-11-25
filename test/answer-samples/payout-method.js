import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('payoutMethod', 'acme-ledger', async ({ data, test }) => {
  // A test request, such as one siren trigger ask sent: answer, and pay nothing.
  if (test) return { outcome: 'failed', reason: 'A test request, so nothing was paid.' }
  // Pay each payout once, keyed by its id, and answer with your reference.
  const paid = await payOnce(data.payout.id, data.collaborator, data.amount)
  return paid.ok ? { outcome: 'paid', reference: paid.id } : { outcome: 'failed', reason: paid.error }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
