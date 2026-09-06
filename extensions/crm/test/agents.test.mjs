import assert from 'node:assert/strict'
import test from 'node:test'

import crm from '../index.mjs'
import { AGENTS, SCHEDULES } from '../src/agents.mjs'

test('egy ugynok van deklaralva, es a manifest ot viszi', () => {
  assert.equal(AGENTS.length, 1)
  assert.equal(AGENTS[0].agentKey, 'crm-ugyfelkezelo')
  assert.deepEqual(crm.managedResources.agents, AGENTS)
})

test('a heartbeat KI van kapcsolva -- az utemezes hajtja', () => {
  assert.equal(AGENTS[0].heartbeatEnabled, false,
    'CLI-provideren a host minden betolteskor false-ra allitana; az utemezes az egyetlen mukodo ut')
})

test('a deklaracio NEM nevez meg mcpServerIds-t', () => {
  assert.equal('mcpServerIds' in AGENTS[0], false,
    'a szerver azonositoja telepitesenkent mas; az operator rendeli hozza')
})

test('a rutin az ugynokre hivatkozik es napi cronon fut', () => {
  assert.equal(SCHEDULES.length, 1)
  const s = SCHEDULES[0]
  assert.equal(s.agentRef.resourceKey, 'crm-ugyfelkezelo')
  assert.equal(s.scheduleType, 'cron')
  assert.match(s.cron, /^\d+ \d+ \* \* \*$/)
  assert.equal(s.timezone, 'Europe/Budapest')
})

test('a rutin promptja a crm_attention-t nevezi meg kiindulasnak', () => {
  assert.match(SCHEDULES[0].taskPrompt, /crm_attention/)
})

test('az ugynok promptja megtiltja a talalgatast', () => {
  assert.match(AGENTS[0].systemPrompt, /crm_attention/)
  assert.match(AGENTS[0].systemPrompt, /ne (talalgass|találgass)/i)
})
