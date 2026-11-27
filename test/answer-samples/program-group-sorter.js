import express from 'express'
import { Siren } from '@novatorius/siren'

// Reads SIREN_API_KEY and SIREN_SIGNING_SECRET from the environment.
const siren = new Siren()
const answers = siren.apps.requestHandler()

answers.on('programGroupSorter', 'pick-the-program', ({ data }) => {
  // Try the program whose best engagement scores highest first.
  const scored = data.programs.map((program) => ({ id: program.id, best: Math.max(0, ...program.engagements.map((engagement) => engagement.score)) }))
  scored.sort((a, b) => b.best - a.best)
  return { outcome: 'sorted', programIds: scored.map((program) => program.id) }
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
