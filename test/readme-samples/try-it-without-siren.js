import assert from 'node:assert/strict'
import { Siren } from '@novatorius/siren'
import { appRequest } from '@novatorius/siren/testing'

const siren = new Siren()
const answers = siren.apps.requestHandler()
answers.on('distributionResolver', 'split-by-score', ({ data }) => ({
  outcome: 'allocated',
  units: data.pool.units,
  shares: siren.apps.splitPool(data.pool, data.metrics.map((metric) => [metric.metricId, metric.score])),
}))

// A signed ask with Siren's sample question. simulate() runs the handler and posts nothing.
const { status, answer } = await answers.simulate(appRequest('distributionResolver', 'split-by-score'))
assert.equal(status, 200)
assert.deepEqual(answer.shares, { 41: 6000, 43: 4000 })
