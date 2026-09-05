import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAfterChatTurn } from '../src/tanulsag.mjs'
import { freshRepo } from './helpers.mjs'

function setup(forduloRogzites = 'sajat') {
  const { repo } = freshRepo()
  const warnings = []
  const state = { repo, settings: () => ({ forduloRogzites }), log: { info() {}, warn: (m, meta) => warnings.push({ m, meta }), error() {} } }
  return { repo, warnings, hook: createAfterChatTurn(state), state }
}
const turn = (agentId, extra = {}) => ({ session: { id: 's1', agentId }, message: 'kérdés', response: 'válasz', source: 'chat', internal: false, toolEvents: [], ...extra })

test('sajat records only agents that have acted through the extension; mind records every agent; no agent is never recorded', async () => {
  const { repo, hook } = setup()
  repo.rememberAgent('gyarto-1', 'gyarto')
  await hook(turn('idegen'))
  await hook(turn('gyarto-1'))
  await hook(turn(null))
  await hook(turn(''))
  assert.deepEqual(repo.unreviewedFordulok(10).map((f) => f.agent_id), ['gyarto-1'])
  const all = setup('mind')
  await all.hook(turn('idegen')); await all.hook(turn(null))
  assert.equal(all.repo.unreviewedFordulok(10).length, 1)
  const blank = setup('')
  await blank.hook(turn('idegen'))
  assert.equal(blank.repo.unreviewedFordulok(10).length, 0, 'a cleared setting is sajat, not mind')
})

test('the row carries the source, the tool names with their refusal codes, and is cut at 4000', async () => {
  const { repo, hook } = setup('mind')
  await hook(turn('a', { source: 'schedule:abc', message: 'x'.repeat(9000), toolEvents: [
    { name: 'videoDraft', input: '{}', output: JSON.stringify({ error: { code: 'tipus_ismeretlen', message: 'm' } }) },
    { name: 'videoCatalog', input: '{}', output: '{"tipusok":[]}' },
    { name: 'web', input: '{}', output: 'boom', error: true },
    { name: 'broken', input: '{}', output: '{not json', error: true },
  ] }))
  const [row] = repo.unreviewedFordulok(10)
  assert.equal(row.forras, 'schedule:abc'); assert.equal(row.uzenet.length, 4000); assert.equal(row.valasz, 'válasz'); assert.equal(row.session_id, 's1')
  assert.deepEqual(JSON.parse(row.toolok), [{ nev: 'videoDraft', hiba: 'tipus_ismeretlen' }, { nev: 'videoCatalog', hiba: null }, { nev: 'web', hiba: 'hiba' }, { nev: 'broken', hiba: 'hiba' }])
})

test('a turn with the optional fields left out is still recorded', async () => {
  const { repo, hook } = setup('mind')
  await hook({ session: { id: 's2', agentId: 'a' }, message: 'm', response: 'r', source: 'chat', internal: false })
  const [row] = repo.unreviewedFordulok(10)
  assert.equal(row.session_id, 's2'); assert.deepEqual(JSON.parse(row.toolok), [])
})

test('a throwing storage produces a warning, never an exception', async () => {
  const { hook, warnings, state } = setup('mind')
  state.repo = { knownAgentIds: () => new Set(), insertFordulo: () => { throw new Error('disk full') } }
  await hook(turn('a'))
  assert.equal(warnings.length, 1); assert.match(warnings[0].meta.message, /disk full/)
  state.repo = null
  await hook(turn('a'))
  await hook(undefined)
  assert.equal(warnings.length, 1, 'a missing repository or context is silence, not a warning')
})
