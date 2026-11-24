import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('collaboratorGroupStructure', 'team-tree', ({ data }) => ({
  outcome: 'structure',
  shape: 'chain',
  // Top first, by the rank your CRM keeps on each member.
  order: [...data.members].sort((a, b) => Number(a.metadata.rank) - Number(b.metadata.rank)).map((member) => member.collaboratorId),
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
