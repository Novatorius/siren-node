import assert from 'node:assert/strict'
import { FeatureKind, Siren } from '@novatorius/siren'
import { appRequest } from '@novatorius/siren/testing'

const siren = new Siren()
const answers = siren.apps.requestHandler()
// FeatureKind.IncentiveResolver shows "Attribution model" on hover, the name Siren's screens use.
answers.on(FeatureKind.IncentiveResolver, 'split-the-reward', ({ data }) => ({
  outcome: 'rewards',
  units: data.pool.units,
  rewards: siren.apps.splitPool(data.pool, data.conversions.map((conversion) => [conversion.conversionId, conversion.score])),
}))

// A signed ask with Siren's sample question. simulate() runs the handler and posts nothing.
const { status, answer, error } = await answers.simulate(appRequest(FeatureKind.IncentiveResolver, 'split-the-reward'))
assert.equal(status, 200)
assert.equal(error, null)
assert.deepEqual(answer?.rewards, { 1042: 900, 1043: 600 })
