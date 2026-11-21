import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('programGroupSorter', 'pick-the-program', ({ data }) => {
  // Try the program whose best engagement scores highest first.
  const best = (program) => Math.max(0, ...program.engagements.map((engagement) => engagement.score))
  const programs = [...data.programs].sort((a, b) => best(b) - best(a))
  return { outcome: 'sorted', programIds: programs.map((program) => program.id) }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
