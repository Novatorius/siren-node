import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('collaboratorGroupStructure', 'team-tree', ({ data }) => ({
  outcome: 'structure',
  shape: 'chain',
  // Top first, by the rank your CRM keeps on each member.
  order: [...data.members].sort((a, b) => Number(a.metadata.rank) - Number(b.metadata.rank)).map((member) => member.collaboratorId),
}))

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
