import assert from 'node:assert/strict'
import { Siren } from '@novatorius/siren'
import { sampleEventData, webhookEvent } from '@novatorius/siren/testing'

const answers = new Siren().apps.requestHandler()
const approved = []
answers.onEvent('conversion.approved', (event) => {
  approved.push(event.data.conversionId)
})

// A signed conversion.approved, with Siren's sample data. Pass your own data as the second argument.
const { status, error } = await answers.simulate(webhookEvent('conversion.approved'))
assert.equal(status, 200)
assert.equal(error, null)
assert.deepEqual(approved, [sampleEventData('conversion.approved').conversionId])
